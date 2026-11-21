import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  analyticsRollups,
  apiKeys,
  campaigns,
  integrations,
  invitations,
  members,
  organizations,
  products,
  users,
} from "../db/schema";
import { encrypt, tokenEncryptionSecret } from "../lib/crypto";
import { createTestBindings, createTestClient, type TestClient } from "../test/helpers";
import { addMember, as, seedTenant, seedUser, signIn, DASHBOARD_ORIGIN, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

// index.ts pulls in the banner route, which imports the browser bundle as a
// wrangler text module; stub it so browser code never runs under Node.
vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Secret API keys (gpl_sk_) on the management API, through the real Worker:
 * real keys created by the dashboard route, real Postgres, the real
 * session-or-key, team and permission middleware. Covers: a key of workspace A
 * against workspace B, a revoked key, a public key, the routes a key may not
 * reach, the Free plan product limit, banned owners, workspace deletion, and a
 * creator who is recorded, leaves, is banned or is deleted. Also: an HTTP
 * Basic header does not take the key path.
 */

let client: TestClient;
let a: TestTenant;
let b: TestTenant;

async function createKey(tenant: TestTenant, keyType: "secret" | "public", name = `${keyType} key`) {
  const res = await client.request(`/v1/teams/${tenant.orgId}/api-keys`, {
    method: "POST",
    headers: as(tenant),
    json: { name, keyType },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.data.id as string, key: body.data.key as string };
}

const bearer = (key: string, extra?: Record<string, string>) => ({ authorization: `Bearer ${key}`, ...extra });

function withKey(key: string, path: string, init: Parameters<TestClient["request"]>[1] = {}) {
  return client.request(path, { ...init, headers: { ...bearer(key), ...(init.headers as Record<string, string> | undefined) } });
}

describe("Secret API keys (full Worker)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
    client = createTestClient(worker, createTestBindings());
    a = await seedTenant(client, "Org A");
    b = await seedTenant(client, "Org B");
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("GET /v1/me tells a key its workspace, identity and permissions", async () => {
    const { id, key } = await createKey(a, "secret", "CI deploy");
    const res = await withKey(key, "/v1/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.organization).toEqual({ id: a.orgId, name: "Org A" });
    expect(body.data.apiKey).toMatchObject({ id, name: "CI deploy", keyPrefix: key.slice(0, 15) + "..." });
    expect(body.data.permissions).toContain("products.create");
    expect(body.data.permissions).not.toContain("apiKeys.manage");
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("does what an admin does on its own workspace, Free plan limits included", async () => {
    const { key } = await createKey(a, "secret");
    const A = `/v1/teams/${a.orgId}`;

    const created = await withKey(key, `${A}/products`, {
      method: "POST",
      json: { name: "Key Product", url: "https://a.example.com", basePrice: 20 },
    });
    expect(created.status).toBe(201);
    const productId = (await created.json()).data.id as string;

    // The same entitlement path as a session: Free allows one product.
    const second = await withKey(key, `${A}/products`, {
      method: "POST",
      json: { name: "Second", url: "https://a.example.com/2", basePrice: 20 },
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: "Product limit reached", plan: "free", maxProducts: 1, currentCount: 1 });

    const campaign = await withKey(key, `${A}/campaigns`, {
      method: "POST",
      json: { productId, name: "Key Campaign" },
    });
    expect(campaign.status).toBe(201);
    const campaignId = (await campaign.json()).data.id as string;

    for (const path of [
      `${A}/products`,
      `${A}/products/${productId}`,
      `${A}/campaigns`,
      `${A}/campaigns/${campaignId}`,
      `${A}/banner-configs/${campaignId}`,
      `${A}/experiments`,
      `${A}/parity-groups`,
      `${A}/integrations`,
      `${A}/api-keys`,
      `${A}/analytics/overview`,
      `${A}/analytics/by-country`,
      `${A}/analytics/by-campaign`,
    ]) {
      const res = await withKey(key, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }

    // Every product is in a key's scope: it sees what an admin sees.
    const list = await (await withKey(key, `${A}/products`)).json();
    expect(list.data.map((p: { id: string }) => p.id)).toEqual([productId]);

    const patched = await withKey(key, `${A}/products/${productId}`, { method: "PATCH", json: { name: "Renamed by key" } });
    expect(patched.status).toBe(200);
    const removed = await withKey(key, `${A}/campaigns/${campaignId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  it("records lastUsedAt on use", async () => {
    const { id, key } = await createKey(a, "secret");
    const before = await getTestDb().select({ at: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, id));
    expect(before[0]!.at).toBeNull();
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
    const after = await getTestDb().select({ at: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.id, id));
    expect(after[0]!.at).toBeInstanceOf(Date);
  });

  it("a key of workspace A gets 403 on every workspace B route, exactly like a member of A, and changes nothing", async () => {
    const { key } = await createKey(a, "secret");
    // B's resources, made by B's owner.
    const B = `/v1/teams/${b.orgId}`;
    const product = await (
      await client.request(`${B}/products`, {
        method: "POST",
        headers: as(b),
        json: { name: "B Product", url: "https://b.example.com", basePrice: 50 },
      })
    ).json();
    const productId = product.data.id as string;
    const bKey = await createKey(b, "secret");

    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `${B}/products`],
      ["POST", `${B}/products`, { name: "x", url: "https://x.example.com", basePrice: 1 }],
      ["GET", `${B}/products/${productId}`],
      ["PATCH", `${B}/products/${productId}`, { name: "pwned" }],
      ["DELETE", `${B}/products/${productId}`],
      ["GET", `${B}/campaigns`],
      ["POST", `${B}/campaigns`, { productId, name: "pwned" }],
      ["GET", `${B}/parity-groups`],
      ["POST", `${B}/parity-groups/seed-defaults`],
      ["GET", `${B}/integrations`],
      ["GET", `${B}/api-keys`],
      ["DELETE", `${B}/api-keys/${bKey.id}`],
      ["GET", `${B}/analytics/overview`],
      ["GET", `${B}/members`],
      ["GET", `${B}/billing`],
      ["DELETE", B],
    ];
    for (const [method, path, json] of attempts) {
      const res = await withKey(key, path, { method, json });
      expect({ method, path, status: res.status, body: await res.json() }).toEqual({
        method,
        path,
        status: 403,
        body: { error: "Forbidden: not a member of this organization" },
      });
    }

    const db = getTestDb();
    const [row] = await db.select().from(products).where(eq(products.id, productId));
    expect(row!.name).toBe("B Product");
    expect(await db.select().from(products).where(eq(products.organizationId, b.orgId))).toHaveLength(1);
    expect(await db.select().from(campaigns).where(eq(campaigns.organizationId, b.orgId))).toHaveLength(0);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.organizationId, b.orgId))).toHaveLength(1);
    expect(await db.select().from(organizations).where(eq(organizations.id, b.orgId))).toHaveLength(1);
  });

  it("B's record ids through A's path are 404 to A's key", async () => {
    const { key } = await createKey(a, "secret");
    const bProduct = await (
      await client.request(`/v1/teams/${b.orgId}/products`, {
        method: "POST",
        headers: as(b),
        json: { name: "B Product", url: "https://b.example.com", basePrice: 50 },
      })
    ).json();
    const A = `/v1/teams/${a.orgId}`;
    expect((await withKey(key, `${A}/products/${bProduct.data.id}`)).status).toBe(404);
    expect((await withKey(key, `${A}/products/${bProduct.data.id}`, { method: "PATCH", json: { name: "x" } })).status).toBe(404);
    expect((await withKey(key, `${A}/products/${bProduct.data.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("a key never borrows a session: with B's owner cookie, A's key still gets 403 on B", async () => {
    const { key } = await createKey(a, "secret");
    const res = await client.request(`/v1/teams/${b.orgId}/products`, { headers: { ...as(b), ...bearer(key) } });
    expect(res.status).toBe(403);
    // And a bad key with a good cookie is refused, not rescued by the cookie.
    const bad = await client.request(`/v1/teams/${b.orgId}/products`, { headers: { ...as(b), ...bearer("gpl_sk_nope") } });
    expect(bad.status).toBe(401);
  });

  it("a revoked key answers 401 invalid_api_key", async () => {
    const { id, key } = await createKey(a, "secret");
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
    const revoked = await client.request(`/v1/teams/${a.orgId}/api-keys/${id}`, { method: "DELETE", headers: as(a) });
    expect(revoked.status).toBe(200);
    const res = await withKey(key, `/v1/teams/${a.orgId}/products`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
    expect((await withKey(key, "/v1/me")).status).toBe(401);
  });

  it("an unknown well-formed key answers 401 invalid_api_key", async () => {
    const res = await withKey(`gpl_sk_${"ab".repeat(32)}`, `/v1/teams/${a.orgId}/products`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key", code: "invalid_api_key" });
  });

  it("a public key as a Bearer token is refused on the management API and on /v1/me", async () => {
    const { key } = await createKey(a, "public");
    for (const path of [`/v1/teams/${a.orgId}/products`, "/v1/me"]) {
      const res = await withKey(key, path);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe("public_key_not_allowed");
      expect(text).not.toContain(key);
    }
  });

  it("cannot reach team, billing, API key management or the workspace itself", async () => {
    const { key } = await createKey(a, "secret");
    const other = await createKey(a, "secret", "other");
    const A = `/v1/teams/${a.orgId}`;
    const attempts: Array<[string, string, string, unknown?]> = [
      ["GET", `${A}/members`, "team.view"],
      ["GET", `${A}/invitations`, "team.viewInvitations"],
      ["GET", `${A}/members/${a.user.id}/product-access`, "team.viewProductAccess"],
      ["PUT", `${A}/members/${a.user.id}/product-access`, "team.manageProductAccess", { allProducts: true }],
      ["GET", `${A}/billing`, "billing.view"],
      ["GET", `${A}/billing/usage`, "billing.view"],
      ["POST", `${A}/billing/checkout`, "billing.manage", { plan: "pro", interval: "month" }],
      ["POST", `${A}/billing/portal`, "billing.manage"],
      ["POST", `${A}/api-keys`, "apiKeys.manage", { name: "minted by a key", keyType: "secret" }],
      ["DELETE", `${A}/api-keys/${other.id}`, "apiKeys.manage"],
      ["DELETE", A, "workspace.delete"],
    ];
    for (const [method, path, permission, json] of attempts) {
      const res = await withKey(key, path, { method, json });
      const body = await res.json();
      expect({ method, path, status: res.status, code: body.code, permission: body.permission }).toEqual({
        method,
        path,
        status: 403,
        code: "forbidden_api_key",
        permission,
      });
    }
    const db = getTestDb();
    expect(await db.select().from(apiKeys).where(eq(apiKeys.organizationId, a.orgId))).toHaveLength(2);
    expect(await db.select().from(organizations).where(eq(organizations.id, a.orgId))).toHaveLength(1);
  });

  it("cannot connect or disconnect an integration", async () => {
    const { key } = await createKey(a, "secret");
    const integrationId = ulid();
    await getTestDb().insert(integrations).values({
      id: integrationId,
      organizationId: a.orgId,
      provider: "stripe",
      liveAccessTokenEnc: await encrypt("sk_test_org_a", tokenEncryptionSecret(client.env)),
      status: "active",
    });
    const A = `/v1/teams/${a.orgId}`;
    const connect = await withKey(key, `${A}/integrations`, {
      method: "POST",
      json: { provider: "stripe", accessToken: "sk_test_attacker" },
    });
    expect(connect.status).toBe(403);
    expect((await connect.json()).code).toBe("forbidden_api_key");
    const disconnect = await withKey(key, `${A}/integrations/${integrationId}`, { method: "DELETE" });
    expect(disconnect.status).toBe(403);
    expect(await getTestDb().select().from(integrations).where(eq(integrations.organizationId, a.orgId))).toHaveLength(1);
  });

  it("Better Auth's organization routes ignore a key (no session, nothing created)", async () => {
    const { key } = await createKey(a, "secret");
    const res = await client.request("/api/auth/organization/invite-member", {
      method: "POST",
      headers: { ...bearer(key), origin: DASHBOARD_ORIGIN },
      json: { email: `x-${ulid().toLowerCase()}@example.test`, role: "admin", organizationId: a.orgId },
    });
    expect(res.status).toBe(401);
    expect(await getTestDb().select().from(invitations).where(eq(invitations.organizationId, a.orgId))).toHaveLength(0);
  });

  it("refuses while an owner of the workspace is banned, and works again once unbanned", async () => {
    const { key } = await createKey(a, "secret");
    const db = getTestDb();
    await db.update(users).set({ banned: true }).where(eq(users.id, a.user.id));
    const res = await withKey(key, `/v1/teams/${a.orgId}/products`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
    expect((await withKey(key, "/v1/me")).status).toBe(403);

    await db.update(users).set({ banned: false }).where(eq(users.id, a.user.id));
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
  });

  it("a banned co-owner is enough to refuse; a banned admin or member is not", async () => {
    const { key } = await createKey(a, "secret");
    const db = getTestDb();
    const admin = await seedUser(client.env, "A Admin");
    await addMember(a.orgId, admin.id, "admin");
    await db.update(users).set({ banned: true }).where(eq(users.id, admin.id));
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);

    const coOwner = await seedUser(client.env, "A Co-owner");
    await addMember(a.orgId, coOwner.id, "owner");
    await db.update(users).set({ banned: true }).where(eq(users.id, coOwner.id));
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(403);
  });

  it("belongs to the workspace: keeps working after the member who created it leaves", async () => {
    const admin = await seedUser(client.env, "A Admin");
    await addMember(a.orgId, admin.id, "admin");
    const adminTenant = { user: admin, orgId: a.orgId, cookie: await signIn(client, admin) };
    const { key } = await createKey(adminTenant, "secret");
    await getTestDb()
      .delete(members)
      .where(and(eq(members.organizationId, a.orgId), eq(members.userId, admin.id)));
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
  });

  it("records who created it, and the key list shows them as createdBy", async () => {
    const { id } = await createKey(a, "secret");
    const [row] = await getTestDb()
      .select({ createdByUserId: apiKeys.createdByUserId })
      .from(apiKeys)
      .where(eq(apiKeys.id, id));
    expect(row!.createdByUserId).toBe(a.user.id);
    const list = await client.request(`/v1/teams/${a.orgId}/api-keys`, { headers: as(a) });
    expect(list.status).toBe(200);
    const { data } = await list.json();
    expect(data.find((k: { id: string }) => k.id === id).createdBy).toEqual({ id: a.user.id, name: "Org A Owner" });
  });

  it("refuses while its creator is banned (the banned-owner answer), even after they left; other keys work", async () => {
    const admin = await seedUser(client.env, "A Admin");
    await addMember(a.orgId, admin.id, "admin");
    const adminTenant = { user: admin, orgId: a.orgId, cookie: await signIn(client, admin) };
    const { key } = await createKey(adminTenant, "secret");
    const ownersKey = await createKey(a, "secret", "owner's key");
    const db = getTestDb();
    await db.delete(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, admin.id)));
    await db.update(users).set({ banned: true }).where(eq(users.id, admin.id));

    const res = await withKey(key, `/v1/teams/${a.orgId}/products`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: account suspended" });
    expect((await withKey(key, "/v1/me")).status).toBe(403);
    expect((await withKey(ownersKey.key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);

    await db.update(users).set({ banned: false }).where(eq(users.id, admin.id));
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
  });

  it("keeps working when its creator's account is deleted (createdBy becomes null)", async () => {
    const admin = await seedUser(client.env, "A Admin");
    await addMember(a.orgId, admin.id, "admin");
    const adminTenant = { user: admin, orgId: a.orgId, cookie: await signIn(client, admin) };
    const { id, key } = await createKey(adminTenant, "secret");
    const db = getTestDb();
    await db.delete(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, admin.id)));
    await db.delete(users).where(eq(users.id, admin.id));

    const [row] = await db.select({ createdByUserId: apiKeys.createdByUserId }).from(apiKeys).where(eq(apiKeys.id, id));
    expect(row!.createdByUserId).toBeNull();
    expect((await withKey(key, `/v1/teams/${a.orgId}/products`)).status).toBe(200);
  });

  it("an HTTP Basic Authorization header is ignored: the session authenticates the dashboard request", async () => {
    const res = await client.request(`/v1/teams/${a.orgId}/products`, {
      headers: { ...as(a), authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(200);
    expect((await client.request("/v1/me", { headers: { authorization: "Basic dXNlcjpwYXNz" } })).status).toBe(401);
  });

  it("is deleted with its workspace", async () => {
    const { key } = await createKey(a, "secret");
    const deleted = await client.request(`/v1/teams/${a.orgId}`, { method: "DELETE", headers: as(a) });
    expect(deleted.status).toBe(200);
    expect(await getTestDb().select().from(apiKeys).where(eq(apiKeys.organizationId, a.orgId))).toHaveLength(0);
    expect((await withKey(key, "/v1/me")).status).toBe(401);
  });

  describe("a secret key on the public banner endpoints", () => {
    it("is refused by /v1/banner/config and never echoed", async () => {
      const { key } = await createKey(a, "secret");
      const res = await client.request(`/v1/banner/config/${key}`, { cf: { country: "IN" } });
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(key.slice(7));
    });

    // script.js is one file for every key, so the server has nothing to refuse
    // and nothing to echo. The banner refuses the key in the browser.
    it("is never echoed by /v1/banner/script.js, which answers the same file for every key", async () => {
      const { key } = await createKey(a, "secret");
      const withSecret = await client.request(`/v1/banner/script.js?key=${key}`);
      const withOther = await client.request("/v1/banner/script.js?key=gpl_pk_anything");
      expect(withSecret.status).toBe(200);
      const text = await withSecret.text();
      expect(text).not.toContain(key.slice(7));
      expect(text).toBe(await withOther.text());
    });

    it("is refused by POST /v1/events, and records nothing", async () => {
      const { key } = await createKey(a, "secret");
      // An event A's workspace would record: one of A's campaigns and a country
      // (an event without both is dropped even for a public key).
      const productId = (
        await (
          await client.request(`/v1/teams/${a.orgId}/products`, {
            method: "POST",
            headers: as(a),
            json: { name: "P", url: "https://a.example.com", basePrice: 10 },
          })
        ).json()
      ).data.id as string;
      const campaignId = (
        await (
          await client.request(`/v1/teams/${a.orgId}/campaigns`, {
            method: "POST",
            headers: as(a),
            json: { productId, name: "C" },
          })
        ).json()
      ).data.id as string;
      const event = { event: "click", campaignId, countryCode: "IN", url: "https://a.example.com/pricing" };
      const rollupsOfA = () =>
        getTestDb().select().from(analyticsRollups).where(eq(analyticsRollups.organizationId, a.orgId));

      const res = await client.request("/v1/events", { method: "POST", json: { key, ...event } });
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(key.slice(7));
      expect(await rollupsOfA()).toHaveLength(0);

      // Control: the same event with A's public key is recorded, so the check above can fail.
      const pub = await createKey(a, "public");
      const accepted = await client.request("/v1/events", { method: "POST", json: { key: pub.key, ...event } });
      expect(accepted.status).toBe(204);
      expect(await rollupsOfA()).toHaveLength(1);
    });
  });
});
