import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

const acsSent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text?: string }>);
vi.mock("../lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/email")>()),
  sendEmail: async (_conn: string, options: { to: string; subject: string; html: string; text?: string }) => {
    acsSent.push(options);
  },
}));
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

import worker from "../index";
import { emailsSent, integrations, invitations, members, subscriptions, users } from "../db/schema";
import type { Email } from "../emails/layout";
import { createTestBindings, createTestClient } from "../test/helpers";
import { addMember, seedOrg, seedUser } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";
import {
  type Mailer,
  notifyPaymentFailed,
  notifyProEnded,
  notifyRefusedKeys,
  notifyUsage,
  sendWelcomeEmail,
} from "./notify";

/**
 * GoPayLocal's own emails against real Postgres: each goes once (emails_sent),
 * only to a workspace's owners, a failed send is retried on the next run, and
 * the triggers (sign-up, the Dodo webhook) send them through ACS.
 */

const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-25T12:00:00Z");
const daysFrom = (base: Date, days: number) => new Date(base.getTime() + days * DAY_MS);
const ACS = "endpoint=https://acs.example.com/;accesskey=RkFLRQ==";

/** A mailer that records what it sends, or fails every send. */
function fakeMailer(opts: { fail?: boolean } = {}) {
  const sent: Array<{ to: string; email: Email }> = [];
  const mailer: Mailer = {
    links: { app: "https://app.gopaylocal.com", support: "support@gopaylocal.com" },
    async send(to, email) {
      if (opts.fail) throw new Error("ACS down");
      sent.push({ to, email });
    },
  };
  return { mailer, sent, subjects: () => sent.map((s) => s.email.subject) };
}

const hosted = () => createTestBindings({ SELF_HOSTED: "false" });

/** A workspace with one owner (and optionally a member), the owner's address returned. */
async function workspace(name = "Acme Labs", opts: { member?: boolean } = {}) {
  const env = hosted();
  const owner = await seedUser(env, `${name} Owner`);
  const orgId = await seedOrg(owner.id, name);
  let memberEmail: string | null = null;
  if (opts.member) {
    const member = await seedUser(env, `${name} Member`);
    await addMember(orgId, member.id, "member");
    memberEmail = member.email;
  }
  return { orgId, ownerId: owner.id, ownerEmail: owner.email, memberEmail };
}

async function setSubscription(
  orgId: string,
  values: { status: string; currentPeriodEnd: Date | null; updatedAt?: Date; environment?: "live" | "test"; dodoSubId?: string },
) {
  await getTestDb()
    .insert(subscriptions)
    .values({ id: ulid(), organizationId: orgId, plan: "pro", ...values, updatedAt: values.updatedAt ?? NOW });
}

beforeEach(async () => {
  await cleanupTestDb();
  acsSent.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await cleanupTestDb();
  await closeTestDb();
});

