import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { APIError } from "better-auth/api";
import type { Bindings } from "./bindings";
import { createTestBindings } from "./test/helpers";
import { createSqlRecorder, type SqlRecorder } from "./lib/sql-recorder-test-helpers";

// Security configuration of createAuth (bans, org roles, org deletion, trusted
// origins, testUtils, invitation email). No database: createDb() returns a
// recorder (real Drizzle SQL, canned rows), and Better Auth's
// getSessionFromCtx is stubbed for the hooks.before guard.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  session: null as null | { user: { id: string }; session: { id: string } },
  sessionCalls: [] as unknown[],
}));

vi.mock("./db", () => ({ createDb: () => state.recorder.db }));
const sentEmails = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; html: string; text?: string; replyTo?: string | null; senderAddress: string }>,
);
vi.mock("./lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/email")>()),
  sendEmail: async (
    _conn: string,
    options: { to: string; subject: string; html: string; text?: string; replyTo?: string | null; senderAddress: string },
  ) => {
    sentEmails.push(options);
  },
}));
vi.mock("better-auth/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/api")>();
  return {
    ...actual,
    getSessionFromCtx: async (ctx: { context: { session: unknown } }, config: unknown) => {
      state.sessionCalls.push(config);
      ctx.context.session = state.session; // what the real one does: cache on the context
      return state.session;
    },
  };
});

const {
  createAuth,
  isUserBanned,
  skipsBanGuard,
  enforceBanOnAuthRequest,
  buildInvitationEmail,
  escapeHtml,
  ACCOUNT_SUSPENDED_MESSAGE,
  BETTER_AUTH_STATEMENTS,
  betterAuthStatementsFor,
  workspaceNameOrThrow,
  authBaseURL,
  invitationAppUrl,
} = await import("./auth");
const { PERMISSIONS, WORKSPACE_ROLES, can } = await import("@gopaylocal/shared/permissions");
type Permission = import("@gopaylocal/shared/permissions").Permission;

type AnyPlugin = { id: string; options?: Record<string, any> };

function orgPluginOptions(env: Bindings = createTestBindings()) {
  const auth = createAuth(env);
  const plugin = (auth.options.plugins as AnyPlugin[]).find((p) => p.id === "organization");
  return plugin!.options!;
}

function sessionCreateBefore() {
  const auth = createAuth(createTestBindings());
  return auth.options.databaseHooks!.session!.create!.before!;
}

// NOW() keeps the ban check out of Hyperdrive's query cache (see isUserBanned).
const BAN_SQL = 'select "banned", NOW() from "user" where "user"."id" = $1 limit $2';

