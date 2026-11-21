import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  analyticsRollups,
  campaigns,
  invitations,
  memberProductAccess,
  members,
  organizations,
  parityGroups,
  products,
  sessions,
  subscriptions,
  users,
} from "../db/schema";
import { createAuth } from "../auth";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import {
  addMember,
  as,
  seedTenant,
  seedUser,
  signIn,
  type TestTenant,
  type TestUser,
  DASHBOARD_ORIGIN,
} from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Role gates, suspension (ban) and destructive-operation guards, end to end
 * through the full Worker with real Better Auth sessions and real Postgres:
 *
 * - parity-group mutations need admin+ (members may only read)
 * - a ban ends the user's sessions and locks them out of team routes, even
 *   with a still-valid cookie-cached session
 * - the platform-admin gate re-reads role and ban from the user row
 * - a product that is some member's only grant cannot be deleted (deleting it
 *   would cascade the grant away, and zero grants means full access)
 * - admin aggregates come back as JSON numbers, not bigint strings
 */

const DAY_MS = 86_400_000;

interface Session {
  user: TestUser;
  cookie: string;
}

/** A signed-in owner of a Pro org (so product and seat caps don't get in the way). */
async function proTenant(client: TestClient, name: string): Promise<TestTenant> {
  const t = await seedTenant(client, name);
  await getTestDb().insert(subscriptions).values({
    id: ulid(),
    organizationId: t.orgId,
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
  });
  return t;
}

async function joinAs(
  client: TestClient,
  t: TestTenant,
  role: "admin" | "member",
): Promise<Session> {
  const user = await seedUser(client.env, `Org ${role}`);
  await addMember(t.orgId, user.id, role);
  return { user, cookie: await signIn(client, user) };
}

async function platformAdmin(client: TestClient): Promise<Session> {
  const user = await seedUser(client.env, "Platform Admin");
  await getTestDb().update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  return { user, cookie: await signIn(client, user) };
}

async function sessionCount(userId: string) {
  return (await getTestDb().select().from(sessions).where(eq(sessions.userId, userId))).length;
}

