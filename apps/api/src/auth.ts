import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, testUtils } from "better-auth/plugins";
import { defaultAc } from "better-auth/plugins/organization/access";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, and, sql } from "drizzle-orm";
import type { Bindings } from "./bindings";
import { hasReachedLimit } from "@gopaylocal/shared";
import type { Limit } from "@gopaylocal/shared";
import {
  PERMISSIONS,
  WORKSPACE_ROLES,
  can,
  type Permission,
  type WorkspaceRole,
} from "@gopaylocal/shared/permissions";
import { createDb, type Database } from "./db";
import * as schema from "./db/schema";
import { sendEmail, senderAddressFor } from "./lib/email";
import { isSelfHosted, resolveEntitlements } from "./lib/entitlements";
import { errorSummary } from "./lib/log";
import { checkWorkspaceName, workspaceNameForEmail } from "./lib/workspace-name";
import { credentialedOrigins } from "./middleware/cors";

// Team seat caps (the owner counts as a seat) come from resolveEntitlements:
// Free = 1, Pro and self-hosted = unlimited (null). A per-org override
// (organization_limit_overrides.maxTeamMembers) wins on hosted deployments.
//
// UPGRADE NOTE: every Better Auth extension point this file relies on is marked
// "BA extension point" below. On a Better Auth upgrade, re-check each one
// against the new version's types and docs. Last checked against 1.7.25.

let hasWarnedMissingGoogleConfig = false;
let hasWarnedMissingGitHubConfig = false;

