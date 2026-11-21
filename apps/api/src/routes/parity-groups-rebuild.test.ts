import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { DEFAULT_PARITY_TIERS } from "@gopaylocal/shared/parity";
import { createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Every parity-group change rebuilds the banner document. It matters more now:
// whether a workspace has any group decides between its own groups and the
// default tiers for group-mode campaigns, so creating the first group, seeding,
// or deleting the last group changes what every such campaign serves.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  push: null as unknown as Mock<(...args: unknown[]) => Promise<void>>,
}));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: (...args: unknown[]) => state.push(...args),
}));

const { default: parityGroupsRoute } = await import("./parity-groups");

const ORG = "org_a";
const GROUP = "grp_1";
const admin: InjectedMember = { userId: "u_a", role: "admin" };
const groupRow = { id: GROUP, organizationId: ORG, name: "T", discountPercent: 40, sortOrder: 1 };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.push = vi.fn(async (..._args: unknown[]) => {});
});
afterEach(() => vi.restoreAllMocks());

const cases: Array<[string, string, string, unknown, Array<unknown[]>]> = [
  ["create", "POST", `/v1/teams/${ORG}/parity-groups`, { name: "T", discountPercent: 40, sortOrder: 1 }, [[groupRow]]],
  ["update", "PATCH", `/v1/teams/${ORG}/parity-groups/${GROUP}`, { discountPercent: 30 }, [[groupRow]]],
  ["delete", "DELETE", `/v1/teams/${ORG}/parity-groups/${GROUP}`, undefined, [[{ id: GROUP }]]],
  ["set countries", "PUT", `/v1/teams/${ORG}/parity-groups/${GROUP}/countries`, { countries: ["IN"] }, [[groupRow], [], []]],
  [
    "seed the default tiers",
    "POST",
    `/v1/teams/${ORG}/parity-groups/seed-defaults`,
    undefined,
    [[], ...DEFAULT_PARITY_TIERS.flatMap((t) => [[{ ...groupRow, sortOrder: t.sortOrder }], []])],
  ],
];

describe("parity-group changes rebuild the banner document", () => {
  it.each(cases)("%s", async (_name, method, path, json, rows) => {
    state.recorder = createSqlRecorder(rows);
    const client = createTestClient(mountRoutes(parityGroupsRoute, admin));
    const res = await client.request(path, { method, json });
    expect(res.status).toBeLessThan(300);
    expect(state.push).toHaveBeenCalledTimes(1);
    const [db, kv, orgId] = state.push.mock.calls[0]!;
    expect(db).toBe(state.recorder.db);
    expect(kv).toBe(client.env.CACHE);
    expect(orgId).toBe(ORG);
  });

  it("a change that matched nothing does not rebuild", async () => {
    const client = createTestClient(mountRoutes(parityGroupsRoute, admin));
    state.recorder = createSqlRecorder([[]]);
    expect((await client.request(`/v1/teams/${ORG}/parity-groups/${GROUP}`, { method: "DELETE" })).status).toBe(404);
    state.recorder = createSqlRecorder([[{ id: "existing" }]]);
    expect((await client.request(`/v1/teams/${ORG}/parity-groups/seed-defaults`, { method: "POST" })).status).toBe(409);
    expect(state.push).not.toHaveBeenCalled();
  });
});