async function createProduct(client: TestClient, t: TestTenant, name: string): Promise<string> {
  const res = await client.request(`/v1/teams/${t.orgId}/products`, {
    method: "POST",
    headers: as(t),
    json: { name, url: `https://example.com/${encodeURIComponent(name)}`, basePrice: 10 },
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

/** Set a member's product scope to exactly `productIds` (an empty list means NO products; `{ allProducts: true }` is "all"). */
async function grantProducts(client: TestClient, t: TestTenant, userId: string, productIds: string[]) {
  const res = await client.request(`/v1/teams/${t.orgId}/members/${userId}/product-access`, {
    method: "PUT",
    headers: as(t),
    json: { productIds },
  });
  expect(res.status).toBe(200);
}

async function grantsOf(orgId: string, userId: string) {
  const rows = await getTestDb()
    .select({ productId: memberProductAccess.productId })
    .from(memberProductAccess)
    .where(and(eq(memberProductAccess.organizationId, orgId), eq(memberProductAccess.userId, userId)));
  return rows.map((r) => r.productId).sort();
}

async function productExists(id: string) {
  return (await getTestDb().select().from(products).where(eq(products.id, id))).length === 1;
}

describe("Access control (full Worker)", () => {
  let client: TestClient;

  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  describe("parity groups: members read, admins and owners write", () => {
    it("every parity-group mutation is 403 for a member and changes nothing; an admin may mutate", async () => {
      const t = await proTenant(client, "Tiered Org");
      const P = `/v1/teams/${t.orgId}/parity-groups`;
      const created = await client.request(P, {
        method: "POST",
        headers: as(t),
        json: { name: "Tier 1", discountPercent: 40, sortOrder: 1 },
      });
      expect(created.status).toBe(201);
      const groupId = (await created.json()).data.id;
      await client.request(`${P}/${groupId}/countries`, {
        method: "PUT",
        headers: as(t),
        json: { countries: ["IN"] },
      });

      const member = await joinAs(client, t, "member");
      const list = await client.request(P, { headers: as(member) });
      expect(list.status).toBe(200);
      expect((await list.json()).data).toHaveLength(1);

      const attempts: Array<[string, string, unknown?]> = [
        ["POST", P, { name: "Member tier", discountPercent: 70, sortOrder: 2 }],
        ["PATCH", `${P}/${groupId}`, { discountPercent: 90 }],
        ["PUT", `${P}/${groupId}/countries`, { countries: ["US", "GB"] }],
        ["DELETE", `${P}/${groupId}`],
        ["POST", `${P}/seed-defaults`, {}],
      ];
      for (const [method, path, json] of attempts) {
        const res = await client.request(path, { method, headers: as(member), json });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      }

      const groups = await getTestDb().select().from(parityGroups).where(eq(parityGroups.organizationId, t.orgId));
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ id: groupId, name: "Tier 1", discountPercent: 40 });
      const after = await (await client.request(P, { headers: as(t) })).json();
      expect(after.data[0].countries).toEqual(["IN"]);

      const admin = await joinAs(client, t, "admin");
      const patched = await client.request(`${P}/${groupId}`, {
        method: "PATCH",
        headers: as(admin),
        json: { discountPercent: 45 },
      });
      expect(patched.status).toBe(200);
      const countries = await client.request(`${P}/${groupId}/countries`, {
        method: "PUT",
        headers: as(admin),
        json: { countries: ["br", "IN", "BR"] },
      });
      expect(countries.status).toBe(200);
      const final = await (await client.request(P, { headers: as(admin) })).json();
      expect(final.data[0].discountPercent).toBe(45);
      expect([...final.data[0].countries].sort()).toEqual(["BR", "IN"]);
    });
  });

  describe("suspension (ban)", () => {
    it("an admin ban ends the user's sessions and locks them out of team routes despite the cached session", async () => {
      const t = await proTenant(client, "Org With A Bad Actor");
      const member = await joinAs(client, t, "member");
      const productsPath = `/v1/teams/${t.orgId}/products`;
      expect((await client.request(productsPath, { headers: as(member) })).status).toBe(200);
      // seedUser's sign-up and signIn each created one.
      expect(await sessionCount(member.user.id)).toBeGreaterThan(0);

      const admin = await platformAdmin(client);
      const ban = await client.request(`/v1/admin/users/${member.user.id}/ban`, {
        method: "POST",
        headers: as(admin),
        json: { reason: "abuse" },
      });
      expect(ban.status).toBe(200);
      expect((await ban.json()).data).toMatchObject({ id: member.user.id, banned: true, banReason: "abuse" });
      expect(await sessionCount(member.user.id)).toBe(0);

      // The old cookie still carries a cookie-cached session (Better Auth, up to
      // 5 minutes); the team middleware's ban check is what refuses it.
      const after = await client.request(productsPath, { headers: as(member) });
      expect(after.status).toBe(403);
      expect(await after.json()).toEqual({ error: "Forbidden: account suspended" });

      // The owner is unaffected.
      expect((await client.request(productsPath, { headers: as(t) })).status).toBe(200);
    });

    it("the banned flag alone (no session cleanup) refuses every team route", async () => {
      const t = await proTenant(client, "Flagged Org");
      const member = await joinAs(client, t, "member");
      await getTestDb().update(users).set({ banned: true }).where(eq(users.id, member.user.id));

      for (const path of ["products", "campaigns", "parity-groups", "analytics/overview", "members"]) {
        const res = await client.request(`/v1/teams/${t.orgId}/${path}`, { headers: as(member) });
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
    });

    // Regression tests for the ban bypass (found 2026-11-18, fixed in auth.ts):
    // sign-in used to succeed for banned users, and Better Auth's own routes
    // (/organization/*, /update-user, ...) never read `user.banned`, so a banned
    // owner could invite an unbanned accomplice who then had full access.
    it("a banned user cannot sign in again: 403 ACCOUNT_SUSPENDED and no session", async () => {
      const user = await seedUser(client.env, "Banned User");
      await getTestDb().update(users).set({ banned: true }).where(eq(users.id, user.id));
      await getTestDb().delete(sessions).where(eq(sessions.userId, user.id));

      const res = await client.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: DASHBOARD_ORIGIN },
        json: { email: user.email, password: user.password },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await sessionCount(user.id)).toBe(0);
    });

    it("a banned owner cannot invite people through Better Auth's organization routes", async () => {
      const t = await proTenant(client, "Banned Owner Org");
      await getTestDb().update(users).set({ banned: true }).where(eq(users.id, t.user.id));

      const res = await client.request("/api/auth/organization/invite-member", {
        method: "POST",
        headers: as(t),
        json: { email: "accomplice@example.test", role: "admin", organizationId: t.orgId },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      expect(await getTestDb().select().from(invitations).where(eq(invitations.organizationId, t.orgId))).toEqual([]);
    });

    it("with a cookie from before the ban, Better Auth routes refuse except get-session and sign-out", async () => {
      const t = await proTenant(client, "Cookie Holder Org");
      const member = await joinAs(client, t, "member");
      // Flag only: the session rows and the cookie cache stay valid.
      await getTestDb().update(users).set({ banned: true }).where(eq(users.id, member.user.id));
      const orgsBefore = (await getTestDb().select().from(organizations)).length;

      const create = await client.request("/api/auth/organization/create", {
        method: "POST",
        headers: as(member),
        json: { name: "Fresh Start", slug: `fresh-start-${ulid().toLowerCase()}` },
      });
      expect(create.status).toBe(403);
      expect(await create.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      expect((await getTestDb().select().from(organizations)).length).toBe(orgsBefore);

      const rename = await client.request("/api/auth/update-user", {
        method: "POST",
        headers: as(member),
        json: { name: "x" },
      });
      expect(rename.status).toBe(403);
      expect(await rename.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
      const [row] = await getTestDb().select({ name: users.name }).from(users).where(eq(users.id, member.user.id));
      expect(row?.name).toBe("Org member");

      // /v1 is refused by the session middleware too.
      const team = await client.request(`/v1/teams/${t.orgId}/products`, { headers: as(member) });
      expect(team.status).toBe(403);
      expect(await team.json()).toEqual({ error: "Forbidden: account suspended" });

      // Deliberately unguarded, so the dashboard can show the suspension and sign out.
      expect((await client.request("/api/auth/get-session", { headers: as(member) })).status).not.toBe(403);
      const signOut = await client.request("/api/auth/sign-out", { method: "POST", headers: as(member), json: {} });
      expect(signOut.status).toBe(200);
    });
  });

  describe("Better Auth organization roles and settings", () => {
    async function memberRowId(orgId: string, userId: string) {
      const [row] = await getTestDb()
        .select({ id: members.id, role: members.role })
        .from(members)
        .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)));
      return row!;
    }

    it("organization deletion is disabled, even for the owner", async () => {
      const t = await proTenant(client, "Undeletable Org");
      const res = await client.request("/api/auth/organization/delete", {
        method: "POST",
        headers: as(t),
        json: { organizationId: t.orgId },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" });
      expect(await getTestDb().select().from(organizations).where(eq(organizations.id, t.orgId))).toHaveLength(1);
    });

    it("only the owner can change a member's role", async () => {
      const t = await proTenant(client, "Role Change Org");
      const admin = await joinAs(client, t, "admin");
      const member = await joinAs(client, t, "member");
      const target = await memberRowId(t.orgId, member.user.id);
      const promote = { memberId: target.id, role: "admin", organizationId: t.orgId };

      const byAdmin = await client.request("/api/auth/organization/update-member-role", {
        method: "POST",
        headers: as(admin),
        json: promote,
      });
      expect(byAdmin.status).toBe(403);
      expect((await memberRowId(t.orgId, member.user.id)).role).toBe("member");

      const byOwner = await client.request("/api/auth/organization/update-member-role", {
        method: "POST",
        headers: as(t),
        json: promote,
      });
      expect(byOwner.status).toBe(200);
      expect((await memberRowId(t.orgId, member.user.id)).role).toBe("admin");
    });

    it("a member in good standing still uses the organization routes (set-active, invite, get-full-organization)", async () => {
      const t = await proTenant(client, "Healthy Org");
      const setActive = await client.request("/api/auth/organization/set-active", {
        method: "POST",
        headers: as(t),
        json: { organizationId: t.orgId },
      });
      expect(setActive.status).toBe(200);
      const invite = await client.request("/api/auth/organization/invite-member", {
        method: "POST",
        headers: as(t),
        json: { email: "new-teammate@example.test", role: "member", organizationId: t.orgId },
      });
      expect(invite.status).toBe(200);
      const full = await client.request(`/api/auth/organization/get-full-organization?organizationId=${t.orgId}`, {
        headers: as(t),
      });
      expect(full.status).toBe(200);
      expect((await full.json()).id).toBe(t.orgId);
    });

    // Better Auth would turn its own Origin/CSRF check off under NODE_ENV=test
    // (skipOriginCheck defaults to isTest()); auth.ts pins
    // advanced.disableOriginCheck: false, so these tests exercise the real check.
    it("a deployed API does not list localhost among Better Auth's trusted origins; a local one does", async () => {
      type TrustedOrigins = (request?: Request) => string[] | Promise<string[]>;
      const listFor = async (apiBaseUrl: string) => {
        const auth = createAuth(createTestBindings({ API_BASE_URL: apiBaseUrl }));
        const trusted = auth.options.trustedOrigins as unknown as TrustedOrigins;
        return trusted(new Request(`${apiBaseUrl}/api/auth/sign-in/email`, { method: "POST" }));
      };

      const deployed = await listFor("https://api.gopaylocal.com");
      expect(deployed).toContain("https://app.gopaylocal.com");
      expect(deployed).not.toContain(DASHBOARD_ORIGIN);
      expect(deployed.some((origin) => /localhost|127\.0\.0\.1/.test(origin))).toBe(false);

      const local = await listFor("http://localhost:8787");
      expect(local).toContain(DASHBOARD_ORIGIN);
    });

    it("a deployed API refuses cookie-bearing auth requests from localhost or foreign origins, and foreign callback URLs", async () => {
      const API = "https://api.gopaylocal.com";
      const APP = "https://app.gopaylocal.com";
      const deployed = createTestClient(worker, createTestBindings({ API_BASE_URL: API }));
      const user = await seedUser(deployed.env, "Deployed User");

      const signIn = await deployed.request(`${API}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: APP },
        json: { email: user.email, password: user.password },
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).join("; ");

      const rename = (origin: string | undefined, name: string) =>
        deployed.request(`${API}/api/auth/update-user`, {
          method: "POST",
          headers: origin ? { cookie, origin } : { cookie },
          json: { name },
        });
      for (const origin of [DASHBOARD_ORIGIN, "https://evil.example"]) {
        const res = await rename(origin, `renamed from ${origin}`);
        expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
        expect(await res.json()).toMatchObject({ code: "INVALID_ORIGIN" });
      }
      const noOrigin = await rename(undefined, "renamed with no origin");
      expect(noOrigin.status).toBe(403);
      expect(await noOrigin.json()).toMatchObject({ code: "MISSING_OR_NULL_ORIGIN" });

      const legit = await rename(APP, "renamed from the app");
      expect(legit.status).toBe(200);
      const [row] = await getTestDb().select({ name: users.name }).from(users).where(eq(users.id, user.id));
      expect(row?.name).toBe("renamed from the app");

      // Open-redirect guard: a callbackURL outside the trusted origins is refused.
      const evilCallback = await deployed.request(`${API}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: APP },
        json: { email: user.email, password: user.password, callbackURL: "https://evil.example/landing" },
      });
      expect(evilCallback.status).toBe(403);
      expect(await evilCallback.json()).toMatchObject({ code: "INVALID_CALLBACK_URL" });

      // Login CSRF: a cross-site fetch (Fetch Metadata present, no cookie yet) from a foreign origin.
      const crossSiteLogin = await deployed.request(`${API}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
        json: { email: user.email, password: user.password },
      });
      expect(crossSiteLogin.status).toBe(403);
      expect(await crossSiteLogin.json()).toMatchObject({ code: "INVALID_ORIGIN" });
    });
  });

  describe("platform admin gate re-reads the user row", () => {
    it("a non-admin is refused; an admin demoted or banned in the database loses access on the next request", async () => {
      const outsider = await seedUser(client.env, "Not An Admin");
      const outsiderCookie = await signIn(client, outsider);
      expect((await client.request("/v1/admin/stats", { headers: as({ cookie: outsiderCookie }) })).status).toBe(403);

      const admin = await platformAdmin(client);
      expect((await client.request("/v1/admin/stats", { headers: as(admin) })).status).toBe(200);

      // Demoted: the cookie-cached session still says role "admin".
      await getTestDb().update(users).set({ role: "user" }).where(eq(users.id, admin.user.id));
      expect((await client.request("/v1/admin/stats", { headers: as(admin) })).status).toBe(403);

      const second = await platformAdmin(client);
      expect((await client.request("/v1/admin/stats", { headers: as(second) })).status).toBe(200);
      await getTestDb().update(users).set({ banned: true }).where(eq(users.id, second.user.id));
      expect((await client.request("/v1/admin/stats", { headers: as(second) })).status).toBe(403);
      const ban = await client.request(`/v1/admin/users/${outsider.id}/ban`, {
        method: "POST",
        headers: as(second),
        json: {},
      });
      expect(ban.status).toBe(403);
      const [row] = await getTestDb().select({ banned: users.banned }).from(users).where(eq(users.id, outsider.id));
      expect(row?.banned).not.toBe(true);
    });
  });

  describe("product delete guard", () => {
    // Wave C (authz-audit): the `last_product_grant` 409 is gone. A member's
    // scope is explicit now (member_product_scopes), so deleting their last
    // listed product leaves them with NO products, never all, and members can
    // no longer delete products at all (403). permissions.integration.test.ts
    // covers both; this keeps the grant clean-up for a member with several.
    it("the owner deletes a product a member is granted: that grant goes, the member's other grants stay", async () => {
      const t = await proTenant(client, "Owner Delete Org");
      const first = await createProduct(client, t, "First");
      const second = await createProduct(client, t, "Second");
      await createProduct(client, t, "Third");
      const member = await joinAs(client, t, "member");
      await grantProducts(client, t, member.user.id, [first, second]);

      const ok = await client.request(`/v1/teams/${t.orgId}/products/${first}`, {
        method: "DELETE",
        headers: as(t),
      });
      expect(ok.status).toBe(200);
      expect(await productExists(first)).toBe(false);
      expect(await grantsOf(t.orgId, member.user.id)).toEqual([second]);

      // Still exactly the one remaining grant: not widened to "Third".
      const list = await (await client.request(`/v1/teams/${t.orgId}/products`, { headers: as(member) })).json();
      expect(list.data.map((p: { id: string }) => p.id)).toEqual([second]);
    });

    it("a product that still has campaigns answers 409 product_in_use instead of 500", async () => {
      const t = await proTenant(client, "In Use Org");
      const productId = await createProduct(client, t, "Has Campaigns");
      const campaign = await client.request(`/v1/teams/${t.orgId}/campaigns`, {
        method: "POST",
        headers: as(t),
        json: { productId, name: "Running" },
      });
      expect(campaign.status).toBe(201);

      const res = await client.request(`/v1/teams/${t.orgId}/products/${productId}`, {
        method: "DELETE",
        headers: as(t),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "product_in_use" });
      expect(await productExists(productId)).toBe(true);
      expect(
        await getTestDb().select().from(campaigns).where(eq(campaigns.productId, productId)),
      ).toHaveLength(1);
    });
  });

  describe("admin aggregates and query parsing", () => {
    it("platform stats and top orgs return JSON numbers; bad ?limit falls back", async () => {
      const t = await proTenant(client, "Busy Org");
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      await getTestDb().insert(analyticsRollups).values([
        { id: ulid(), organizationId: t.orgId, campaignId: "camp-x", countryCode: "IN", period: "day",
          periodStart: today, impressions: 5, clicks: 2, copies: 1, redemptions: 1, revenueSaved: 12.5 },
        { id: ulid(), organizationId: t.orgId, campaignId: "camp-x", countryCode: "BR", period: "day",
          periodStart: today, impressions: 7, clicks: 1, copies: 0, redemptions: 0, revenueSaved: 0 },
      ]);
      const admin = await platformAdmin(client);

      const stats = await client.request("/v1/admin/stats", { headers: as(admin) });
      expect(stats.status).toBe(200);
      const data = (await stats.json()).data;
      expect(data.platformFunnel).toEqual({ impressions: 12, clicks: 3, copies: 1, redemptions: 1, revenueSaved: 12.5 });
      for (const key of ["totalUsers", "totalOrganizations", "activeOrgsLast30Days", "totalRevenueSaved",
        "totalProducts", "totalCampaigns", "activeCampaigns", "estimatedMRR"]) {
        expect({ key, type: typeof data[key] }).toEqual({ key, type: "number" });
      }
      expect(data.activeOrgsLast30Days).toBe(1);
      expect(data.subscriptionsByPlan.pro).toBe(1);

      const top = await client.request("/v1/admin/stats/top-orgs?limit=abc", { headers: as(admin) });
      expect(top.status).toBe(200);
      const [org] = (await top.json()).data;
      expect(org).toMatchObject({ organizationId: t.orgId, impressions: 12, clicks: 3, redemptions: 1, revenueSaved: 12.5 });

      const userList = await client.request("/v1/admin/users?page=abc&limit=xyz", { headers: as(admin) });
      expect(userList.status).toBe(200);
      expect((await userList.json()).pagination).toMatchObject({ page: 1, limit: 50 });
    });

    it("an unparseable analytics ?from= falls back to the retention window instead of a 500", async () => {
      const t = await proTenant(client, "Odd Query Org");
      const res = await client.request(`/v1/teams/${t.orgId}/analytics/overview?from=not-a-date`, {
        headers: as(t),
      });
      expect(res.status).toBe(200);
    });
  });
});