function hasNonEmptyValue(value?: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Suspension (ban) ────────────────────────────────────────────────────────
//
// Bans are ours, not Better Auth's: there is no admin plugin, and `banned` is
// not a Better Auth user field, so nothing in Better Auth reads it. It is
// enforced at three layers:
//   1. no new session for a banned user (databaseHooks.session.create.before);
//   2. Better Auth's own endpoints refuse a banned user's existing session,
//      including the 5-minute cookie cache (hooks.before, enforceBanOnAuthRequest);
//   3. every /v1 route behind sessionMiddleware refuses a banned user.
// The admin ban route (routes/admin.ts) also deletes the user's sessions.

export const ACCOUNT_SUSPENDED_MESSAGE =
  "Your account has been suspended. Contact support if you believe this is an error.";

/**
 * Whether the user row is flagged banned. Always read from the database: the
 * session (and its cookie cache) cannot be trusted to reflect a ban made
 * after it was issued.
 */
export async function isUserBanned(db: Pick<Database, "select">, userId: string): Promise<boolean> {
  const [row] = await db
    // NOW() is there on purpose; do not remove it. Hyperdrive's query cache
    // serves a read for up to ~75 s and is never invalidated by writes, but it
    // never caches a statement that calls NOW() (detected by text, upper case
    // as Cloudflare documents it). Without it a ban would apply that late.
    .select({ banned: schema.users.banned, uncached: sql`NOW()` })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.banned === true;
}

/**
 * Better Auth paths the ban guard (hooks.before) leaves alone:
 *  - sign-in, sign-up and OAuth callbacks start with no session; a banned user
 *    is stopped there by the session.create hook instead;
 *  - sign-out must keep working so a banned user can clear their cookies;
 *  - get-session is the dashboard's hot polling path (no DB read wanted there),
 *    returns only the caller's own session, and every data route behind it
 *    enforces the ban anyway; once the ban route deletes the sessions it
 *    returns null as soon as the cookie cache lapses;
 *  - ok / error are static.
 */
const BAN_GUARD_SKIP_EXACT = new Set(["/get-session", "/sign-out", "/ok", "/error"]);
const BAN_GUARD_SKIP_PREFIXES = ["/sign-in/", "/sign-up/", "/callback/", "/oauth2/callback/"];

export function skipsBanGuard(path: string): boolean {
  return BAN_GUARD_SKIP_EXACT.has(path) || BAN_GUARD_SKIP_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * hooks.before body: refuse every other Better Auth endpoint (the
 * /organization/* routes in particular: invite, role changes, create, accept
 * invitation...) to a session whose user is banned.
 */
export async function enforceBanOnAuthRequest(
  ctx: Parameters<typeof getSessionFromCtx>[0],
  db: Pick<Database, "select">,
): Promise<void> {
  if (skipsBanGuard(ctx.path)) return;

  // getSessionFromCtx caches its result on ctx.context.session. Restore the
  // previous value afterwards so the endpoint still resolves the session with
  // its own options (sensitive endpoints bypass the cookie cache).
  const previous = ctx.context.session;
  let session: Awaited<ReturnType<typeof getSessionFromCtx>>;
  try {
    session = await getSessionFromCtx(ctx, { disableRefresh: true });
  } finally {
    ctx.context.session = previous;
  }
  if (!session) return; // no session: the endpoint applies its own auth rules

  let banned: boolean;
  try {
    banned = await isUserBanned(db, session.user.id);
  } catch (err) {
    console.error("auth: ban check failed", { path: ctx.path, userId: session.user.id, error: errorSummary(err) });
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not verify account status" });
  }
  if (banned) {
    throw new APIError("FORBIDDEN", { message: ACCOUNT_SUSPENDED_MESSAGE, code: "ACCOUNT_SUSPENDED" });
  }
}

// ── Organization roles ──────────────────────────────────────────────────────
//
// Better Auth's organization routes authorize with their own statements. Each
// one is mapped to a row of the shared permission table
// (packages/shared/src/permissions), and the roles handed to Better Auth are
// generated from that table, so the table is the only place a rule lives:
//   /organization/update              organization:update -> workspace.rename
//   /organization/delete              organization:delete -> workspace.delete (also disabled outright)
//   /organization/update-member-role  member:update       -> team.changeRole
//   /organization/remove-member       member:delete       -> team.removeMember
//   /organization/invite-member       invitation:create   -> team.invite
//   /organization/list-invitations    invitation:create   -> team.invite (who may see invitation links)
//   /organization/cancel-invitation   invitation:cancel   -> team.cancelInvitation
//   auth.api.addMember (server only)  member:create       -> team.invite
// Better Auth's `team:*` statements (teams are off) and `ac:*` (dynamic access
// control is off) are granted to nobody. /organization/leave checks no
// statement; Better Auth itself refuses the last owner (team.leave's note).
// BA extension point: the `roles` option, `defaultAc` from
// "better-auth/plugins/organization/access", and the statement each route checks.
export const BETTER_AUTH_STATEMENTS = {
  organization: { update: "workspace.rename", delete: "workspace.delete" },
  member: { create: "team.invite", update: "team.changeRole", delete: "team.removeMember" },
  invitation: { create: "team.invite", cancel: "team.cancelInvitation" },
} as const satisfies Record<string, Record<string, Permission>>;

/** The Better Auth statements `role` holds, derived from the permission table. */
export function betterAuthStatementsFor(role: WorkspaceRole): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(BETTER_AUTH_STATEMENTS).map(([resource, actions]) => [
      resource,
      Object.entries(actions)
        .filter(([, permission]) => PERMISSIONS[permission as Permission][role] !== "none")
        .map(([action]) => action),
    ]),
  );
}

type BetterAuthStatements = Parameters<typeof defaultAc.newRole>[0];
const orgRoles = Object.fromEntries(
  WORKSPACE_ROLES.map((role) => [role, defaultAc.newRole(betterAuthStatementsFor(role) as BetterAuthStatements)]),
) as Record<WorkspaceRole, ReturnType<typeof defaultAc.newRole>>;

/** The normalised workspace name, or a 400 Better Auth returns to the caller. */
export function workspaceNameOrThrow(name: unknown): string {
  const checked = checkWorkspaceName(name);
  if (!checked.ok) {
    throw new APIError("BAD_REQUEST", { message: checked.error, code: "INVALID_WORKSPACE_NAME" });
  }
  return checked.name;
}

// ── Invitation email ────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Collapse control characters (CR/LF included) and cap length for a subject line. */
function subjectText(value: string, max = 100): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The invitation email. Organization and inviter names are user-controlled
 * (anyone can create an org with any name and invite any address), so every
 * interpolated value is escaped: otherwise GoPayLocal would send attacker
 * HTML (fake buttons, phishing links) from its own domain.
 */
export function buildInvitationEmail(input: {
  organizationName: string;
  inviterName: string | null | undefined;
  inviterEmail: string;
  appUrl: string;
  invitationId: string;
}): { subject: string; html: string } {
  const orgName = escapeHtml(input.organizationName);
  const inviter = escapeHtml(input.inviterName || input.inviterEmail);
  const inviteLink = escapeHtml(`${input.appUrl}/invite/${encodeURIComponent(input.invitationId)}`);
  return {
    subject: `You've been invited to ${subjectText(input.organizationName)} on GoPayLocal`,
    html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                  <h2 style="margin: 0 0 8px; font-size: 20px; color: #0D0D0D;">Join ${orgName}</h2>
                  <p style="margin: 0 0 24px; color: #666; font-size: 14px; line-height: 1.5;">
                    ${inviter} invited you to collaborate on their PPP campaigns on GoPayLocal.
                  </p>
                  <a href="${inviteLink}" style="display: inline-block; background: #E42313; color: #fff; padding: 12px 24px; text-decoration: none; font-weight: 600; font-size: 14px;">
                    Accept Invitation
                  </a>
                  <p style="margin: 24px 0 0; color: #999; font-size: 12px;">
                    If you didn't expect this invitation, you can ignore this email.
                  </p>
                </div>
              `,
  };
}

// ── Deployment URLs ─────────────────────────────────────────────────────────
// The hosted service's URLs are fallbacks for the hosted deployment only. A
// self-hosted deployment (SELF_HOSTED="true") never falls back to them: its
// OAuth callbacks and invitation links must not point at gopaylocal.com.

const HOSTED_API_BASE_URL = "https://api.gopaylocal.com";
const HOSTED_APP_BASE_URL = "https://app.gopaylocal.com";

/**
 * Better Auth's baseURL: API_BASE_URL, else the hosted API when hosted. Self-
 * hosted with API_BASE_URL unset: undefined, so Better Auth derives the origin
 * from each request (and logs that the base URL is not set).
 */
export function authBaseURL(env: Pick<Bindings, "API_BASE_URL" | "SELF_HOSTED">): string | undefined {
  return env.API_BASE_URL ?? (isSelfHosted(env) ? undefined : HOSTED_API_BASE_URL);
}

/**
 * Where invitation links point: APP_BASE_URL, else the hosted dashboard when
 * hosted. Self-hosted with APP_BASE_URL unset: null, and no email is sent (the
 * owner can still copy the link from the dashboard).
 */
export function invitationAppUrl(env: Pick<Bindings, "APP_BASE_URL" | "SELF_HOSTED">): string | null {
  return env.APP_BASE_URL ?? (isSelfHosted(env) ? null : HOSTED_APP_BASE_URL);
}

export interface CreateAuthOptions {
  /** Allow public email sign-up. Only local seeding (tests, scripts) passes this. */
  allowEmailSignUp?: boolean;
  /**
   * Add Better Auth's testUtils() plugin (in-process helpers on auth.$context).
   * Only an explicit argument turns it on, never configuration, so a deployed
   * Worker (which always calls createAuth(env) with no options) cannot enable it.
   */
  enableTestUtils?: boolean;
}

export function createAuth(env: Bindings, opts?: CreateAuthOptions) {
  const db = createDb(env);

  // Resolve an org's team seat cap (null = unlimited): self-hosted is
  // unlimited; otherwise an explicit override wins, then the effective plan's
  // cap (status-aware, so a churned sub drops to free = 1).
  const seatCapForOrg = async (orgId: string): Promise<Limit> => {
    const [subRow, overrideRow] = await Promise.all([
      db
        .select({
          plan: schema.subscriptions.plan,
          status: schema.subscriptions.status,
          currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
          environment: schema.subscriptions.environment,
        })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.organizationId, orgId))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ maxTeamMembers: schema.organizationLimitOverrides.maxTeamMembers })
        .from(schema.organizationLimitOverrides)
        .where(eq(schema.organizationLimitOverrides.organizationId, orgId))
        .limit(1)
        .then((r) => r[0]),
    ]);
    return resolveEntitlements(subRow, env, overrideRow ?? null).limits.teamMembers;
  };

  // Origins Better Auth trusts for its CSRF/origin check and redirect URLs:
  // exactly the credentialed-CORS allowlist (APP_BASE_URL, ADMIN_BASE_URL, the
  // hosted marketing site unless self-hosted, CORS_ALLOWED_ORIGINS, and the
  // localhost dev servers only when running locally). The request URL is
  // passed like the CORS middleware does, so both agree per request; with no
  // request (auth.api calls) API_BASE_URL decides whether this is local dev.
  // Better Auth always trusts baseURL's own origin as well.
  // BA extension point: `trustedOrigins` as a function of the request.
  const trustedOrigins = (request?: Request) => [
    ...credentialedOrigins(env, request?.url ?? env.API_BASE_URL),
  ];
  const socialProviders: Partial<Record<"google" | "github", { clientId: string; clientSecret: string }>> = {};

  if (hasNonEmptyValue(env.GOOGLE_CLIENT_ID) && hasNonEmptyValue(env.GOOGLE_CLIENT_SECRET)) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  } else if (!hasWarnedMissingGoogleConfig) {
    console.warn("Google OAuth provider is disabled because GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.");
    hasWarnedMissingGoogleConfig = true;
  }

  if (hasNonEmptyValue(env.GITHUB_CLIENT_ID) && hasNonEmptyValue(env.GITHUB_CLIENT_SECRET)) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  } else if (!hasWarnedMissingGitHubConfig) {
    console.warn("GitHub OAuth provider is disabled because GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing.");
    hasWarnedMissingGitHubConfig = true;
  }

  return betterAuth({
    // BA extension point: the drizzle adapter. Since 1.7 Better Auth validates
    // `schema` against what it and its plugins expect before every request
    // (advanced.database.validateSchema, default on) and fails the request on a
    // mismatch; auth.test.ts runs the same check offline.
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: authBaseURL(env),
    trustedOrigins,
    socialProviders,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(opts?.allowEmailSignUp ?? false),
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    account: {
      // Avoid DB-backed OAuth state to keep social sign-in working
      // even when the Better Auth `verification` table is not present.
      storeStateStrategy: "cookie",
      // The GitHub/Google tokens Better Auth keeps in the `account` table are
      // encrypted with the auth secret, so a copy of the database alone does
      // not hand them out. GoPayLocal never uses them after sign-in. Tokens
      // stored in plain text before this setting are still read as they are.
      encryptOAuthTokens: true,
    },
    session: {
      cookieCache: { enabled: true, maxAge: 300 },
    },
    // BA extension point: `advanced.disableOriginCheck`. Left unset, Better
    // Auth (1.5.5 and 1.7.25 alike) turns its Origin/CSRF check OFF whenever it
    // thinks it is under test: NODE_ENV === "test" or a truthy TEST env var
    // (core env/env-impl.mjs, context/create-context.mjs; in 1.7 a skipped
    // Origin check still skips CSRF too unless `disableCSRFCheck` is set). In a
    // Worker those can leak in from the deploying shell (wrangler inlines
    // process.env.NODE_ENV at build time) or, once process.env is populated
    // from Worker vars (nodejs_compat at a newer compatibility date), from a
    // var named TEST. Pinning it to false keeps the
    // check on everywhere, and makes the integration tests exercise it too.
    advanced: {
      disableOriginCheck: false,
    },
    // BA extension point: global `hooks.before` (createAuthMiddleware). Runs
    // before every Better Auth endpoint; see enforceBanOnAuthRequest.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await enforceBanOnAuthRequest(ctx, db);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // BA extension point: databaseHooks.session.create.before. Throwing
          // aborts session creation for every sign-in method (email, OAuth,
          // and any future one), because they all create sessions here.
          before: async (session, ctx) => {
            // 1. A banned user gets no session. Same shape as Better Auth's own
            //    admin plugin: redirect on OAuth callbacks (the browser is
            //    mid-redirect), a 403 everywhere else. Fails closed.
            let banned: boolean;
            try {
              banned = await isUserBanned(db, session.userId);
            } catch (err) {
              console.error("auth: ban check at sign-in failed", {
                userId: session.userId,
                error: errorSummary(err),
              });
              throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not verify account status" });
            }
            if (banned) {
              if (ctx && (ctx.path.startsWith("/callback") || ctx.path.startsWith("/oauth2/callback"))) {
                const errorURL = ctx.context.options.onAPIError?.errorURL || `${ctx.context.baseURL}/error`;
                throw ctx.redirect(
                  `${errorURL}?error=account_suspended&error_description=${encodeURIComponent(ACCOUNT_SUSPENDED_MESSAGE)}`,
                );
              }
              throw new APIError("FORBIDDEN", { message: ACCOUNT_SUSPENDED_MESSAGE, code: "ACCOUNT_SUSPENDED" });
            }

            // 2. Auto-set active organization on login so returning users skip onboarding
            if (session.activeOrganizationId) return { data: session };
            try {
              const [membership] = await db
                .select({ organizationId: schema.members.organizationId })
                .from(schema.members)
                .where(eq(schema.members.userId, session.userId))
                .limit(1);
              if (membership) {
                return {
                  data: { ...session, activeOrganizationId: membership.organizationId },
                };
              }
            } catch (err) {
              console.error("Failed to auto-set active org:", err);
            }
            return { data: session };
          },
        },
      },
    },
    plugins: [
      organization({
        // BA extension point: `disableOrganizationDeletion`. Better Auth's
        // POST /organization/delete only deletes the organization rows; it
        // skips our cascade (API-key KV mappings, cached banner configs,
        // provider webhooks, products/campaigns/coupons). With this set it
        // answers 404 ORGANIZATION_DELETION_DISABLED, and the only delete path
        // is DELETE /v1/teams/:orgId (routes/team-members.ts, owner only).
        disableOrganizationDeletion: true,

        // BA extension point: `roles` (see orgRoles above). `ac` is not set: in
        // 1.5.5 and 1.7.25 it is read only by dynamic access control, which is off.
        roles: orgRoles,

        async sendInvitationEmail(data) {
          if (!env.ACS_CONNECTION_STRING) {
            console.warn("ACS_CONNECTION_STRING not set, skipping invitation email.");
            return;
          }
          const appUrl = invitationAppUrl(env);
          if (!appUrl) {
            console.warn("APP_BASE_URL not set on a self-hosted deployment, skipping invitation email.");
            return;
          }
          const senderAddress = senderAddressFor(env);
          if (!senderAddress) {
            console.warn("EMAIL_FROM not set on a self-hosted deployment, skipping invitation email.");
            return;
          }
          // Never mail out a name a mail client would turn into a link
          // ("Cal.com"), or one stored before the naming rule existed that
          // breaks it (a link, invisible characters).
          const { subject, html } = buildInvitationEmail({
            organizationName: workspaceNameForEmail(data.organization.name) ?? "a workspace",
            inviterName: data.inviter.user.name,
            inviterEmail: data.inviter.user.email,
            appUrl,
            invitationId: data.id,
          });
          try {
            await sendEmail(env.ACS_CONNECTION_STRING, { to: data.email, subject, html, senderAddress });
          } catch (err) {
            console.error("Failed to send invitation email:", errorSummary(err));
          }
        },

        // Per-plan seat cap on the accept/add path (built-in Better Auth guard).
        // Better Auth only compares `memberCount >= limit` in-process (never
        // serialized), so Infinity is a safe stand-in for an unlimited cap.
        membershipLimit: async (_user, organization) =>
          (await seatCapForOrg(organization.id)) ?? Number.POSITIVE_INFINITY,

        organizationHooks: {
          // Workspace naming rule (lib/workspace-name.ts) on create and rename.
          // The normalised name is written back into the object Better Auth
          // stores. (Returning { data } instead would make Better Auth merge
          // the whole request body back in, userId and all.)
          // BA extension point: beforeCreateOrganization / beforeUpdateOrganization
          // receive the object that is then written.
          beforeCreateOrganization: async ({ organization }) => {
            organization.name = workspaceNameOrThrow(organization.name);
          },
          beforeUpdateOrganization: async ({ organization }) => {
            if (organization.name !== undefined) organization.name = workspaceNameOrThrow(organization.name);
          },

          // Guard the invite-creation path: invites need team.invite (owner
          // only), and the team can't grow past the plan's seat cap (members +
          // pending invitations). Better Auth already refuses roles without
          // invitation:create (derived from the same row); this re-reads the
          // role from the database and stays if that mapping ever drifts.
          beforeCreateInvitation: async ({ inviter, organization }) => {
            const inviterMember = await db
              .select({ role: schema.members.role })
              .from(schema.members)
              .where(
                and(
                  eq(schema.members.organizationId, organization.id),
                  eq(schema.members.userId, inviter.id),
                ),
              )
              .limit(1)
              .then((r) => r[0]);
            if (!can(inviterMember?.role, "team.invite")) {
              throw new APIError("FORBIDDEN", {
                message: "Only the organization owner can invite members.",
              });
            }

            const cap = await seatCapForOrg(organization.id);
            if (cap === null) return; // unlimited seats: nothing to count
            const [memberCount, inviteCount] = await Promise.all([
              db
                .select({ c: sql<number>`count(*)::int` })
                .from(schema.members)
                .where(eq(schema.members.organizationId, organization.id))
                .then((r) => r[0]?.c ?? 0),
              db
                .select({ c: sql<number>`count(*)::int` })
                .from(schema.invitations)
                .where(
                  and(
                    eq(schema.invitations.organizationId, organization.id),
                    eq(schema.invitations.status, "pending"),
                  ),
                )
                .then((r) => r[0]?.c ?? 0),
            ]);
            if (hasReachedLimit(memberCount + inviteCount, cap)) {
              throw new APIError("FORBIDDEN", {
                message: `Your plan allows ${cap} team member${cap === 1 ? "" : "s"}. Upgrade to invite more.`,
              });
            }
          },
        },
      }),
      // Explicit opt-in only (CreateAuthOptions.enableTestUtils); no env var or
      // URL can turn it on. Nothing in the repo uses it today: tests and
      // scripts seed users through allowEmailSignUp instead.
      ...(opts?.enableTestUtils === true ? [testUtils()] : []),
    ],
  });
}