describe("usage emails", () => {
  it("80% once, 100% once, owners only, again next month", async () => {
    const w = await workspace("Acme Labs", { member: true });
    const { mailer, sent, subjects } = fakeMailer();
    const reading = (count: number) => [{ organizationId: w.orgId, count, limit: 10_000 }];

    await notifyUsage(getTestDb(), mailer, reading(7_999), NOW);
    expect(sent).toHaveLength(0);

    await notifyUsage(getTestDb(), mailer, reading(8_100), NOW);
    await notifyUsage(getTestDb(), mailer, reading(9_000), NOW);
    expect(subjects()).toEqual(["Acme Labs has used 81% of this month's API calls"]);
    expect(sent.map((s) => s.to)).toEqual([w.ownerEmail]);

    await notifyUsage(getTestDb(), mailer, reading(10_000), NOW);
    await notifyUsage(getTestDb(), mailer, reading(12_000), NOW);
    expect(subjects().slice(1)).toEqual(["Acme Labs's banner has stopped offering discounts"]);

    // December: the count starts again, and so do the emails.
    await notifyUsage(getTestDb(), mailer, reading(8_000), new Date("2026-12-10T00:00:00Z"));
    expect(sent).toHaveLength(3);
  });

  it("reaching the limit first means no 80% email after it", async () => {
    const w = await workspace();
    const { mailer, subjects } = fakeMailer();
    await notifyUsage(getTestDb(), mailer, [{ organizationId: w.orgId, count: 15_000, limit: 10_000 }], NOW);
    await notifyUsage(getTestDb(), mailer, [{ organizationId: w.orgId, count: 8_500, limit: 10_000 }], NOW);
    expect(subjects()).toEqual(["Acme Labs's banner has stopped offering discounts"]);
  });

  it("an unlimited workspace gets nothing", async () => {
    const w = await workspace();
    const { mailer, sent } = fakeMailer();
    await notifyUsage(getTestDb(), mailer, [{ organizationId: w.orgId, count: 30_000_000, limit: null }], NOW);
    expect(sent).toHaveLength(0);
    expect(await getTestDb().select().from(emailsSent)).toHaveLength(0);
  });

  it("when every send fails, the next run tries again", async () => {
    const w = await workspace();
    const reading = [{ organizationId: w.orgId, count: 9_000, limit: 10_000 }];
    await notifyUsage(getTestDb(), fakeMailer({ fail: true }).mailer, reading, NOW);
    expect(await getTestDb().select().from(emailsSent)).toHaveLength(0);

    const { mailer, sent } = fakeMailer();
    await notifyUsage(getTestDb(), mailer, reading, NOW);
    expect(sent).toHaveLength(1);
  });

  it("skips a suspended owner, and writes 'your workspace' for a name a mail app would link", async () => {
    const w = await workspace("Cal.com");
    const env = hosted();
    const coOwner = await seedUser(env, "Co Owner");
    await addMember(w.orgId, coOwner.id, "owner");
    await getTestDb().update(users).set({ banned: true }).where(eq(users.id, coOwner.id));

    const { mailer, sent } = fakeMailer();
    await notifyUsage(getTestDb(), mailer, [{ organizationId: w.orgId, count: 8_000, limit: 10_000 }], NOW);
    expect(sent.map((s) => s.to)).toEqual([w.ownerEmail]);
    expect(sent[0]!.email.subject).toBe("Your workspace has used 80% of this month's API calls");
    expect(sent[0]!.email.html).not.toContain("Cal.com");
  });

  it("a workspace with no owner left sends nothing and isn't looked at again", async () => {
    const w = await workspace();
    await getTestDb().delete(members).where(eq(members.organizationId, w.orgId));
    const { mailer, sent } = fakeMailer();
    await notifyUsage(getTestDb(), mailer, [{ organizationId: w.orgId, count: 8_000, limit: 10_000 }], NOW);
    expect(sent).toHaveLength(0);
    expect(await getTestDb().select().from(emailsSent)).toHaveLength(1);
  });
});