beforeEach(() => {
  state.recorder = createSqlRecorder();
  state.session = null;
  state.sessionCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("isUserBanned", () => {
  it("reads the banned flag from the user row by id", async () => {
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    expect(await isUserBanned(state.recorder.db, "u1")).toBe(true);
    expect(state.recorder.queries[0]).toEqual({ sql: BAN_SQL, params: ["u1", 1] });
  });

  it("keeps the ban check out of Hyperdrive's query cache (NOW() in the text)", async () => {
    // Hyperdrive caches reads for up to ~75 s and never on statements calling
    // NOW(); without it a ban would apply that late on the session path.
    state.recorder = createSqlRecorder([[{ banned: false }]]);
    await isUserBanned(state.recorder.db, "u1");
    expect(state.recorder.queries[0]!.sql).toContain("NOW()");
  });

  it("treats NULL, false and a missing row as not banned", async () => {
    state.recorder = createSqlRecorder([[{ banned: null }], [{ banned: false }], []]);
    expect(await isUserBanned(state.recorder.db, "u1")).toBe(false);
    expect(await isUserBanned(state.recorder.db, "u1")).toBe(false);
    expect(await isUserBanned(state.recorder.db, "u1")).toBe(false);
  });
});

describe("databaseHooks.session.create.before (no session for a banned user)", () => {
  const session = { id: "s1", userId: "u1", activeOrganizationId: null } as never;

  it("refuses a banned user with 403 ACCOUNT_SUSPENDED on email sign-in", async () => {
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    const ctx = { path: "/sign-in/email" } as never;
    const err = await sessionCreateBefore()(session, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(403);
    expect((err as APIError).body).toMatchObject({ code: "ACCOUNT_SUSPENDED", message: ACCOUNT_SUSPENDED_MESSAGE });
    expect(state.recorder.queries).toHaveLength(1); // nothing after the refusal
  });

  it("redirects to the error page instead on an OAuth callback", async () => {
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    const redirect = vi.fn((url: string) => Object.assign(new Error("redirect"), { url }));
    const ctx = {
      path: "/callback/google",
      context: { options: {}, baseURL: "https://api.example.test/api/auth" },
      redirect,
    } as never;
    const err = (await sessionCreateBefore()(session, ctx).catch((e: unknown) => e)) as { url: string };
    expect(redirect).toHaveBeenCalledOnce();
    expect(err.url).toMatch(/^https:\/\/api\.example\.test\/api\/auth\/error\?error=account_suspended&error_description=/);
  });

  it("refuses with no endpoint context at all (server-side createSession)", async () => {
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    await expect(sessionCreateBefore()(session, null)).rejects.toBeInstanceOf(APIError);
  });

  it("fails closed when the ban check cannot run, and logs it", async () => {
    state.recorder = createSqlRecorder([new Error("connection refused")]);
    const err = await sessionCreateBefore()(session, null).catch((e: unknown) => e);
    expect((err as APIError).statusCode).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "auth: ban check at sign-in failed",
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("lets a non-banned user through and still auto-selects their first org", async () => {
    state.recorder = createSqlRecorder([[{ banned: false }], [{ organizationId: "org_1" }]]);
    const result = await sessionCreateBefore()(session, null);
    expect(result).toEqual({ data: { ...(session as object), activeOrganizationId: "org_1" } });
    expect(state.recorder.queries[0]!.sql).toBe(BAN_SQL);
  });
});

describe("hooks.before ban guard (Better Auth's own endpoints)", () => {
  function ctxFor(path: string) {
    return { path, context: { session: null as unknown } } as never as Parameters<typeof enforceBanOnAuthRequest>[0];
  }

  it("is installed on every Better Auth instance", () => {
    expect(createAuth(createTestBindings()).options.hooks?.before).toBeTypeOf("function");
  });

  it.each([
    "/get-session",
    "/sign-out",
    "/ok",
    "/error",
    "/sign-in/email",
    "/sign-in/social",
    "/sign-up/email",
    "/callback/google",
    "/oauth2/callback/x",
  ])("leaves %s alone (no session lookup, no DB read)", async (path) => {
    expect(skipsBanGuard(path)).toBe(true);
    await enforceBanOnAuthRequest(ctxFor(path), state.recorder.db);
    expect(state.sessionCalls).toHaveLength(0);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it.each([
    "/organization/invite-member",
    "/organization/update-member-role",
    "/organization/create",
    "/organization/accept-invitation",
    "/organization/set-active",
    "/update-user",
    "/change-password",
    "/list-sessions",
  ])("refuses a banned user on %s with 403 ACCOUNT_SUSPENDED", async (path) => {
    state.session = { user: { id: "u_banned" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([[{ banned: true }]]);
    const err = await enforceBanOnAuthRequest(ctxFor(path), state.recorder.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(403);
    expect((err as APIError).body).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
    expect(state.recorder.queries[0]).toEqual({ sql: BAN_SQL, params: ["u_banned", 1] });
  });

  it("lets a non-banned user through, without refreshing the session, and leaves no cached session", async () => {
    state.session = { user: { id: "u_ok" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([[{ banned: false }]]);
    const ctx = ctxFor("/organization/invite-member");
    await enforceBanOnAuthRequest(ctx, state.recorder.db);
    expect(state.sessionCalls).toEqual([{ disableRefresh: true }]);
    // The endpoint must resolve the session itself, with its own options.
    expect(ctx.context.session).toBeNull();
  });

  it("does nothing without a session (the endpoint applies its own auth)", async () => {
    await enforceBanOnAuthRequest(ctxFor("/organization/create"), state.recorder.db);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("fails closed (500) and logs when the ban check cannot run", async () => {
    state.session = { user: { id: "u1" }, session: { id: "s" } };
    state.recorder = createSqlRecorder([new Error("timeout")]);
    const err = await enforceBanOnAuthRequest(ctxFor("/organization/create"), state.recorder.db).catch((e: unknown) => e);
    expect((err as APIError).statusCode).toBe(500);
    expect(console.error).toHaveBeenCalledWith("auth: ban check failed", expect.objectContaining({ userId: "u1" }));
  });
});

describe("organization plugin", () => {
  it("disables Better Auth's own organization delete (it skips our cascade)", () => {
    expect(orgPluginOptions().disableOrganizationDeletion).toBe(true);
  });

  // Every Better Auth statement our roles answer for, per role, generated from
  // the shared permission table: a change to a Team or Workspace row changes
  // what Better Auth's own routes allow, and nothing else can.
  const statementCases = WORKSPACE_ROLES.flatMap((role) =>
    Object.entries(BETTER_AUTH_STATEMENTS).flatMap(([resource, actions]) =>
      Object.entries(actions).map(([action, permission]) => ({ role, resource, action, permission: permission as Permission })),
    ),
  );

  it.each(statementCases)(
    "$role $resource:$action follows $permission",
    ({ role, resource, action, permission }) => {
      const { roles } = orgPluginOptions();
      expect(roles[role].authorize({ [resource]: [action] }).success).toBe(can(role, permission));
    },
  );

  it("the decided defaults: only the owner renames, removes, invites, cancels invitations or changes roles", () => {
    const { roles } = orgPluginOptions();
    const allowed = (role: string, permissions: Record<string, string[]>) => roles[role].authorize(permissions).success;

    const statements: Array<Record<string, string[]>> = [
      { organization: ["update"] }, // rename the workspace
      { member: ["delete"] }, // remove someone
      { member: ["update"] }, // change a role
      { invitation: ["create"] }, // invite (and see invitation links)
      { invitation: ["cancel"] }, // cancel an invitation
    ];
    for (const statement of statements) {
      expect({ statement, owner: allowed("owner", statement) }).toEqual({ statement, owner: true });
      expect({ statement, admin: allowed("admin", statement) }).toEqual({ statement, admin: false });
      expect({ statement, member: allowed("member", statement) }).toEqual({ statement, member: false });
    }
  });

  it("grants Better Auth's team:* and ac:* statements to nobody (teams and dynamic access control are off)", () => {
    const { roles } = orgPluginOptions();
    for (const role of WORKSPACE_ROLES) {
      expect(roles[role].authorize({ team: ["create"] }).success).toBe(false);
      expect(roles[role].authorize({ ac: ["read"] }).success).toBe(false);
    }
  });

  it("maps only rows that exist in the permission table", () => {
    for (const actions of Object.values(BETTER_AUTH_STATEMENTS)) {
      for (const permission of Object.values(actions)) expect(PERMISSIONS).toHaveProperty([permission]);
    }
    expect(betterAuthStatementsFor("owner")).toEqual({
      organization: ["update", "delete"],
      member: ["create", "update", "delete"],
      invitation: ["create", "cancel"],
    });
    expect(betterAuthStatementsFor("admin")).toEqual({ organization: [], member: [], invitation: [] });
  });

  it("beforeCreateInvitation refuses an inviter whose stored role lacks team.invite", async () => {
    const hook = orgPluginOptions().organizationHooks.beforeCreateInvitation;
    state.recorder = createSqlRecorder([[{ role: "admin" }]]);
    const err = await hook({ inviter: { id: "u_admin" }, organization: { id: "org_1" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(403);
  });
});

describe("workspace naming rule (Better Auth organization hooks)", () => {
  it("normalises the name on create and writes it into the object Better Auth stores", async () => {
    const { organizationHooks } = orgPluginOptions();
    const organization = { name: "  Acme    Labs ", slug: "acme" };
    expect(await organizationHooks.beforeCreateOrganization({ organization, user: { id: "u1" } })).toBeUndefined();
    expect(organization).toEqual({ name: "Acme Labs", slug: "acme" });
  });

  it.each([
    ["a link", "Visit www.evil.com"],
    ["a path", "evil.com/login"],
    ["a scheme", "https://x"],
    ["a line break", "Acme\nLabs"],
    ["a bidi override", "Acme‮txt.exe"],
    ["markup", "<b>Acme</b>"],
    ["one character", "A"],
    ["61 characters", "a".repeat(61)],
  ])("refuses %s with 400 INVALID_WORKSPACE_NAME on create", async (_label, name) => {
    const { organizationHooks } = orgPluginOptions();
    const err = await organizationHooks
      .beforeCreateOrganization({ organization: { name, slug: "x" }, user: { id: "u1" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(400);
    expect((err as APIError).body).toMatchObject({ code: "INVALID_WORKSPACE_NAME" });
  });

  it("applies on rename, and leaves an update without a name alone", async () => {
    const { organizationHooks } = orgPluginOptions();
    const rename = { name: "Acme   2" };
    await organizationHooks.beforeUpdateOrganization({ organization: rename, user: { id: "u1" }, member: {} });
    expect(rename).toEqual({ name: "Acme 2" });

    const logoOnly: Record<string, unknown> = { logo: "https://example.com/logo.png" };
    await organizationHooks.beforeUpdateOrganization({ organization: logoOnly, user: { id: "u1" }, member: {} });
    expect(logoOnly).toEqual({ logo: "https://example.com/logo.png" });

    const err = await organizationHooks
      .beforeUpdateOrganization({ organization: { name: "acme.com/login" }, user: { id: "u1" }, member: {} })
      .catch((e: unknown) => e);
    expect((err as APIError).statusCode).toBe(400);

    // A dot inside a name is fine.
    const brand = { name: "Cal.com" };
    await organizationHooks.beforeUpdateOrganization({ organization: brand, user: { id: "u1" }, member: {} });
    expect(brand).toEqual({ name: "Cal.com" });
  });

  it("workspaceNameOrThrow returns the normalised name", () => {
    expect(workspaceNameOrThrow(" Café  Ünïcode ")).toBe("Café Ünïcode");
    expect(() => workspaceNameOrThrow(undefined)).toThrow(APIError);
  });
});

describe("trustedOrigins (shared with credentialed CORS)", () => {
  const originsFor = async (env: Bindings, requestUrl?: string) => {
    const fn = createAuth(env).options.trustedOrigins as (r?: Request) => Promise<string[]> | string[];
    return [...(await fn(requestUrl ? new Request(requestUrl) : undefined))].sort();
  };

  it("hosted: the app, admin and marketing origins, and no localhost", async () => {
    const env = createTestBindings({ API_BASE_URL: "https://api.gopaylocal.com" });
    expect(await originsFor(env, "https://api.gopaylocal.com/api/auth/sign-in/email")).toEqual([
      "https://admin.gopaylocal.com",
      "https://app.gopaylocal.com",
      "https://gopaylocal.com",
    ]);
  });

  it("self-hosted: the configured origins plus CORS_ALLOWED_ORIGINS, and no gopaylocal.com", async () => {
    const env = createTestBindings({
      SELF_HOSTED: "true",
      API_BASE_URL: "https://api.acme.example",
      APP_BASE_URL: "https://ppp.acme.example/",
      CORS_ALLOWED_ORIGINS: "https://www.acme.example, https://shop.acme.example",
    });
    expect(await originsFor(env, "https://api.acme.example/api/auth/get-session")).toEqual([
      "https://ppp.acme.example",
      "https://shop.acme.example",
      "https://www.acme.example",
    ]);
  });

  it("adds the localhost dev servers only when the API runs locally", async () => {
    const local = await originsFor(createTestBindings(), "http://localhost:8787/api/auth/sign-in/email");
    expect(local).toEqual(expect.arrayContaining(["http://localhost:3000", "http://localhost:3001", "http://localhost:5173"]));

    // No request (auth.api call): API_BASE_URL decides.
    const viaEnv = await originsFor(createTestBindings({ API_BASE_URL: "http://localhost:8787" }));
    expect(viaEnv).toContain("http://localhost:3000");
    const deployed = await originsFor(createTestBindings({ API_BASE_URL: "https://api.gopaylocal.com" }));
    expect(deployed.some((o) => o.includes("localhost"))).toBe(false);
  });
});

describe("Better Auth origin/CSRF check", () => {
  it("is pinned on, so NODE_ENV=test or a TEST variable cannot switch it off", () => {
    expect(createAuth(createTestBindings()).options.advanced?.disableOriginCheck).toBe(false);
  });
});

describe("testUtils plugin", () => {
  const hasTestUtils = (auth: ReturnType<typeof createAuth>) =>
    (auth.options.plugins as AnyPlugin[]).some((p) => p.id === "test-utils");

  it("is off by default, including when the API runs on localhost", () => {
    expect(hasTestUtils(createAuth(createTestBindings()))).toBe(false);
    expect(hasTestUtils(createAuth(createTestBindings({ API_BASE_URL: "http://localhost:8787" })))).toBe(false);
    expect(hasTestUtils(createAuth(createTestBindings(), { allowEmailSignUp: true }))).toBe(false);
  });

  it("is on only with the explicit createAuth option", () => {
    expect(hasTestUtils(createAuth(createTestBindings(), { enableTestUtils: true }))).toBe(true);
  });
});

describe("invitation email", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes the organization name, the inviter and the link", () => {
    const { subject, html } = buildInvitationEmail({
      organizationName: `Acme <a href="https://evil.example">Verify your account</a>`,
      inviterName: `<img src=x onerror=alert(1)>`,
      inviterEmail: "owner@acme.example",
      appUrl: "https://app.gopaylocal.com",
      invitationId: `inv"><script>`,
    });
    expect(html).not.toContain("<a href=\"https://evil.example\"");
    expect(html).not.toContain("<img src=x"); // the layout's own logo is an <img>; the inviter's never is
    expect(html).not.toContain("<script>");
    expect(html).toContain("Join the Acme &lt;a href=&quot;https://evil.example&quot;&gt;Verify your account&lt;/a&gt; workspace");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; (owner@acme.example)</strong> invited you");
    expect(html).toContain('href="https://app.gopaylocal.com/invite/inv%22%3E%3Cscript%3E"');
    // The subject is plain text: no escaping, but no line breaks either.
    expect(subject).toBe(
      `<img src=x onerror=alert(1)> invited you to the Acme <a href="https://evil.example">Verify your account</a> workspace`,
    );
  });

  it("falls back to the inviter's email, flattens control characters and caps the subject", () => {
    const { subject, html } = buildInvitationEmail({
      organizationName: `Line1\r\nBcc: victim@example.test\n${"x".repeat(200)}`,
      inviterName: "",
      inviterEmail: "a&b@acme.example",
      appUrl: "https://app.gopaylocal.com",
      invitationId: "inv_1",
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.length).toBeLessThan(140);
    expect(html).toContain("a&amp;b@acme.example</strong> invited you");
  });

  it("never mails out a stored workspace name that breaks the naming rule", async () => {
    const { sendInvitationEmail } = orgPluginOptions(createTestBindings({ ACS_CONNECTION_STRING: "endpoint=x;accesskey=y" }));
    const invite = (name: string) =>
      sendInvitationEmail({
        id: "inv_1",
        email: "invitee@example.test",
        organization: { name },
        inviter: { user: { name: "Owner", email: "owner@example.test" } },
      });

    sentEmails.length = 0;
    await invite("Pay now at evil.example");
    await invite("Acme Labs");
    await invite("Cal.com"); // a valid name, but a mail client would link it
    await invite("Acme Inc.");
    expect(sentEmails.map((e) => e.subject)).toEqual([
      "Owner invited you to a workspace on GoPayLocal",
      "Owner invited you to the Acme Labs workspace",
      "Owner invited you to a workspace on GoPayLocal",
      "Owner invited you to the Acme Inc. workspace",
    ]);
    expect(sentEmails[0]!.html).not.toContain("evil.example");
    expect(sentEmails[2]!.html).not.toContain("Cal.com");
  });
});

describe("hosted-domain fallbacks (self-hosting)", () => {
  const hosted = (overrides?: Partial<Bindings>) => createTestBindings({ SELF_HOSTED: "false", ...overrides });
  const selfHosted = (overrides?: Partial<Bindings>) => createTestBindings({ SELF_HOSTED: "true", ...overrides });
  const ACS = { ACS_CONNECTION_STRING: "endpoint=x;accesskey=y" };

  async function inviteWith(env: Bindings) {
    const { sendInvitationEmail } = orgPluginOptions(env);
    sentEmails.length = 0;
    await sendInvitationEmail({
      id: "inv_1",
      email: "invitee@example.test",
      organization: { name: "Acme Labs" },
      inviter: { user: { name: "Owner", email: "owner@example.test" } },
    });
    return sentEmails.slice();
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("Better Auth's base URL: hosted falls back to the hosted API; self-hosted never does", () => {
    expect(authBaseURL(hosted({ API_BASE_URL: undefined }))).toBe("https://api.gopaylocal.com");
    expect(authBaseURL(selfHosted({ API_BASE_URL: undefined }))).toBeUndefined();
    expect(authBaseURL(selfHosted({ API_BASE_URL: "https://api.example.com" }))).toBe("https://api.example.com");
    expect(authBaseURL(hosted({ API_BASE_URL: "http://localhost:8787" }))).toBe("http://localhost:8787");
    expect(createAuth(hosted({ API_BASE_URL: undefined })).options.baseURL).toBe("https://api.gopaylocal.com");
    expect(createAuth(selfHosted({ API_BASE_URL: undefined })).options.baseURL).toBeUndefined();
  });

  it("invitation links: hosted falls back to the hosted dashboard; self-hosted never does", () => {
    expect(invitationAppUrl(hosted({ APP_BASE_URL: undefined }))).toBe("https://app.gopaylocal.com");
    expect(invitationAppUrl(selfHosted({ APP_BASE_URL: undefined }))).toBeNull();
    expect(invitationAppUrl(selfHosted({ APP_BASE_URL: "https://app.example.com" }))).toBe("https://app.example.com");
  });

  it("hosted with nothing set: unchanged (hosted sender, hosted dashboard link), replies to support", async () => {
    const [email] = await inviteWith(hosted(ACS));
    expect(email!.senderAddress).toBe("DoNotReply@mail.gopaylocal.com");
    expect(email!.html).toContain('href="https://app.gopaylocal.com/invite/inv_1"');
    expect(email!.text).toContain("https://app.gopaylocal.com/invite/inv_1");
    expect(email!.replyTo).toBe("support@gopaylocal.com");
  });

  it("EMAIL_FROM and APP_BASE_URL are used when set", async () => {
    const [email] = await inviteWith(
      selfHosted({ ...ACS, EMAIL_FROM: "invites@mail.example.com", APP_BASE_URL: "https://app.example.com" }),
    );
    expect(email!.senderAddress).toBe("invites@mail.example.com");
    expect(email!.html).toContain('href="https://app.example.com/invite/inv_1"');
    expect(email!.html).not.toContain("gopaylocal.com/invite");
    // Self-hosted without SUPPORT_EMAIL: no reply-to, never the hosted support address.
    expect(email!.replyTo ?? null).toBeNull();
    expect(email!.html).not.toContain("support@gopaylocal.com");
  });

  it("self-hosted without APP_BASE_URL: no email, with a warning (the link would point at gopaylocal.com)", async () => {
    expect(await inviteWith(selfHosted({ ...ACS, EMAIL_FROM: "invites@mail.example.com", APP_BASE_URL: undefined }))).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("APP_BASE_URL"));
  });

  it("self-hosted without EMAIL_FROM: no email, with a warning (ACS would refuse the hosted sender)", async () => {
    expect(await inviteWith(selfHosted({ ...ACS, APP_BASE_URL: "https://app.example.com" }))).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("EMAIL_FROM"));
  });
});
