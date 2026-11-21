import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { countryDiscount, workspaceParityGroupsFromList, PPP_MULTIPLIERS } from "@gopaylocal/shared/parity";
import { createMockKV, createTestBindings } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { bannerDocKey, pushBannerConfigForOrg } from "./banner-cache.service";
import { getDiscountForCountry } from "./parity.service";
import { TEST_BANNER } from "./banner-doc-test-helpers";
import {
  GROUP_MODE_SCENARIOS,
  builderGroupRows,
  fallbackGroupRows,
  type ListedParityGroup,
} from "./parity-group-fixture";

// Group-based tiers in a workspace without parity groups of its own resolve
// against the default tiers (DEFAULT_PARITY_TIERS); as soon as the workspace has
// any group, even one with no countries, only its groups are used. Before this,
// such a campaign gave 0% in every country.
//
// Three readers must agree for the same inputs (parity-group-fixture.ts):
//  - the KV banner document (pushBannerConfigForOrg),
//  - the database fallback (getDiscountForCountry),
//  - the dashboard's New Campaign preview, which calls countryDiscount with the
//    groups as GET /v1/teams/:orgId/parity-groups lists them.

const ORG = "org_1";
const CAMPAIGN_ID = "C1";
const at = (day: number) => new Date(Date.UTC(2026, 10, day));

type Mode = { pricingMode: "group" | "custom"; maxDiscountPercent: number; discountOverrides: Record<string, number> | null };

function campaignRow(mode: Mode) {
  return {
    id: CAMPAIGN_ID,
    organizationId: ORG,
    productId: "P1",
    integrationId: null,
    name: "PPP",
    status: "active",
    environment: "live",
    discountDelivery: "banner_coupon",
    charmPricingStrategy: "none",
    couponPrefix: null,
    allowedDomains: null,
    createdAt: at(1),
    updatedAt: at(1),
    ...mode,
  };
}

/** Answers each statement by the table it reads, whatever the order. */
function routedRecorder(tables: Record<string, unknown[]>): SqlRecorder {
  const r = createSqlRecorder();
  r.results = {
    shift: () => {
      const sql = r.queries[r.queries.length - 1]!.sql;
      const from = sql.match(/ from "([a-z_]+)"/)?.[1] ?? "";
      return tables[from] ?? [];
    },
  } as unknown as SqlRecorder["results"];
  return r;
}

/** The KV document's countries for a campaign over these groups. */
async function servedFromKv(mode: Mode, groups: ListedParityGroup[]) {
  const kv = createMockKV();
  const r = routedRecorder({
    api_keys: [{ id: "K1" }],
    campaigns: [
      {
        campaign: campaignRow(mode),
        banner: { id: "b1", campaignId: CAMPAIGN_ID, ...TEST_BANNER },
        product: { currency: "USD", basePrice: 19 },
      },
    ],
    experiments: [],
    parity_groups: builderGroupRows(groups),
    subscriptions: [],
    coupons: [],
  });
  await pushBannerConfigForOrg(r.db, kv, ORG, {});
  const doc = JSON.parse((await kv.get(bannerDocKey("K1")))!);
  return { countries: doc.campaigns[CAMPAIGN_ID].countries as Record<string, { discount: number; tier: number }>, recorder: r };
}

/** The database fallback's answer for one country. */
async function servedFromDb(mode: Mode, groups: ListedParityGroup[], countryCode: string) {
  const kv = { get: async () => null, put: async () => {} } as unknown as KVNamespace;
  const r = createSqlRecorder([[campaignRow(mode)], fallbackGroupRows(groups, countryCode)]);
  const result = await getDiscountForCountry(r.db, createTestBindings(), ORG, CAMPAIGN_ID, countryCode, kv);
  return { result: result!, recorder: r };
}

