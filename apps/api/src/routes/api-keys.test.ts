import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestClient, mountRoutes } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Who created a key: recorded on creation, returned in the list. No database:
// createDb() returns a recorder (real Drizzle SQL, canned rows).
// api-keys.integration.test.ts covers the same routes against Postgres.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({
  pushApiKeyToKV: async () => {},
  removeApiKeyFromKV: async () => {},
  pushBannerConfigForOrg: async () => {},
}));

const { default: apiKeysRoute } = await import("./api-keys");

const ORG = "org_a";
const CREATED_AT = new Date("2026-11-01T10:00:00.000Z");

const client = () => createTestClient(mountRoutes(apiKeysRoute, { userId: "u_admin", role: "admin" }));

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key_1",
    organizationId: ORG,
    name: "CI deploy",
    keyType: "secret",
    keyPrefix: "gpl_sk_01234567...",
    fullKey: null,
    lastUsedAt: null,
    createdAt: CREATED_AT,
    createdByUserId: "u_admin",
    createdByName: "Ada",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /v1/teams/:orgId/api-keys", () => {
  it("records the signed-in user as the key's creator", async () => {
    state.recorder = createSqlRecorder([[{ id: "key_1", name: "CI", keyType: "secret", keyPrefix: "gpl_sk_x...", createdAt: CREATED_AT }]]);
    const res = await client().request(`/v1/teams/${ORG}/api-keys`, {
      method: "POST",
      json: { name: "CI", keyType: "secret" },
    });
    expect(res.status).toBe(201);
    const [insert] = state.recorder.queries;
    expect(insert!.sql).toMatch(/^insert into "api_keys" \(.*"created_by_user_id".*\) values/);
    expect(insert!.params).toContain("u_admin");
  });
});

describe("GET /v1/teams/:orgId/api-keys", () => {
  it("returns each key's creator ({ id, name }) from a left join on the user", async () => {
    state.recorder = createSqlRecorder([
      [listRow(), listRow({ id: "key_2", createdByUserId: null, createdByName: null })],
    ]);
    const res = await client().request(`/v1/teams/${ORG}/api-keys`);
    expect(res.status).toBe(200);
    const [q] = state.recorder.queries;
    expect(q!.sql).toBe(
      'select "api_keys"."id", "api_keys"."organization_id", "api_keys"."name", "api_keys"."key_type", ' +
        '"api_keys"."key_prefix", "api_keys"."full_key", "api_keys"."last_used_at", "api_keys"."created_at", ' +
        '"api_keys"."created_by_user_id", "user"."name" ' +
        'from "api_keys" left join "user" on "user"."id" = "api_keys"."created_by_user_id" ' +
        'where "api_keys"."organization_id" = $1',
    );
    expect(q!.params).toEqual([ORG]);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data[0]).toEqual({
      id: "key_1",
      organizationId: ORG,
      name: "CI deploy",
      keyType: "secret",
      keyPrefix: "gpl_sk_01234567...",
      fullKey: null,
      lastUsedAt: null,
      createdAt: CREATED_AT.toISOString(),
      createdBy: { id: "u_admin", name: "Ada" },
    });
    // Keys from before the column existed, or whose creator was deleted.
    expect(data[1]!.createdBy).toBeNull();
    expect(data[1]).not.toHaveProperty("createdByUserId");
  });

  it("keeps a creator whose user has no name", async () => {
    state.recorder = createSqlRecorder([[listRow({ createdByName: null })]]);
    const res = await client().request(`/v1/teams/${ORG}/api-keys`);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data[0]!.createdBy).toEqual({ id: "u_admin", name: null });
  });
});