describe("Pro-ended emails", () => {
  it("once, when a cancelled Pro's paid period has run out", async () => {
    const ended = await workspace("Ended Org");
    const grace = await workspace("Grace Org");
    const longAgo = await workspace("Long Ago Org");
    const active = await workspace("Active Org");
    await setSubscription(ended.orgId, { status: "cancelled", currentPeriodEnd: daysFrom(NOW, -2), updatedAt: daysFrom(NOW, -20) });
    await setSubscription(grace.orgId, { status: "cancelled", currentPeriodEnd: daysFrom(NOW, 5) });
    await setSubscription(longAgo.orgId, { status: "cancelled", currentPeriodEnd: daysFrom(NOW, -10), updatedAt: daysFrom(NOW, -40) });
    await setSubscription(active.orgId, { status: "active", currentPeriodEnd: daysFrom(NOW, -1) });

    const { mailer, sent } = fakeMailer();
    await notifyProEnded(getTestDb(), hosted(), mailer, NOW);
    await notifyProEnded(getTestDb(), hosted(), mailer, NOW);
    expect(sent.map((s) => s.email.subject)).toEqual(["Ended Org is on the Free plan now"]);
    expect(sent[0]!.to).toBe(ended.ownerEmail);
    expect(sent[0]!.email.text).toContain("23 November");
  });

  it("at once when Dodo expires it; never for a test-mode subscription on the live service", async () => {
    const expired = await workspace("Expired Org");
    const testMode = await workspace("Test Mode Org");
    await setSubscription(expired.orgId, { status: "expired", currentPeriodEnd: daysFrom(NOW, 10) });
    await setSubscription(testMode.orgId, { status: "cancelled", currentPeriodEnd: daysFrom(NOW, -1), environment: "test" });

    const { mailer, subjects } = fakeMailer();
    await notifyProEnded(getTestDb(), hosted(), mailer, NOW);
    expect(subjects()).toEqual(["Expired Org is on the Free plan now"]);
  });

  it("never on a self-hosted deployment", async () => {
    const w = await workspace();
    await setSubscription(w.orgId, { status: "cancelled", currentPeriodEnd: daysFrom(NOW, -1) });
    const { mailer, sent } = fakeMailer();
    await notifyProEnded(getTestDb(), createTestBindings({ SELF_HOSTED: "true" }), mailer, NOW);
    expect(sent).toHaveLength(0);
  });
});

