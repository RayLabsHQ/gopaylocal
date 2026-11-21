import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  analyticsRollups,
  apiKeys,
  bannerConfigs,
  campaigns,
  countryParityMappings,
  coupons,
  integrations,
  invitations,
  memberProductAccess,
  memberProductScopes,
  members,
  organizations,
  parityGroups,
  products,
  users,
} from "../db/schema";
import { encrypt, tokenEncryptionSecret } from "../lib/crypto";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { addMember, as, seedTenant, seedUser, DASHBOARD_ORIGIN, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

// index.ts pulls in the banner route, which imports the browser bundle as a
// wrangler text module; stub it so browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Cross-tenant isolation through the real Worker: real Better Auth sessions,
 * the real session + team middleware, real routes, real Postgres. Org A's
 * owner attacks org B two ways:
 *  1. through org B's URL (/v1/teams/B/...): the team middleware must answer 403;
 *  2. through org A's own URL with org B's record ids (/v1/teams/A/x/<B id>):
 *     every route must scope its query by org and answer 404, changing nothing.
 */

interface OrgBResources {
  productId: string;
  campaignId: string;
  groupId: string;
  integrationId: string;
  keyId: string;
  rawKey: string;
}

let client: TestClient;
let a: TestTenant;
let b: TestTenant;
let bRes: OrgBResources;

async function seedOrgBResources(): Promise<OrgBResources> {
  const db = getTestDb();
  const req = (path: string, init: Parameters<TestClient["request"]>[1] = {}) =>
    client.request(`/v1/teams/${b.orgId}${path}`, { ...init, headers: as(b) });

  const product = await (
    await req("/products", {
      method: "POST",
      json: { name: "B Product", url: "https://b.example.com", basePrice: 50 },
    })
  ).json();
  const productId = product.data.id as string;

  const group = await (
    await req("/parity-groups", {
      method: "POST",
      json: { name: "B Tier", discountPercent: 40, sortOrder: 1 },
    })
  ).json();
  const groupId = group.data.id as string;
  await req(`/parity-groups/${groupId}/countries`, { method: "PUT", json: { countries: ["IN"] } });

  // Seeded directly: connecting through the route would call the real
  // provider's API to provision a webhook.
  const integrationId = ulid();
  await db.insert(integrations).values({
    id: integrationId,
    organizationId: b.orgId,
    provider: "stripe",
    liveAccessTokenEnc: await encrypt("sk_test_org_b", tokenEncryptionSecret(client.env)),
    status: "active",
  });

  const campaign = await (
    await req("/campaigns", {
      method: "POST",
      json: { productId, name: "B Campaign", status: "active" },
    })
  ).json();
  const campaignId = campaign.data.id as string;
  await db.insert(coupons).values([
    { id: ulid(), campaignId, integrationId, countryCode: "IN", code: `B-IN-${ulid()}`, discountPercent: 40 },
    { id: ulid(), campaignId, integrationId, countryCode: "BR", code: `B-BR-${ulid()}`, discountPercent: 40 },
  ]);

  const key = await (await req("/api-keys", { method: "POST", json: { name: "B Key", keyType: "public" } })).json();

  await db.insert(analyticsRollups).values({
    id: ulid(),
    organizationId: b.orgId,
    campaignId,
    countryCode: "IN",
    period: "day",
    periodStart: new Date(),
    impressions: 7,
  });

  return { productId, campaignId, groupId, integrationId, keyId: key.data.id, rawKey: key.data.key };
}

/** Row counts of everything org B owns, to prove an attack changed nothing. */
async function orgBSnapshot() {
  const db = getTestDb();
  const count = async (q: Promise<unknown[]>) => (await q).length;
  return {
    org: await count(db.select().from(organizations).where(eq(organizations.id, b.orgId))),
    products: await count(db.select().from(products).where(eq(products.organizationId, b.orgId))),
    campaigns: await count(db.select().from(campaigns).where(eq(campaigns.organizationId, b.orgId))),
    bannerConfigs: await count(
      db.select().from(bannerConfigs).where(eq(bannerConfigs.campaignId, bRes.campaignId)),
    ),
    coupons: await count(db.select().from(coupons).where(eq(coupons.campaignId, bRes.campaignId))),
    groups: await count(db.select().from(parityGroups).where(eq(parityGroups.organizationId, b.orgId))),
    countries: await count(
      db.select().from(countryParityMappings).where(eq(countryParityMappings.parityGroupId, bRes.groupId)),
    ),
    integrations: await count(
      db.select().from(integrations).where(eq(integrations.organizationId, b.orgId)),
    ),
    apiKeys: await count(db.select().from(apiKeys).where(eq(apiKeys.organizationId, b.orgId))),
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

const EXPECTED_B = {
  org: 1,
  products: 1,
  campaigns: 1,
  bannerConfigs: 1,
  coupons: 2,
  groups: 1,
  countries: 1,
  integrations: 1,
  apiKeys: 1,
};

describe("Tenant isolation (full Worker, real sessions)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
    a = await seedTenant(client, "Org A");
    b = await seedTenant(client, "Org B");
    bRes = await seedOrgBResources();
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("rejects requests without a session (401)", async () => {
    const res = await client.request(`/v1/teams/${a.orgId}/products`);
    expect(res.status).toBe(401);
  });

  it("keeps public email sign-up disabled through the Worker", async () => {
    const email = `intruder-${ulid().toLowerCase()}@example.test`;
    const res = await client.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: DASHBOARD_ORIGIN },
      json: { email, password: "a-long-enough-password-123", name: "Intruder" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await getTestDb().select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  it("answers 403 on every org B route to a member of org A, and changes nothing", async () => {
    const B = `/v1/teams/${b.orgId}`;
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `${B}/products`],
      ["POST", `${B}/products`, { name: "x", url: "https://x.example.com", basePrice: 1 }],
      ["GET", `${B}/products/${bRes.productId}`],
      ["PATCH", `${B}/products/${bRes.productId}`, { name: "pwned" }],
      ["DELETE", `${B}/products/${bRes.productId}`],
      ["GET", `${B}/campaigns`],
      ["GET", `${B}/campaigns/${bRes.campaignId}`],
      ["PATCH", `${B}/campaigns/${bRes.campaignId}`, { status: "paused" }],
      ["DELETE", `${B}/campaigns/${bRes.campaignId}`],
      ["GET", `${B}/banner-configs/${bRes.campaignId}`],
      ["PUT", `${B}/banner-configs/${bRes.campaignId}`, { ctaText: "pwned" }],
      ["GET", `${B}/parity-groups`],
      ["PUT", `${B}/parity-groups/${bRes.groupId}/countries`, { countries: ["US"] }],
      ["DELETE", `${B}/parity-groups/${bRes.groupId}`],
      ["GET", `${B}/integrations`],
      ["DELETE", `${B}/integrations/${bRes.integrationId}`],
      ["GET", `${B}/api-keys`],
      ["POST", `${B}/api-keys`, { name: "x", keyType: "secret" }],
      ["DELETE", `${B}/api-keys/${bRes.keyId}`],
      ["GET", `${B}/analytics/overview`],
      ["GET", `${B}/members`],
      ["GET", `${B}/billing/usage`],
      ["DELETE", B],
    ];
    for (const [method, path, json] of attempts) {
      const res = await client.request(path, { method, headers: as(a), json });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("scopes product reads and writes by org: B's product via A's path is 404 and unchanged", async () => {
    const A = `/v1/teams/${a.orgId}`;
    expect((await client.request(`${A}/products/${bRes.productId}`, { headers: as(a) })).status).toBe(404);
    expect(
      (await client.request(`${A}/products/${bRes.productId}`, {
        method: "PATCH",
        headers: as(a),
        json: { name: "pwned" },
      })).status,
    ).toBe(404);
    expect(
      (await client.request(`${A}/products/${bRes.productId}`, { method: "DELETE", headers: as(a) })).status,
    ).toBe(404);

    const list = await (await client.request(`${A}/products`, { headers: as(a) })).json();
    expect(list.data).toEqual([]);
    const [row] = await getTestDb().select().from(products).where(eq(products.id, bRes.productId));
    expect(row!.name).toBe("B Product");
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("scopes campaigns and banner configs by org", async () => {
    const A = `/v1/teams/${a.orgId}`;
    expect((await client.request(`${A}/campaigns/${bRes.campaignId}`, { headers: as(a) })).status).toBe(404);
    expect(
      (await client.request(`${A}/campaigns/${bRes.campaignId}`, {
        method: "PATCH",
        headers: as(a),
        json: { name: "pwned", status: "paused" },
      })).status,
    ).toBe(404);
    expect((await client.request(`${A}/banner-configs/${bRes.campaignId}`, { headers: as(a) })).status).toBe(404);
    expect(
      (await client.request(`${A}/banner-configs/${bRes.campaignId}`, {
        method: "PUT",
        headers: as(a),
        json: { ctaText: "pwned" },
      })).status,
    ).toBe(404);

    const list = await (await client.request(`${A}/campaigns`, { headers: as(a) })).json();
    expect(list.data).toEqual([]);
    const db = getTestDb();
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, bRes.campaignId));
    expect(camp).toMatchObject({ name: "B Campaign", status: "active" });
    const [banner] = await db.select().from(bannerConfigs).where(eq(bannerConfigs.campaignId, bRes.campaignId));
    expect(banner!.ctaText).not.toBe("pwned");
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  // Regression: the DELETE handler once deleted coupons and banner_configs by
  // campaign id alone before the org-scoped campaign delete, and committed even
  // when that matched nothing, so org A could wipe org B's coupons and banner
  // config (campaign ids are public: the banner response carries campaignId).
  it("DELETE of B's campaign via A's path is 404 and leaves the campaign, its banner config and coupons", async () => {
    const res = await client.request(`/v1/teams/${a.orgId}/campaigns/${bRes.campaignId}`, {
      method: "DELETE",
      headers: as(a),
    });
    expect(res.status).toBe(404);
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("scopes parity groups by org", async () => {
    const A = `/v1/teams/${a.orgId}`;
    expect(
      (await client.request(`${A}/parity-groups/${bRes.groupId}`, {
        method: "PATCH",
        headers: as(a),
        json: { discountPercent: 0 },
      })).status,
    ).toBe(404);
    expect(
      (await client.request(`${A}/parity-groups/${bRes.groupId}/countries`, {
        method: "PUT",
        headers: as(a),
        json: { countries: ["US", "GB"] },
      })).status,
    ).toBe(404);
    expect(
      (await client.request(`${A}/parity-groups/${bRes.groupId}`, { method: "DELETE", headers: as(a) })).status,
    ).toBe(404);

    const list = await (await client.request(`${A}/parity-groups`, { headers: as(a) })).json();
    expect(list.data).toEqual([]);
    const db = getTestDb();
    const [group] = await db.select().from(parityGroups).where(eq(parityGroups.id, bRes.groupId));
    expect(group!.discountPercent).toBe(40);
    const countries = await db
      .select({ cc: countryParityMappings.countryCode })
      .from(countryParityMappings)
      .where(eq(countryParityMappings.parityGroupId, bRes.groupId));
    expect(countries.map((c) => c.cc)).toEqual(["IN"]);
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("scopes integrations by org", async () => {
    const A = `/v1/teams/${a.orgId}`;
    const I = bRes.integrationId;
    expect((await client.request(`${A}/integrations/${I}`, { method: "DELETE", headers: as(a) })).status).toBe(404);
    expect((await client.request(`${A}/integrations/${I}/test`, { method: "POST", headers: as(a) })).status).toBe(404);
    expect((await client.request(`${A}/integrations/${I}/products`, { headers: as(a) })).status).toBe(404);
    expect(
      (await client.request(`${A}/integrations/${I}/products/import`, {
        method: "POST",
        headers: as(a),
        json: { productIds: ["prod_1"] },
      })).status,
    ).toBe(404);

    const list = await (await client.request(`${A}/integrations`, { headers: as(a) })).json();
    expect(list.data).toEqual([]);
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("scopes API keys by org, including the banner KV mapping", async () => {
    const A = `/v1/teams/${a.orgId}`;
    expect(
      (await client.request(`${A}/api-keys/${bRes.keyId}`, { method: "DELETE", headers: as(a) })).status,
    ).toBe(404);
    const list = await (await client.request(`${A}/api-keys`, { headers: as(a) })).json();
    expect(list.data).toEqual([]);

    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bRes.rawKey))),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const mapping = await client.env.CACHE.get(`apikey:${hash}`);
    expect(JSON.parse(mapping!)).toEqual({ apiKeyId: bRes.keyId, organizationId: b.orgId });
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("refuses to attach org B's product or integration to an org A campaign", async () => {
    const A = `/v1/teams/${a.orgId}`;
    const withBProduct = await client.request(`${A}/campaigns`, {
      method: "POST",
      headers: as(a),
      json: { productId: bRes.productId, name: "Hijack" },
    });
    expect(withBProduct.status).toBe(400);

    const own = await (
      await client.request(`${A}/products`, {
        method: "POST",
        headers: as(a),
        json: { name: "A Product", url: "https://a.example.com", basePrice: 10 },
      })
    ).json();
    const withBIntegration = await client.request(`${A}/campaigns`, {
      method: "POST",
      headers: as(a),
      json: { productId: own.data.id, integrationId: bRes.integrationId, name: "Hijack" },
    });
    expect(withBIntegration.status).toBe(400);

    const ownCampaign = await (
      await client.request(`${A}/campaigns`, {
        method: "POST",
        headers: as(a),
        json: { productId: own.data.id, name: "A Campaign" },
      })
    ).json();
    const repoint = await client.request(`${A}/campaigns/${ownCampaign.data.id}`, {
      method: "PATCH",
      headers: as(a),
      json: { productId: bRes.productId, integrationId: bRes.integrationId },
    });
    expect(repoint.status).toBe(400);
    const [row] = await getTestDb().select().from(campaigns).where(eq(campaigns.id, ownCampaign.data.id));
    expect(row).toMatchObject({ productId: own.data.id, integrationId: null });
  });

  it("never mixes org B's analytics into org A's", async () => {
    const A = `/v1/teams/${a.orgId}`;
    const overview = await (await client.request(`${A}/analytics/overview`, { headers: as(a) })).json();
    expect(overview.data.totalImpressions).toBe(0);
    const byCampaign = await (await client.request(`${A}/analytics/by-campaign`, { headers: as(a) })).json();
    expect(byCampaign.data).toEqual([]);

    // Sanity: B sees its own rollup through the same endpoint.
    const bOverview = await (
      await client.request(`/v1/teams/${b.orgId}/analytics/overview`, { headers: as(b) })
    ).json();
    expect(bOverview.data.totalImpressions).toBe(7);
    const [counted] = await getTestDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(analyticsRollups)
      .where(and(eq(analyticsRollups.organizationId, a.orgId)));
    expect(counted?.n).toBe(0);
  });

  it("scopes team members and product grants by org", async () => {
    const A = `/v1/teams/${a.orgId}`;
    const member = await seedUser(client.env, "A Member");
    await addMember(a.orgId, member.id, "member");

    // Granting org B's product to an org A member is refused outright.
    const crossGrant = await client.request(`${A}/members/${member.id}/product-access`, {
      method: "PUT",
      headers: as(a),
      json: { productIds: [bRes.productId] },
    });
    expect(crossGrant.status).toBe(400);
    expect(await crossGrant.json()).toMatchObject({ unknown: [bRes.productId] });

    // Org B's owner is not a member of A: their grants cannot be read or written via A.
    const foreign = await client.request(`${A}/members/${b.user.id}/product-access`, {
      method: "PUT",
      headers: as(a),
      json: { productIds: [] },
    });
    expect(foreign.status).toBe(404);

    const roster = await (await client.request(`${A}/members`, { headers: as(a) })).json();
    expect(JSON.stringify(roster)).not.toContain(b.user.id);
    expect(JSON.stringify(roster)).not.toContain(b.user.email);
    expect(await getTestDb().select().from(memberProductAccess)).toEqual([]);
    // Neither refused write left a scope behind (the 400 cross-grant is atomic).
    expect(await getTestDb().select().from(memberProductScopes)).toEqual([]);
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("Better Auth's organization routes refuse org B to org A's owner", async () => {
    const [bOwner] = await getTestDb()
      .select()
      .from(members)
      .where(and(eq(members.organizationId, b.orgId), eq(members.userId, b.user.id)));
    const attempts: Array<[string, string, unknown?]> = [
      ["POST", "/api/auth/organization/invite-member", { organizationId: b.orgId, email: "spy@example.test", role: "admin" }],
      ["POST", "/api/auth/organization/update-member-role", { organizationId: b.orgId, memberId: bOwner!.id, role: "member" }],
      ["POST", "/api/auth/organization/remove-member", { organizationId: b.orgId, memberIdOrEmail: b.user.email }],
      ["POST", "/api/auth/organization/update", { organizationId: b.orgId, data: { name: "pwned" } }],
      ["POST", "/api/auth/organization/delete", { organizationId: b.orgId }],
      ["POST", "/api/auth/organization/set-active", { organizationId: b.orgId }],
      ["GET", `/api/auth/organization/get-full-organization?organizationId=${b.orgId}`],
      ["GET", `/api/auth/organization/list-members?organizationId=${b.orgId}`],
    ];
    for (const [method, path, json] of attempts) {
      const res = await client.request(path, { method, headers: as(a), json });
      const body = await res.text();
      expect({ path, ok: res.ok, serverError: res.status >= 500 }).toEqual({ path, ok: false, serverError: false });
      // Refused for membership (MEMBER_NOT_FOUND / ..._NOT_A_MEMBER_...), not for a
      // malformed request. Organization deletion is disabled for everyone (auth.ts
      // disableOrganizationDeletion), so that route refuses before any membership check.
      const expectedCode = path === "/api/auth/organization/delete"
        ? "ORGANIZATION_DELETION_DISABLED"
        : expect.stringMatching(/MEMBER/);
      expect({ path, code: JSON.parse(body).code }).toEqual({ path, code: expectedCode });
      expect(body).not.toContain(b.user.email);
    }

    const [org] = await getTestDb().select().from(organizations).where(eq(organizations.id, b.orgId));
    expect(org?.name).toBe("Org B");
    const [stillOwner] = await getTestDb().select().from(members).where(eq(members.id, bOwner!.id));
    expect(stillOwner?.role).toBe("owner");
    expect(await getTestDb().select().from(invitations).where(eq(invitations.organizationId, b.orgId))).toEqual([]);
    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
  });

  it("deleting org A's own workspace leaves org B's rows and cache entries untouched", async () => {
    const A = `/v1/teams/${a.orgId}`;
    const aProduct = await (
      await client.request(`${A}/products`, {
        method: "POST",
        headers: as(a),
        json: { name: "A Product", url: "https://a.example.com", basePrice: 10 },
      })
    ).json();
    await client.request(`${A}/campaigns`, {
      method: "POST",
      headers: as(a),
      json: { productId: aProduct.data.id, name: "A Campaign", status: "active" },
    });
    const aKey = await (
      await client.request(`${A}/api-keys`, { method: "POST", headers: as(a), json: { name: "A Key", keyType: "public" } })
    ).json();
    expect(await client.env.CACHE.get(`apikey:${await sha256Hex(aKey.data.key)}`)).not.toBeNull();

    const bMapping = await client.env.CACHE.get(`apikey:${await sha256Hex(bRes.rawKey)}`);
    const bBanner = await client.env.CACHE.get(`banner-config:${bRes.keyId}`);
    expect(bMapping).not.toBeNull();

    const res = await client.request(A, { method: "DELETE", headers: as(a) });
    expect(res.status).toBe(200);
    expect(await getTestDb().select().from(organizations).where(eq(organizations.id, a.orgId))).toEqual([]);
    expect(await getTestDb().select().from(products).where(eq(products.organizationId, a.orgId))).toEqual([]);
    expect(await client.env.CACHE.get(`apikey:${await sha256Hex(aKey.data.key)}`)).toBeNull();

    expect(await orgBSnapshot()).toEqual(EXPECTED_B);
    expect(await client.env.CACHE.get(`apikey:${await sha256Hex(bRes.rawKey)}`)).toBe(bMapping);
    expect(await client.env.CACHE.get(`banner-config:${bRes.keyId}`)).toBe(bBanner);
    expect(
      (await client.request(`/v1/teams/${b.orgId}/products`, { headers: as(b) })).status,
    ).toBe(200);
  });
});
