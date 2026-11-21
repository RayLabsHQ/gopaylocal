import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { users } from "../db/schema";
import { createTestClient, mountRoutes } from "../test/helpers";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";
import apiKeysRoute from "./api-keys";

const TEST_ORG_ID = "test-org-apikeys";

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The identities mountRoutes injects below, as real user rows: a key records
 * its creator (api_keys.created_by_user_id references user(id)), and in the
 * deployed app a session's user always exists.
 */
async function seedInjectedUsers() {
  await getTestDb()
    .insert(users)
    .values([
      { id: "test-user-id", name: "Test User", email: "test-user@example.test" },
      { id: "member-user", name: "Member User", email: "member-user@example.test" },
    ]);
}

describe("API Keys API", () => {
  // A fresh client (and KV) per test, so cache assertions can't leak.
  let app = createTestClient(mountRoutes(apiKeysRoute));

  beforeEach(async () => {
    await cleanupTestDb();
    await seedInjectedUsers();
    app = createTestClient(mountRoutes(apiKeysRoute));
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  it("POST /v1/teams/:orgId/api-keys generates a public key and returns the full key once", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Public Key",
        keyType: "public",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBeDefined();
    expect(json.data.name).toBe("My Public Key");
    expect(json.data.keyType).toBe("public");
    expect(json.data.key).toBeDefined();
    expect(json.data.key).toMatch(/^gpl_pk_/);
    expect(json.data.keyPrefix).toBeDefined();
    expect(json.data.keyPrefix).toMatch(/^gpl_pk_/);
    expect(json.data.keyPrefix).toContain("...");

    // Background work (waitUntil): the key -> org mapping is pushed to KV so
    // the banner endpoint can resolve it without the database.
    const cached = await app.env.CACHE.get(`apikey:${await sha256Hex(json.data.key)}`);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual({ apiKeyId: json.data.id, organizationId: TEST_ORG_ID });
  });

  it("a secret key is never pushed to the banner KV cache", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Server Key", keyType: "secret" }),
    });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(await app.env.CACHE.get(`apikey:${await sha256Hex(data.key)}`)).toBeNull();
  });

  it("members (below admin) cannot create or revoke keys", async () => {
    const asMember = createTestClient(
      mountRoutes(apiKeysRoute, { userId: "member-user", role: "member" }),
    );
    const res = await asMember.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope", keyType: "public" }),
    });
    expect(res.status).toBe(403);

    const created = await (
      await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Owner Key", keyType: "public" }),
      })
    ).json();
    const del = await asMember.request(`/v1/teams/${TEST_ORG_ID}/api-keys/${created.data.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(403);
  });

  it("POST /v1/teams/:orgId/api-keys generates a secret key with correct prefix", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Secret Key",
        keyType: "secret",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.key).toMatch(/^gpl_sk_/);
    expect(json.data.keyType).toBe("secret");
  });

  it("GET /v1/teams/:orgId/api-keys lists keys with prefix only, not the full key", async () => {
    // Create a key first
    await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Listed Key",
        keyType: "public",
      }),
    });

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("Listed Key");
    expect(json.data[0].keyPrefix).toBeDefined();
    expect(json.data[0].keyPrefix).toContain("...");
    // keyHash should NOT be in the listing
    expect(json.data[0].keyHash).toBeUndefined();
    // Public keys expose the full plaintext key (public by design) so the
    // dashboard can build a ready-to-paste banner snippet.
    expect(json.data[0].fullKey).toBeDefined();
    expect(json.data[0].fullKey).toMatch(/^gpl_pk_/);
  });

  it("GET listing never returns a fullKey for secret keys", async () => {
    await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Secret Listed", keyType: "secret" }),
    });

    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`);
    const json = await res.json();
    const secretRow = json.data.find((k: { keyType: string }) => k.keyType === "secret");
    expect(secretRow).toBeDefined();
    // Secret keys must never expose a full key (only the hash is stored).
    expect(secretRow.fullKey).toBeNull();
    expect(secretRow.key).toBeUndefined();
    expect(secretRow.keyHash).toBeUndefined();
  });

  it("DELETE /v1/teams/:orgId/api-keys/:id revokes a key", async () => {
    const createRes = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "To Revoke",
        keyType: "public",
      }),
    });

    const { data: created } = await createRes.json();

    const deleteRes = await app.request(
      `/v1/teams/${TEST_ORG_ID}/api-keys/${created.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Verify it is no longer listed
    const listRes = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`);
    const listJson = await listRes.json();
    expect(listJson.data).toHaveLength(0);

    // Background work: the KV mapping is gone, so the banner stops resolving it.
    expect(await app.env.CACHE.get(`apikey:${await sha256Hex(created.key)}`)).toBeNull();
  });

  it("DELETE with non-existent id returns 404", async () => {
    const res = await app.request(
      `/v1/teams/${TEST_ORG_ID}/api-keys/nonexistent-id`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("POST with invalid data (missing keyType) returns 400", async () => {
    const res = await app.request(`/v1/teams/${TEST_ORG_ID}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Key",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
  });
});