describe("payment-failed emails", () => {
  it("once per paid period, with the amount Dodo tried to charge", async () => {
    const w = await workspace();
    await setSubscription(w.orgId, { status: "past_due", currentPeriodEnd: daysFrom(NOW, 3), dodoSubId: "sub_1" });
    const { mailer, sent } = fakeMailer();
    const data = { subscription_id: "sub_1", total_amount: 52_900, currency: "INR" };

    expect(await notifyPaymentFailed(getTestDb(), hosted(), mailer, w.orgId, data, NOW)).toBe(true);
    expect(await notifyPaymentFailed(getTestDb(), hosted(), mailer, w.orgId, data, NOW)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.email.text).toContain("₹529");
    expect(sent[0]!.email.text).toContain("Pro stays on until 28 November");
  });

  it("ignores an event about a subscription the workspace has replaced", async () => {
    const w = await workspace();
    await setSubscription(w.orgId, { status: "active", currentPeriodEnd: daysFrom(NOW, 30), dodoSubId: "sub_new" });
    const { mailer, sent } = fakeMailer();
    await notifyPaymentFailed(getTestDb(), hosted(), mailer, w.orgId, { subscription_id: "sub_old" }, NOW);
    expect(sent).toHaveLength(0);
  });

  it("after the paid period it says the workspace is on Free, and no Pro-ended email follows", async () => {
    const w = await workspace();
    await setSubscription(w.orgId, { status: "on_hold", currentPeriodEnd: daysFrom(NOW, -1), dodoSubId: "sub_1" });
    const { mailer, sent } = fakeMailer();
    await notifyPaymentFailed(getTestDb(), hosted(), mailer, w.orgId, { subscription_id: "sub_1" }, NOW);
    await notifyProEnded(getTestDb(), hosted(), mailer, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.email.text).toContain("is on the Free plan until the payment goes through");
  });

  it("the Dodo webhook sends it through ACS", async () => {
    const secretBytes = new Uint8Array(32).map((_, i) => (i * 13 + 7) % 256);
    const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;
    const client = createTestClient(
      worker,
      createTestBindings({ DODO_WEBHOOK_SECRET: secret, DODO_PRICE_ID_PRO_MONTHLY: "pdt_test_pro", ACS_CONNECTION_STRING: ACS }),
    );
    const w = await workspace();
    await setSubscription(w.orgId, { status: "active", currentPeriodEnd: daysFrom(new Date(), 2), dodoSubId: "sub_1" });

    const body = JSON.stringify({
      type: "payment.failed",
      data: { subscription_id: "sub_1", total_amount: 1_900, currency: "USD", metadata: { organizationId: w.orgId } },
    });
    const id = `msg_${ulid()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
    const res = await client.request("/v1/webhooks/dodo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(acsSent.map((e) => [e.to, e.subject])).toEqual([[w.ownerEmail, "Your GoPayLocal payment didn't go through"]]);
    expect(acsSent[0]!.text).toContain("$19");
  });
});

describe("key-refused emails", () => {
  async function integration(orgId: string, health: Record<string, unknown>, status = "active") {
    const id = ulid();
    await getTestDb().insert(integrations).values({ id, organizationId: orgId, provider: "stripe", health, status });
    return id;
  }
  const refusal = (at: Date, environment: "live" | "test" = "live") => ({
    credentials: { area: "credentials", message: "Invalid API Key provided", environment, at: at.toISOString() },
  });

  it("once while the live key is refused, and again after it worked in between", async () => {
    const w = await workspace();
    const id = await integration(w.orgId, refusal(daysFrom(NOW, -1)));
    const { mailer, sent, subjects } = fakeMailer();

    await notifyRefusedKeys(getTestDb(), mailer, NOW);
    await notifyRefusedKeys(getTestDb(), mailer, NOW);
    expect(subjects()).toEqual(["Stripe refused GoPayLocal's key for Acme Labs"]);
    expect(sent[0]!.email.text).toContain("Invalid API Key provided");
    expect(sent[0]!.email.text).toContain("On 24 November");

    // The key works again (the issue is cleared), then is refused again.
    await getTestDb().update(integrations).set({ health: {} }).where(eq(integrations.id, id));
    await notifyRefusedKeys(getTestDb(), mailer, NOW);
    expect(await getTestDb().select().from(emailsSent)).toHaveLength(0);
    await getTestDb().update(integrations).set({ health: refusal(NOW) }).where(eq(integrations.id, id));
    await notifyRefusedKeys(getTestDb(), mailer, NOW);
    expect(sent).toHaveLength(2);
  });

  it("nothing for a test key, a refusal not seen for a week, or a disconnected integration", async () => {
    const w = await workspace();
    await integration(w.orgId, refusal(NOW, "test"));
    await integration(w.orgId, refusal(daysFrom(NOW, -8)));
    await integration(w.orgId, refusal(NOW), "inactive");
    const { mailer, sent } = fakeMailer();
    await notifyRefusedKeys(getTestDb(), mailer, NOW);
    expect(sent).toHaveLength(0);
  });
});

describe("welcome email", () => {
  it("goes to a new account through ACS when it signs up", async () => {
    const user = await seedUser(createTestBindings({ SELF_HOSTED: "false", ACS_CONNECTION_STRING: ACS }), "Ada Lovelace");
    expect(acsSent.map((e) => [e.to, e.subject])).toEqual([[user.email, "Welcome to GoPayLocal"]]);
    expect(acsSent[0]!.text).toContain("Hi Ada");
  });

  it("not to someone who signs up to accept an invitation, and never on a self-hosted deployment", async () => {
    const w = await workspace();
    await getTestDb().insert(invitations).values({
      id: ulid(),
      organizationId: w.orgId,
      email: "Invitee@Example.test",
      role: "member",
      status: "pending",
      inviterId: w.ownerId,
      expiresAt: daysFrom(NOW, 2),
    });
    const { mailer, sent } = fakeMailer();
    expect(await sendWelcomeEmail(getTestDb(), hosted(), mailer, { email: "invitee@example.test" }, NOW)).toBe(false);
    expect(await sendWelcomeEmail(getTestDb(), createTestBindings({ SELF_HOSTED: "true" }), mailer, { email: "new@example.test" }, NOW)).toBe(
      false,
    );
    expect(await sendWelcomeEmail(getTestDb(), hosted(), mailer, { email: "new@example.test", name: null }, NOW)).toBe(true);
    expect(sent.map((s) => s.to)).toEqual(["new@example.test"]);
  });
});
