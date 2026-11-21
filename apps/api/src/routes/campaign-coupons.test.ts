import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  countryDiscount,
  workspaceParityGroupsFromList,
  type ListedParityGroup,
  type ParityGroupRow,
} from "@gopaylocal/shared/parity";
import { createMockKV, createTestBindings } from "../test/helpers";
import { createSqlRecorder } from "../lib/sql-recorder-test-helpers";

// Coupon codes created when a campaign with an integration becomes active
// (generateCouponsForCampaign, run inside waitUntil). Each code carries the
// percentage the banner serves for its country (the shared countryDiscount), and
// codes are created only for the countries of the workspace's OWN parity groups:
// never for the default tiers, so a workspace without groups makes no provider
// call at activation (its codes are created on a country's first banner load).

const state = vi.hoisted(() => ({
  create: null as unknown as Mock<(...args: unknown[]) => Promise<unknown>>,
  push: null as unknown as Mock<(...args: unknown[]) => Promise<void>>,
}));
vi.mock("../services/coupon.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/coupon.service")>()),
  createCouponForCountry: (...args: unknown[]) => state.create(...args),
}));
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: (...args: unknown[]) => state.push(...args),
}));

const { generateCouponsForCampaign } = await import("./campaigns");

const ORG = "org_1";
const CAMPAIGN_ID = "cmp_1";

type Mode = { pricingMode: "group" | "custom" | "ppp_factor"; maxDiscountPercent: number; discountOverrides: Record<string, number> | null };

const campaignRow = (mode: Mode) => ({
  id: CAMPAIGN_ID,
  organizationId: ORG,
  productId: "prd_1",
  integrationId: "int_1",
  name: "PPP",
  environment: "live",
  status: "active",
  discountDelivery: "banner_coupon",
  charmPricingStrategy: "none",
  couponPrefix: null,
  allowedDomains: null,
  createdAt: new Date(),
  ...mode,
});
const integrationRow = { id: "int_1", organizationId: ORG, provider: "stripe", status: "active" };

/** The builder-shaped rows (one per group and country) the group query returns. */
function groupRows(groups: ListedParityGroup[]): ParityGroupRow[] {
  return groups.flatMap((g): ParityGroupRow[] =>
    g.countries.length > 0
      ? g.countries.map((countryCode) => ({ groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder, countryCode }))
      : [{ groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder, countryCode: null }],
  );
}

async function activate(mode: Mode, groups: ListedParityGroup[]) {
  const r = createSqlRecorder([[campaignRow(mode)], [integrationRow], groupRows(groups)]);
  await generateCouponsForCampaign(r.db, createTestBindings(), createMockKV(), CAMPAIGN_ID, ORG);
  // createCouponForCountry(db, env, campaign, integration, countryCode, discount)
  const calls = state.create.mock.calls.map((c) => ({ country: c[4] as string, percent: c[5] as number }));
  return { calls, recorder: r };
}

// IN is in two groups (sort 1 wins), DE's group gives 0%, BR and US share one.
const GROUPS: ListedParityGroup[] = [
  { id: "grp_b", discountPercent: 30, sortOrder: 2, countries: ["IN", "BR", "US"] },
  { id: "grp_a", discountPercent: 50, sortOrder: 1, countries: ["IN"] },
  { id: "grp_z", discountPercent: 0, sortOrder: 3, countries: ["DE"] },
];

const MODES: Mode[] = [
  { pricingMode: "group", maxDiscountPercent: 40, discountOverrides: null },
  { pricingMode: "custom", maxDiscountPercent: 70, discountOverrides: { BR: 25, IN: 80, FR: 15 } },
  { pricingMode: "ppp_factor", maxDiscountPercent: 60, discountOverrides: null },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.create = vi.fn(async () => ({}));
  state.push = vi.fn(async () => {});
});
afterEach(() => vi.restoreAllMocks());

describe("coupons created at activation", () => {
  it.each(MODES)("a workspace without parity groups makes no provider call ($pricingMode)", async (mode) => {
    const { calls } = await activate(mode, []);
    expect(calls).toEqual([]);
    expect(state.push).toHaveBeenCalledTimes(1);
  });

  it.each(MODES)("with groups, each code carries countryDiscount's percent, once per country ($pricingMode)", async (mode) => {
    const { calls } = await activate(mode, GROUPS);
    const groups = workspaceParityGroupsFromList(GROUPS);
    const expected = ["BR", "DE", "IN", "US"]
      .map((country) => ({ country, percent: countryDiscount(mode, country, groups).discount }))
      .filter((c) => c.percent > 0);
    expect([...calls].sort((a, b) => a.country.localeCompare(b.country))).toEqual(expected);
  });

  it("group mode, written out: IN takes its sort-1 group (capped), BR and US their shared group, DE (0%) none", async () => {
    const { calls } = await activate(MODES[0]!, GROUPS);
    expect([...calls].sort((a, b) => a.country.localeCompare(b.country))).toEqual([
      { country: "BR", percent: 30 },
      { country: "IN", percent: 40 },
      { country: "US", percent: 30 },
    ]);
  });

  it("custom mode never pre-creates for an override country outside the groups (FR)", async () => {
    const { calls } = await activate(MODES[1]!, GROUPS);
    expect(calls.map((c) => c.country)).not.toContain("FR");
    expect(calls).toContainEqual({ country: "IN", percent: 70 });
    expect(calls).toContainEqual({ country: "BR", percent: 25 });
  });

  it("reads the workspace's groups in one org-scoped query (no query per group)", async () => {
    const { recorder } = await activate(MODES[0]!, GROUPS);
    const groupQueries = recorder.queries.filter((q) => q.sql.includes('"parity_groups"') || q.sql.includes('"country_parity_mappings"'));
    expect(groupQueries).toHaveLength(1);
    expect(groupQueries[0]!.sql).toContain('from "parity_groups" left join "country_parity_mappings"');
    expect(groupQueries[0]!.sql).toContain('where "parity_groups"."organization_id" = $1');
    expect(groupQueries[0]!.params).toEqual([ORG]);
  });

  it("a code that already exists is skipped and the rest are still created", async () => {
    state.create = vi.fn(async (...args: unknown[]) => {
      if (args[4] === "BR") throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
      return {};
    });
    const { calls } = await activate(MODES[0]!, GROUPS);
    expect(calls.map((c) => c.country).sort()).toEqual(["BR", "IN", "US"]);
    expect(state.push).toHaveBeenCalledTimes(1);
  });
});
