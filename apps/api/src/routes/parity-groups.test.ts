import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Parity groups are org-wide (every campaign prices from them), so mutations
// need admin+. No database: createDb() returns a recorder.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({ pushBannerConfigForOrg: async () => {} }));

const { default: parityGroupsRoute } = await import("./parity-groups");

const ORG = "org_a";
const GROUP = "grp_1";
const member: InjectedMember = { userId: "u_m", role: "member" };
const admin: InjectedMember = { userId: "u_a", role: "admin" };

const mutations: Array<[string, string, unknown?]> = [
  ["POST", `/v1/teams/${ORG}/parity-groups`, { name: "T", discountPercent: 90, sortOrder: 1 }],
  ["PATCH", `/v1/teams/${ORG}/parity-groups/${GROUP}`, { discountPercent: 100 }],
  ["DELETE", `/v1/teams/${ORG}/parity-groups/${GROUP}`],
  ["PUT", `/v1/teams/${ORG}/parity-groups/${GROUP}/countries`, { countries: ["US"] }],
  ["POST", `/v1/teams/${ORG}/parity-groups/seed-defaults`],
];

describe("parity-group role enforcement", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(mutations)("a plain member gets 403 on %s %s and nothing is queried", async (method, path, json) => {
    state.recorder = createSqlRecorder();
    const client = createTestClient(mountRoutes(parityGroupsRoute, member));
    const res = await client.request(path, { method, json });
    expect(res.status).toBe(403);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("a member can still read the groups", async () => {
    state.recorder = createSqlRecorder([[]]);
    const client = createTestClient(mountRoutes(parityGroupsRoute, member));
    const res = await client.request(`/v1/teams/${ORG}/parity-groups`);
    expect(res.status).toBe(200);
  });

  it("an admin replaces countries atomically, uppercased and de-duplicated", async () => {
    state.recorder = createSqlRecorder([
      [{ id: GROUP, organizationId: ORG, name: "T", discountPercent: 40, sortOrder: 1 }],
      [],
      [],
    ]);
    const client = createTestClient(mountRoutes(parityGroupsRoute, admin));

    const res = await client.request(`/v1/teams/${ORG}/parity-groups/${GROUP}/countries`, {
      method: "PUT",
      json: { countries: ["in", "IN", "br"] },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.countries).toEqual(["IN", "BR"]);
    expect(state.recorder.transactions).toEqual(["commit"]);
    const [check, del, insert] = state.recorder.queries;
    expect(check!.params).toEqual([GROUP, ORG, 1]); // group verified as this org's first
    expect(del!.sql).toBe('delete from "country_parity_mappings" where "country_parity_mappings"."parity_group_id" = $1');
    expect(insert!.params.filter((p) => p === "IN" || p === "BR")).toEqual(["IN", "BR"]);
  });

  it("answers 404 for another org's group without touching its mappings", async () => {
    state.recorder = createSqlRecorder([[]]);
    const client = createTestClient(mountRoutes(parityGroupsRoute, admin));
    const res = await client.request(`/v1/teams/${ORG}/parity-groups/${GROUP}/countries`, {
      method: "PUT",
      json: { countries: ["US"] },
    });
    expect(res.status).toBe(404);
    expect(state.recorder.queries).toHaveLength(1);
  });
});
