// ── Emails GoPayLocal sends on its own ──────────────────────────────────────
// The emails in ../emails/templates.ts, wired to what triggers them:
//   welcome           a new account (auth.ts, databaseHooks.user.create.after)
//   usage 80% / 100%  the */10 usage job, once per workspace, threshold and UTC month
//   payment failed    Dodo's payment.failed and subscription.on_hold, once per paid period
//   Pro ended         the */10 job, once when a workspace's Pro has actually ended
//   key refused       the */10 job, once while a platform refuses the stored key
//   invitation        auth.ts, sendInvitationEmail
// Workspace emails go to the workspace's owners. Sending is best-effort: a
// failure is logged and never breaks the request or job that triggered it.
// "Once" is a row in emails_sent, claimed before sending (see the schema).

import { and, eq, gt, inArray, like, ne, notInArray, or, sql } from "drizzle-orm";
import type { Limit } from "@gopaylocal/shared";
import { normalizePlan } from "@gopaylocal/shared/constants";
import { minorToMajor } from "@gopaylocal/shared/currency";
import type { Bindings } from "../bindings";
import type { Database } from "../db";
import { emailsSent, integrations, invitations, members, organizations, subscriptions, users } from "../db/schema";
import type { Email, EmailLinks } from "../emails/layout";
import {
  integrationKeyRefusedEmail,
  paymentFailedEmail,
  proEndedEmail,
  usageLimitEmail,
  usageWarningEmail,
  welcomeEmail,
} from "../emails/templates";
import { appUrlFor, sendEmail, senderAddressFor, subjectLine, supportAddressFor } from "../lib/email";
import { effectivePlan, isSelfHosted, subscriptionCountsHere, type DeploymentEnv } from "../lib/entitlements";
import { errorSummary } from "../lib/log";
import { workspaceNameForEmail } from "../lib/workspace-name";
import { integrationHealthOf } from "./integration-health.service";

// ── Sending ─────────────────────────────────────────────────────────────────

export interface Mailer {
  links: EmailLinks;
  send(to: string, email: Email): Promise<void>;
}

/**
 * The deployment's mailer, or null when it can't send: no ACS connection
 * string, or (self-hosted) no EMAIL_FROM or APP_BASE_URL. Replies go to the
 * support address (lib/email.ts supportAddressFor).
 */
export function mailerFor(
  env: Pick<Bindings, "ACS_CONNECTION_STRING" | "EMAIL_FROM" | "SUPPORT_EMAIL" | "APP_BASE_URL" | "SELF_HOSTED">,
): Mailer | null {
  const connectionString = env.ACS_CONNECTION_STRING;
  const senderAddress = senderAddressFor(env);
  const app = appUrlFor(env);
  if (!connectionString || !senderAddress || !app) return null;
  const support = supportAddressFor(env);
  return {
    links: { app, support },
    send: (to, email) =>
      sendEmail(connectionString, {
        to,
        subject: subjectLine(email.subject),
        html: email.html,
        text: email.text,
        replyTo: support,
        senderAddress,
      }),
  };
}

/** Why mailerFor(env) is null, for a log line. */
export function emailSetupProblem(
  env: Pick<Bindings, "ACS_CONNECTION_STRING" | "EMAIL_FROM" | "APP_BASE_URL" | "SELF_HOSTED">,
): string {
  if (!env.ACS_CONNECTION_STRING) return "ACS_CONNECTION_STRING not set";
  if (!appUrlFor(env)) return "APP_BASE_URL not set on a self-hosted deployment";
  if (!senderAddressFor(env)) return "EMAIL_FROM not set on a self-hosted deployment";
  return "email is set up";
}

/** Run an email job without letting it throw: emails never break their trigger. */
export async function quietly(label: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (err) {
    console.error(`[email] ${label} failed`, { error: errorSummary(err) });
  }
}

// ── Once per key ────────────────────────────────────────────────────────────

/** Claim `key`; true when this call claimed it (nobody sent it before). */
async function claim(db: Database, key: string, organizationId: string | null): Promise<boolean> {
  const rows = await db
    .insert(emailsSent)
    .values({ key, organizationId })
    .onConflictDoNothing()
    .returning({ key: emailsSent.key });
  return rows.length > 0;
}

async function release(db: Database, key: string): Promise<void> {
  await db.delete(emailsSent).where(eq(emailsSent.key, key));
}

