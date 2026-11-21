import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  campaigns,
  experiments,
  invitations,
  memberProductAccess,
  memberProductScopes,
  members,
  organizations,
  products,
  subscriptions,
} from "../db/schema";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { addMember, as, seedTenant, seedUser, signIn, type TestTenant, type TestUser } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * The permission model end to end (full Worker, real Better Auth sessions,
 * real Postgres): explicit member product access (none / some / all), grants
 * removed with the membership, and each owner/admin decision in the
 * permission table (packages/shared/src/permissions).
 */

const DAY_MS = 86_400_000;

interface Session {
  user: TestUser;
  cookie: string;
}

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

async function joinAs(client: TestClient, t: TestTenant, role: "admin" | "member", name = `Org ${role}`): Promise<Session> {
  const user = await seedUser(client.env, name);
  await addMember(t.orgId, user.id, role);
  return { user, cookie: await signIn(client, user) };
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

async function createCampaign(client: TestClient, t: TestTenant, productId: string, name: string): Promise<string> {
  const res = await client.request(`/v1/teams/${t.orgId}/campaigns`, {
    method: "POST",
    headers: as(t),
    json: { productId, name },
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

async function setAccess(client: TestClient, t: TestTenant, userId: string, body: unknown) {
  return client.request(`/v1/teams/${t.orgId}/members/${userId}/product-access`, {
    method: "PUT",
    headers: as(t),
    json: body,
  });
}

async function listedProducts(client: TestClient, t: TestTenant, who: Session) {
  const res = await client.request(`/v1/teams/${t.orgId}/products`, { headers: as(who) });
  expect(res.status).toBe(200);
  return ((await res.json()).data as Array<{ id: string }>).map((p) => p.id).sort();
}

async function listedCampaigns(client: TestClient, t: TestTenant, who: Session) {
  const res = await client.request(`/v1/teams/${t.orgId}/campaigns`, { headers: as(who) });
  expect(res.status).toBe(200);
  return ((await res.json()).data as Array<{ id: string }>).map((c) => c.id).sort();
}

async function memberRow(orgId: string, userId: string) {
  const [row] = await getTestDb()
    .select()
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)));
  return row;
}

async function scopeRows(orgId: string) {
  return getTestDb().select().from(memberProductScopes).where(eq(memberProductScopes.organizationId, orgId));
}

async function grantRows(orgId: string) {
  return getTestDb().select().from(memberProductAccess).where(eq(memberProductAccess.organizationId, orgId));
}

async function invite(client: TestClient, who: Pick<TestTenant, "cookie">, orgId: string, email: string) {
  return client.request("/api/auth/organization/invite-member", {
    method: "POST",
    headers: as(who),
    json: { email, role: "member", organizationId: orgId },
  });
}

describe("Permissions (full Worker)", () => {
  let client: TestClient;

  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  describe("member product access: all, some, none", () => {
    it("a new member has all products by default; an explicit 'all' is the same", async () => {
      const t = await proTenant(client, "Default Scope Org");
      const p1 = await createProduct(client, t, "One");
      const p2 = await createProduct(client, t, "Two");
      const member = await joinAs(client, t, "member");

      expect(await listedProducts(client, t, member)).toEqual([p1, p2].sort());

      const res = await setAccess(client, t, member.user.id, { allProducts: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { allProducts: true, productIds: [] } });
      expect(await listedProducts(client, t, member)).toEqual([p1, p2].sort());
    });

    it("some: the member sees, edits and runs campaigns only on the listed products", async () => {
      const t = await proTenant(client, "Some Scope Org");
      const p1 = await createProduct(client, t, "Mine");
      const p2 = await createProduct(client, t, "Not Mine");
      const c1 = await createCampaign(client, t, p1, "Mine Campaign");
      const c2 = await createCampaign(client, t, p2, "Other Campaign");
      const member = await joinAs(client, t, "member");

      expect((await setAccess(client, t, member.user.id, { productIds: [p1] })).status).toBe(200);

      expect(await listedProducts(client, t, member)).toEqual([p1]);
      expect(await listedCampaigns(client, t, member)).toEqual([c1]);
      expect((await client.request(`/v1/teams/${t.orgId}/products/${p2}`, { headers: as(member) })).status).toBe(404);
      const edit = await client.request(`/v1/teams/${t.orgId}/products/${p2}`, {
        method: "PATCH",
        headers: as(member),
        json: { name: "Hijacked" },
      });
      expect(edit.status).toBe(404);
      const create = await client.request(`/v1/teams/${t.orgId}/campaigns`, {
        method: "POST",
        headers: as(member),
        json: { productId: p2, name: "Sneaky" },
      });
      expect(create.status).toBe(403);
      expect((await client.request(`/v1/teams/${t.orgId}/campaigns/${c2}`, { headers: as(member) })).status).toBe(404);

      // In scope, the member works normally.
      const own = await client.request(`/v1/teams/${t.orgId}/products/${p1}`, {
        method: "PATCH",
        headers: as(member),
        json: { name: "Mine, renamed" },
      });
      expect(own.status).toBe(200);
    });

    it("none: an empty list gives the member no products and no campaigns (never all)", async () => {
      const t = await proTenant(client, "No Scope Org");
      const p1 = await createProduct(client, t, "Hidden");
      await createCampaign(client, t, p1, "Hidden Campaign");
      const member = await joinAs(client, t, "member");

      const res = await setAccess(client, t, member.user.id, { productIds: [] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { allProducts: false, productIds: [] } });

      expect(await listedProducts(client, t, member)).toEqual([]);
      expect(await listedCampaigns(client, t, member)).toEqual([]);
      expect((await client.request(`/v1/teams/${t.orgId}/products/${p1}`, { headers: as(member) })).status).toBe(404);

      const read = await client.request(`/v1/teams/${t.orgId}/members/${member.user.id}/product-access`, { headers: as(t) });
      expect(await read.json()).toEqual({ data: { allProducts: false, productIds: [] } });
    });

    it("deleting a member's last listed product leaves them with none, not all", async () => {
      const t = await proTenant(client, "Shrinking Scope Org");
      const only = await createProduct(client, t, "Only");
      const other = await createProduct(client, t, "Other");
      const member = await joinAs(client, t, "member");
      expect((await setAccess(client, t, member.user.id, { productIds: [only] })).status).toBe(200);

      const del = await client.request(`/v1/teams/${t.orgId}/products/${only}`, { method: "DELETE", headers: as(t) });
      expect(del.status).toBe(200);

      expect(await listedProducts(client, t, member)).toEqual([]);
      expect(await listedProducts(client, t, t)).toEqual([other]);
    });

    it("grant rows carry the member id", async () => {
      const t = await proTenant(client, "Member Id Org");
      const p1 = await createProduct(client, t, "One");
      const member = await joinAs(client, t, "member");
      await setAccess(client, t, member.user.id, { productIds: [p1] });

      const m = await memberRow(t.orgId, member.user.id);
      expect((await grantRows(t.orgId)).map((g) => [g.memberId, g.productId])).toEqual([[m!.id, p1]]);
      expect((await scopeRows(t.orgId)).map((s) => [s.memberId, s.allProducts])).toEqual([[m!.id, false]]);
    });
  });

  describe("grants are removed with the membership", () => {
    it("remove-member by the owner deletes the member's scope and grants; rejoining starts from all products", async () => {
      const t = await proTenant(client, "Removal Org");
      const p1 = await createProduct(client, t, "One");
      const p2 = await createProduct(client, t, "Two");
      const member = await joinAs(client, t, "member");
      await setAccess(client, t, member.user.id, { productIds: [p1] });
      expect(await grantRows(t.orgId)).toHaveLength(1);

      const res = await client.request("/api/auth/organization/remove-member", {
        method: "POST",
        headers: as(t),
        json: { memberIdOrEmail: member.user.email, organizationId: t.orgId },
      });
      expect(res.status).toBe(200);
      expect(await memberRow(t.orgId, member.user.id)).toBeUndefined();
      expect(await grantRows(t.orgId)).toEqual([]);
      expect(await scopeRows(t.orgId)).toEqual([]);

      await addMember(t.orgId, member.user.id, "member");
      expect(await listedProducts(client, t, member)).toEqual([p1, p2].sort());
    });

    it("leaving the workspace deletes the member's scope and grants too", async () => {
      const t = await proTenant(client, "Leave Org");
      const p1 = await createProduct(client, t, "One");
      const member = await joinAs(client, t, "member");
      await setAccess(client, t, member.user.id, { productIds: [p1] });

      const res = await client.request("/api/auth/organization/leave", {
        method: "POST",
        headers: as(member),
        json: { organizationId: t.orgId },
      });
      expect(res.status).toBe(200);
      expect(await grantRows(t.orgId)).toEqual([]);
      expect(await scopeRows(t.orgId)).toEqual([]);
    });
  });

  describe("decisions: what admins can and cannot do", () => {
    it("an admin cannot remove a member or another admin; the owner can", async () => {
      const t = await proTenant(client, "Admin Remove Org");
      const admin = await joinAs(client, t, "admin", "Admin One");
      const otherAdmin = await joinAs(client, t, "admin", "Admin Two");
      const member = await joinAs(client, t, "member");

      for (const target of [member, otherAdmin]) {
        const res = await client.request("/api/auth/organization/remove-member", {
          method: "POST",
          headers: as(admin),
          json: { memberIdOrEmail: target.user.email, organizationId: t.orgId },
        });
        // Better Auth 1.7 answers a missing member:delete with 401 (not 403).
        // The code pins it to that permission refusal, so a plain sign-in
        // failure (also 401) cannot pass as one.
        expect({ target: target.user.email, status: res.status, body: await res.json() }).toMatchObject({
          target: target.user.email,
          status: 401,
          body: { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER" },
        });
        expect(await memberRow(t.orgId, target.user.id)).toBeDefined();
      }

      const byOwner = await client.request("/api/auth/organization/remove-member", {
        method: "POST",
        headers: as(t),
        json: { memberIdOrEmail: otherAdmin.user.email, organizationId: t.orgId },
      });
      expect(byOwner.status).toBe(200);
      expect(await memberRow(t.orgId, otherAdmin.user.id)).toBeUndefined();
    });

    it("an admin cannot cancel the owner's invitation or see invitation links; the owner can", async () => {
      const t = await proTenant(client, "Admin Cancel Org");
      const admin = await joinAs(client, t, "admin");
      const sent = await invite(client, t, t.orgId, "invitee@example.test");
      expect(sent.status).toBe(200);
      const [pending] = await getTestDb().select().from(invitations).where(eq(invitations.organizationId, t.orgId));
      const invitationId = pending!.id;

      const byAdmin = await client.request("/api/auth/organization/cancel-invitation", {
        method: "POST",
        headers: as(admin),
        json: { invitationId },
      });
      expect(byAdmin.status).toBe(403);
      expect(await byAdmin.json()).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION" });
      const [still] = await getTestDb().select().from(invitations).where(eq(invitations.id, invitationId));
      expect(still?.status).toBe("pending");

      const list = await client.request(`/v1/teams/${t.orgId}/invitations`, { headers: as(admin) });
      expect(list.status).toBe(403);
      expect(await list.text()).not.toContain(invitationId);

      const byOwner = await client.request("/api/auth/organization/cancel-invitation", {
        method: "POST",
        headers: as(t),
        json: { invitationId },
      });
      expect(byOwner.status).toBe(200);
      const [canceled] = await getTestDb().select().from(invitations).where(eq(invitations.id, invitationId));
      expect(canceled?.status).toBe("canceled");
    });

    it("invites stay owner-only", async () => {
      const t = await proTenant(client, "Admin Invite Org");
      const admin = await joinAs(client, t, "admin");
      const res = await invite(client, admin, t.orgId, "x@example.test");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION" });
      expect(await getTestDb().select().from(invitations).where(eq(invitations.organizationId, t.orgId))).toEqual([]);
    });

    it("an admin cannot rename the workspace; the owner can, within the naming rule", async () => {
      const t = await proTenant(client, "Rename Org");
      const admin = await joinAs(client, t, "admin");
      const rename = (who: Pick<TestTenant, "cookie">, name: string) =>
        client.request("/api/auth/organization/update", {
          method: "POST",
          headers: as(who),
          json: { organizationId: t.orgId, data: { name } },
        });
      const nameNow = async () =>
        (await getTestDb().select().from(organizations).where(eq(organizations.id, t.orgId)))[0]?.name;

      const byAdmin = await rename(admin, "Admin Was Here");
      expect(byAdmin.status).toBe(403);
      expect(await byAdmin.json()).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION" });
      expect(await nameNow()).toBe("Rename Org");

      for (const link of ["Claim your refund at www.evil.example", "evil.example/refund", "https://evil.example"]) {
        const bad = await rename(t, link);
        expect({ link, status: bad.status }).toEqual({ link, status: 400 });
        expect(await bad.json()).toMatchObject({ code: "INVALID_WORKSPACE_NAME" });
        expect(await nameNow()).toBe("Rename Org");
      }

      // Dots inside a name are fine (brand names like Cal.com).
      expect((await rename(t, "Cal.com")).status).toBe(200);
      expect(await nameNow()).toBe("Cal.com");

      expect((await rename(t, "  Renamed   Org ")).status).toBe(200);
      expect(await nameNow()).toBe("Renamed Org");
    });

    it("the naming rule applies when a workspace is created, and the stored name is normalised", async () => {
      const t = await proTenant(client, "Creator Org");
      const create = (name: string) =>
        client.request("/api/auth/organization/create", {
          method: "POST",
          headers: as(t),
          json: { name, slug: `ws-${ulid().toLowerCase()}` },
        });
      const before = (await getTestDb().select().from(organizations)).length;

      const bad = await create("Bank‮txt.exe");
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ code: "INVALID_WORKSPACE_NAME" });
      expect((await getTestDb().select().from(organizations)).length).toBe(before);

      const ok = await create("  Second   Workspace ");
      expect(ok.status).toBe(200);
      const created = (await ok.json()) as { id: string; name: string };
      expect(created.name).toBe("Second Workspace");
      const [row] = await getTestDb().select().from(organizations).where(eq(organizations.id, created.id));
      expect(row?.name).toBe("Second Workspace");

      // A name written only in a non-Latin script is accepted.
      const japanese = await create("株式会社テスト");
      expect(japanese.status).toBe(200);
      expect(((await japanese.json()) as { name: string }).name).toBe("株式会社テスト");
    });

    it("an admin cannot change a member's product access but can read it", async () => {
      const t = await proTenant(client, "Admin Access Org");
      const admin = await joinAs(client, t, "admin");
      const member = await joinAs(client, t, "member");

      expect((await setAccess(client, { ...t, cookie: admin.cookie }, member.user.id, { productIds: [] })).status).toBe(403);
      expect(await scopeRows(t.orgId)).toEqual([]);
      const read = await client.request(`/v1/teams/${t.orgId}/members/${member.user.id}/product-access`, { headers: as(admin) });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ data: { allProducts: true, productIds: [] } });
    });

    it("members cannot add or delete products; admins can", async () => {
      const t = await proTenant(client, "Catalog Org");
      const admin = await joinAs(client, t, "admin");
      const member = await joinAs(client, t, "member");
      const body = { name: "New", url: "https://example.com/new", basePrice: 5 };

      const byMember = await client.request(`/v1/teams/${t.orgId}/products`, { method: "POST", headers: as(member), json: body });
      expect(byMember.status).toBe(403);
      const byAdmin = await client.request(`/v1/teams/${t.orgId}/products`, { method: "POST", headers: as(admin), json: body });
      expect(byAdmin.status).toBe(201);
      const id = (await byAdmin.json()).data.id as string;

      expect((await client.request(`/v1/teams/${t.orgId}/products/${id}`, { method: "DELETE", headers: as(member) })).status).toBe(403);
      expect((await client.request(`/v1/teams/${t.orgId}/products/${id}`, { method: "DELETE", headers: as(admin) })).status).toBe(200);
    });

    it("only the owner deletes the workspace", async () => {
      const t = await proTenant(client, "Delete Rights Org");
      const admin = await joinAs(client, t, "admin");
      expect((await client.request(`/v1/teams/${t.orgId}`, { method: "DELETE", headers: as(admin) })).status).toBe(403);
      expect(await getTestDb().select().from(organizations).where(eq(organizations.id, t.orgId))).toHaveLength(1);
    });
  });

  describe("workspace delete", () => {
    it("removes a running experiment, scopes and grants with the workspace", async () => {
      const t = await proTenant(client, "Doomed Org");
      const p1 = await createProduct(client, t, "One");
      const a = await createCampaign(client, t, p1, "Arm A");
      const b = await createCampaign(client, t, p1, "Arm B");
      await getTestDb().insert(experiments).values({
        id: ulid(),
        organizationId: t.orgId,
        productId: p1,
        environment: "live",
        name: "Price test",
        status: "running",
        campaignAId: a,
        campaignBId: b,
        campaignAName: "Arm A",
        campaignBName: "Arm B",
      });
      const member = await joinAs(client, t, "member");
      await setAccess(client, t, member.user.id, { productIds: [p1] });

      const res = await client.request(`/v1/teams/${t.orgId}`, { method: "DELETE", headers: as(t) });
      expect(res.status).toBe(200);

      const db = getTestDb();
      expect(await db.select().from(experiments).where(eq(experiments.organizationId, t.orgId))).toEqual([]);
      expect(await db.select().from(campaigns).where(eq(campaigns.organizationId, t.orgId))).toEqual([]);
      expect(await db.select().from(products).where(eq(products.organizationId, t.orgId))).toEqual([]);
      expect(await scopeRows(t.orgId)).toEqual([]);
      expect(await grantRows(t.orgId)).toEqual([]);
      expect(await db.select().from(organizations).where(eq(organizations.id, t.orgId))).toEqual([]);
    });

    it("is refused while the Dodo subscription renews (nothing deleted), and goes ahead once it is set to end", async () => {
      const t = await seedTenant(client, "Paying Org");
      await getTestDb().insert(subscriptions).values({
        id: ulid(),
        organizationId: t.orgId,
        plan: "pro",
        status: "active",
        dodoSubId: "sub_paying",
        currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
      });
      const p1 = await createProduct(client, t, "Kept");

      // No real Dodo call: answer the subscription lookup, refuse anything else.
      let dodoAnswer = { status: "active", cancel_at_next_billing_date: false };
      const dodoCalls: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith("https://live.dodopayments.com/subscriptions/")) throw new Error(`unexpected fetch ${url}`);
        dodoCalls.push(url);
        return new Response(JSON.stringify(dodoAnswer), { status: 200 });
      });
      try {
        const refused = await client.request(`/v1/teams/${t.orgId}`, { method: "DELETE", headers: as(t) });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: "subscription_renews" });
        expect(dodoCalls).toEqual(["https://live.dodopayments.com/subscriptions/sub_paying"]);
        const db = getTestDb();
        expect(await db.select().from(organizations).where(eq(organizations.id, t.orgId))).toHaveLength(1);
        expect(await db.select().from(products).where(eq(products.id, p1))).toHaveLength(1);
        expect(await db.select().from(subscriptions).where(eq(subscriptions.organizationId, t.orgId))).toHaveLength(1);

        // The owner cancels at the period end in Dodo's portal; Dodo keeps it active with the flag.
        dodoAnswer = { status: "active", cancel_at_next_billing_date: true };
        const deleted = await client.request(`/v1/teams/${t.orgId}`, { method: "DELETE", headers: as(t) });
        expect(deleted.status).toBe(200);
        expect(await db.select().from(organizations).where(eq(organizations.id, t.orgId))).toEqual([]);
        expect(await db.select().from(subscriptions).where(eq(subscriptions.organizationId, t.orgId))).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