function preview(mode: Mode, groups: ListedParityGroup[], countryCode: string) {
  return countryDiscount(mode, countryCode, workspaceParityGroupsFromList(groups));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(GROUP_MODE_SCENARIOS)("group mode: $name", (scenario) => {
  const mode: Mode = { pricingMode: "group", maxDiscountPercent: scenario.maxDiscountPercent, discountOverrides: null };

  it("the KV banner document serves the expected discounts", async () => {
    const { countries } = await servedFromKv(mode, scenario.groups);
    for (const [cc, want] of Object.entries(scenario.served)) {
      expect({ cc, ...countries[cc] }).toMatchObject({ cc, discount: want.discount, tier: want.tier });
    }
    for (const cc of scenario.zero) expect(countries).not.toHaveProperty(cc);
  });

  it("the database fallback serves the same discounts", async () => {
    for (const [cc, want] of Object.entries(scenario.served)) {
      const { result } = await servedFromDb(mode, scenario.groups, cc);
      expect({ cc, ...result }).toEqual({ cc, discount: want.discount, tier: want.tier, code: null });
    }
    for (const cc of scenario.zero) {
      expect({ cc, discount: (await servedFromDb(mode, scenario.groups, cc)).result.discount }).toEqual({ cc, discount: 0 });
    }
  });

  it("the dashboard preview equals the served numbers in every country", async () => {
    const { countries } = await servedFromKv(mode, scenario.groups);
    const all = new Set([...Object.keys(PPP_MULTIPLIERS), ...scenario.groups.flatMap((g) => g.countries)]);
    for (const cc of all) {
      const shown = preview(mode, scenario.groups, cc);
      const kv = countries[cc] ?? { discount: 0, tier: 0 };
      const db = (await servedFromDb(mode, scenario.groups, cc)).result;
      expect({ cc, preview: shown.discount, db: db.discount }).toEqual({ cc, preview: kv.discount, db: kv.discount });
      if (shown.discount > 0) expect({ cc, tier: shown.tier }).toEqual({ cc, tier: kv.tier });
    }
  });
});

describe("custom mode is unchanged", () => {
  // Documented: a country without its own percentage falls back to its parity
  // group, and to 0% while the workspace has none. The default tiers are not
  // applied to custom campaigns.
  const mode: Mode = { pricingMode: "custom", maxDiscountPercent: 70, discountOverrides: { IN: 40 } };

  it("without parity groups, a country without an override gets 0% on every path", async () => {
    const { countries } = await servedFromKv(mode, []);
    expect(countries.IN).toMatchObject({ discount: 40 });
    expect(countries).not.toHaveProperty("BR");
    expect((await servedFromDb(mode, [], "BR")).result.discount).toBe(0);
    expect(preview(mode, [], "BR").discount).toBe(0);
    expect(preview(mode, [], "IN").discount).toBe(40);
  });

  it("with a group, a country without an override gets that group", async () => {
    const groups = [{ id: "grp_1", discountPercent: 30, sortOrder: 2, countries: ["BR"] }];
    const { countries } = await servedFromKv(mode, groups);
    expect(countries.BR).toMatchObject({ discount: 30, tier: 2 });
    expect((await servedFromDb(mode, groups, "BR")).result).toMatchObject({ discount: 30, tier: 2 });
    expect(preview(mode, groups, "BR")).toEqual({ discount: 30, tier: 2 });
  });
});

describe("queries", () => {
  const mode: Mode = { pricingMode: "group", maxDiscountPercent: 70, discountOverrides: null };

  it("the builder reads every group of the workspace, with or without countries (one left join)", async () => {
    const { recorder } = await servedFromKv(mode, []);
    const q = recorder.queries.find((x) => x.sql.includes(' from "parity_groups"'))!;
    expect(q.sql).toContain('from "parity_groups" left join "country_parity_mappings" on "country_parity_mappings"."parity_group_id" = "parity_groups"."id"');
    expect(q.sql).toContain('where "parity_groups"."organization_id" = $1');
    expect(q.params).toEqual([ORG]);
    expect(recorder.queries.some((x) => x.sql.includes(' from "country_parity_mappings"'))).toBe(false);
  });

  it("the fallback answers 'no groups', 'unmapped' and 'mapped' in one org-scoped query", async () => {
    const { recorder } = await servedFromDb(mode, [], "IN");
    const q = recorder.queries[1]!;
    expect(q.sql).toContain('from "parity_groups" left join "country_parity_mappings" on ("country_parity_mappings"."parity_group_id" = "parity_groups"."id" and "country_parity_mappings"."country_code" = $1)');
    expect(q.sql).toContain('where "parity_groups"."organization_id" = $2');
    expect(q.sql).toContain('order by "country_parity_mappings"."country_code" is null, "parity_groups"."sort_order" asc, "parity_groups"."id" asc limit $3');
    expect(q.params).toEqual(["IN", ORG, 1]);
    expect(recorder.queries).toHaveLength(2);
  });
});