/** Which of `keys` were already claimed. One query, however many keys. */
async function claimedAmong(db: Database, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.select({ key: emailsSent.key }).from(emailsSent).where(inArray(emailsSent.key, keys));
  return new Set(rows.map((r) => r.key));
}

/** A workspace's name as an owner's email prints it, and its owners' addresses. */
async function workspaceOwners(db: Database, organizationId: string): Promise<{ workspace: string | null; emails: string[] }> {
  const rows = await db
    .select({ name: organizations.name, email: users.email, banned: users.banned })
    .from(organizations)
    .leftJoin(members, and(eq(members.organizationId, organizations.id), eq(members.role, "owner")))
    .leftJoin(users, eq(users.id, members.userId))
    .where(eq(organizations.id, organizationId));
  if (rows.length === 0) return { workspace: null, emails: [] };
  // The invitation's rule: a name a mail client would turn into a link
  // ("Cal.com"), or one stored before the naming rule that breaks it, is
  // left out ("your workspace"). Another owner may have chosen the name.
  const emails = [...new Set(rows.filter((r) => r.email && !r.banned).map((r) => r.email!))];
  return { workspace: workspaceNameForEmail(rows[0]!.name), emails };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Claim `key`, then send `build(workspace)` to the workspace's owners. When no
 * owner could be sent to, the claim is released so the next run tries again.
 * True when the email went out.
 */
async function sendToOwnersOnce(
  db: Database,
  mailer: Mailer,
  key: string,
  organizationId: string,
  build: (workspace: string) => Email,
): Promise<boolean> {
  if (!(await claim(db, key, organizationId))) return false;
  try {
    const owners = await workspaceOwners(db, organizationId);
    // Nobody to tell (no owner left): keep the claim, or every run would look again.
    if (owners.emails.length === 0) return false;
    const built = build(owners.workspace ?? "your workspace");
    const email = owners.workspace ? built : { ...built, subject: capitalize(built.subject) };
    const results = await Promise.allSettled(owners.emails.map((to) => mailer.send(to, email)));
    if (results.every((r) => r.status === "rejected")) {
      await release(db, key);
      console.error("[email] not sent; will retry", {
        key: key.split(":")[0],
        organizationId,
        error: errorSummary((results[0] as PromiseRejectedResult).reason),
      });
      return false;
    }
    return true;
  } catch (err) {
    await release(db, key).catch(() => {});
    throw err;
  }
}

/** "2026-11-25" (UTC): the day part of a key. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** "₹529" or "$19.50": an amount in minor units, as the emails print it. */
export function formatCharge(minor: number, currency: string): string {
  const major = minorToMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(major) ? 0 : undefined,
    }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

// ── 1. Welcome ──────────────────────────────────────────────────────────────

/**
 * The welcome email for a new account. Not sent on a self-hosted deployment
 * (it describes the hosted plans), nor to someone who signs up to accept an
 * invitation: they join a workspace that is already set up.
 */
export async function sendWelcomeEmail(
  db: Database,
  env: DeploymentEnv,
  mailer: Mailer | null,
  user: { email: string; name?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  if (!mailer || isSelfHosted(env) || !user.email) return false;
  const [invited] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = lower(${user.email})`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  if (invited) return false;
  await mailer.send(user.email, welcomeEmail({ name: user.name ?? null, links: mailer.links }));
  return true;
}

// ── 2. Usage ────────────────────────────────────────────────────────────────

export interface UsageReading {
  organizationId: string;
  /** Month-to-date live API calls. */
  count: number;
  /** null = unlimited. */
  limit: Limit;
}

/** Which usage email a reading calls for: 100 at the cap, 80 from 80% of it. */
export function usageEmailDue(count: number, limit: Limit): 80 | 100 | null {
  if (limit === null || limit <= 0) return null;
  if (count >= limit) return 100;
  if (count >= limit * 0.8) return 80;
  return null;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const usageKey = (threshold: 80 | 100, organizationId: string, now: Date) =>
  `usage:${threshold}:${organizationId}:${monthOf(now)}`;

/**
 * The 80% and 100% emails for this month's readings (from the usage job).
 * Each goes once per workspace and month; reaching 100% first means the 80%
 * email is never sent after it.
 */
export async function notifyUsage(
  db: Database,
  mailer: Mailer | null,
  readings: UsageReading[],
  now: Date = new Date(),
): Promise<void> {
  if (!mailer) return;
  const due = readings
    .map((r) => ({ ...r, threshold: usageEmailDue(r.count, r.limit) }))
    .filter((r): r is UsageReading & { threshold: 80 | 100; limit: number } => r.threshold !== null);
  if (due.length === 0) return;

  const claimed = await claimedAmong(
    db,
    due.flatMap((r) => [usageKey(80, r.organizationId, now), usageKey(100, r.organizationId, now)]),
  );
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  for (const r of due) {
    const key80 = usageKey(80, r.organizationId, now);
    const key100 = usageKey(100, r.organizationId, now);
    if (claimed.has(key100)) continue;
    if (r.threshold === 100) {
      const sent = await sendToOwnersOnce(db, mailer, key100, r.organizationId, (workspace) =>
        usageLimitEmail({ workspace, limit: r.limit, reachedOn: now, resetsOn, links: mailer.links }),
      );
      if (sent && !claimed.has(key80)) await claim(db, key80, r.organizationId);
    } else if (!claimed.has(key80)) {
      await sendToOwnersOnce(db, mailer, key80, r.organizationId, (workspace) =>
        usageWarningEmail({ workspace, used: r.count, limit: r.limit, resetsOn, links: mailer.links }),
      );
    }
  }
}

// ── 3. Billing ──────────────────────────────────────────────────────────────

const proEndedKey = (organizationId: string, periodEnd: Date) => `pro_ended:${organizationId}:${isoDay(periodEnd)}`;

/**
 * The failed-payment email, from Dodo's payment.failed or subscription.on_hold
 * (Dodo retries a failed renewal, so several can arrive: one email per paid
 * period). `data` is the event's payload; a payment carries what Dodo tried to
 * charge. When the paid period has already ended the workspace is on Free now,
 * so this email says so and the Pro-ended email for that period is not sent.
 */
export async function notifyPaymentFailed(
  db: Database,
  env: DeploymentEnv,
  mailer: Mailer | null,
  organizationId: string,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  if (!mailer || isSelfHosted(env)) return false;
  const [sub] = await db
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      environment: subscriptions.environment,
      dodoSubId: subscriptions.dodoSubId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .limit(1);
  if (!sub || normalizePlan(sub.plan) !== "pro" || !subscriptionCountsHere(sub, env) || !sub.currentPeriodEnd) return false;
  // An event about a subscription the workspace has since replaced (routes/webhooks.ts sameSubscription).
  const subId = typeof data.subscription_id === "string" ? data.subscription_id : null;
  if (subId && sub.dodoSubId && subId !== sub.dodoSubId) return false;

  const periodEnd = sub.currentPeriodEnd;
  const amount =
    typeof data.total_amount === "number" && Number.isInteger(data.total_amount) && typeof data.currency === "string"
      ? formatCharge(data.total_amount, data.currency.toUpperCase())
      : null;
  const proUntil = periodEnd.getTime() > now.getTime() ? periodEnd : null;
  const sent = await sendToOwnersOnce(db, mailer, `payment_failed:${organizationId}:${isoDay(periodEnd)}`, organizationId, (workspace) =>
    paymentFailedEmail({ workspace, amount, proUntil, links: mailer.links }),
  );
  if (sent && !proUntil) await claim(db, proEndedKey(organizationId, periodEnd), organizationId);
  return sent;
}

const ENDED_WITHIN_MS = 7 * 24 * 3600 * 1000;

/**
 * The Pro-ended email, from the 10-minute job: once for each workspace whose Pro
 * ended in the last 7 days. Pro ends when a cancelled or failing
 * subscription's paid period runs out (lib/entitlements.ts keeps Pro until
 * then; no Dodo event fires at that moment), or at once when it expires.
 */
export async function notifyProEnded(
  db: Database,
  env: DeploymentEnv,
  mailer: Mailer | null,
  now: Date = new Date(),
): Promise<void> {
  if (!mailer || isSelfHosted(env)) return;
  const since = new Date(now.getTime() - ENDED_WITHIN_MS);
  const rows = await db
    .select({
      organizationId: subscriptions.organizationId,
      plan: subscriptions.plan,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      environment: subscriptions.environment,
      updatedAt: subscriptions.updatedAt,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.plan, "pro"),
        ne(subscriptions.status, "active"),
        or(gt(subscriptions.currentPeriodEnd, since), gt(subscriptions.updatedAt, since)),
      ),
    );

  const ended = rows.flatMap((row) => {
    if (!subscriptionCountsHere(row, env) || effectivePlan(row, env) !== "free") return [];
    // When the paid period ran out, that is when Pro ended; otherwise (expired
    // early) it ended when the row last changed.
    const periodOver = row.currentPeriodEnd && row.currentPeriodEnd.getTime() <= now.getTime();
    const endedOn = periodOver ? row.currentPeriodEnd! : row.updatedAt;
    if (endedOn.getTime() <= since.getTime()) return [];
    return [{ organizationId: row.organizationId, endedOn, key: proEndedKey(row.organizationId, row.currentPeriodEnd ?? row.updatedAt) }];
  });
  const claimed = await claimedAmong(db, ended.map((e) => e.key));
  for (const e of ended) {
    if (claimed.has(e.key)) continue;
    await sendToOwnersOnce(db, mailer, e.key, e.organizationId, (workspace) =>
      proEndedEmail({ workspace, endedOn: e.endedOn, links: mailer.links }),
    );
  }
}

// ── 4. A payment platform refuses the key ───────────────────────────────────

const PLATFORM_NAMES: Record<string, string> = {
  dodopayments: "Dodo Payments",
  stripe: "Stripe",
  paddle: "Paddle",
  gumroad: "Gumroad",
  chargebee: "Chargebee",
  whop: "Whop",
  polar: "Polar",
  creem: "Creem",
  woocommerce: "WooCommerce",
};

const KEY_REFUSED_PREFIX = "key_refused:";
const REFUSED_WITHIN_MS = 7 * 24 * 3600 * 1000;

/**
 * The key-refused email, from the 10-minute job: once for each active
 * integration whose live key the platform refuses (integration-health's
 * "credentials" issue, recorded wherever a call to the platform is refused).
 * When the issue is cleared (the key works again, or was replaced) the claim
 * is released, so a later refusal sends a new email. A refused test key sends
 * nothing, and neither does a refusal last seen more than 7 days ago (nothing
 * has called the platform since, so it may no longer be true).
 */
export async function notifyRefusedKeys(db: Database, mailer: Mailer | null, now: Date = new Date()): Promise<void> {
  if (!mailer) return;
  const rows = await db
    .select({ id: integrations.id, organizationId: integrations.organizationId, provider: integrations.provider, health: integrations.health })
    .from(integrations)
    .where(and(eq(integrations.status, "active"), sql`${integrations.health} ? 'credentials'`));

  const refused = rows.flatMap((row) => {
    const issue = integrationHealthOf(row).credentials;
    if (!issue || issue.environment === "test") return [];
    return [{ ...row, issue, seenAt: Date.parse(issue.at), key: `${KEY_REFUSED_PREFIX}${row.id}` }];
  });

  // Keys that work again: forget their email, so the next refusal is told.
  await db
    .delete(emailsSent)
    .where(
      refused.length > 0
        ? and(like(emailsSent.key, `${KEY_REFUSED_PREFIX}%`), notInArray(emailsSent.key, refused.map((r) => r.key)))
        : like(emailsSent.key, `${KEY_REFUSED_PREFIX}%`),
    );

  const recent = refused.filter((r) => Number.isFinite(r.seenAt) && r.seenAt > now.getTime() - REFUSED_WITHIN_MS);
  const claimed = await claimedAmong(db, recent.map((r) => r.key));
  for (const r of recent) {
    if (claimed.has(r.key)) continue;
    await sendToOwnersOnce(db, mailer, r.key, r.organizationId, (workspace) =>
      integrationKeyRefusedEmail({
        workspace,
        platform: PLATFORM_NAMES[r.provider] ?? r.provider,
        platformMessage: r.issue.message,
        seenOn: new Date(r.seenAt),
        links: mailer.links,
      }),
    );
  }
}

/** The 10-minute job's emails: Pro that ended, and keys a platform refuses. */
export async function runScheduledEmails(db: Database, env: Bindings, now: Date = new Date()): Promise<void> {
  const mailer = mailerFor(env);
  if (!mailer) return;
  await quietly("Pro-ended emails", () => notifyProEnded(db, env, mailer, now));
  await quietly("key-refused emails", () => notifyRefusedKeys(db, mailer, now));
}
