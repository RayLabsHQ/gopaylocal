// Test fixture: group-mode campaigns over different sets of parity groups.
// One fixture feeds both sides of the comparison in parity-group-defaults.test.ts:
// the served numbers (the KV banner document and the database fallback) and the
// dashboard's New Campaign preview (the shared countryDiscount function the page
// calls, fed with the groups in the shape GET /v1/teams/:orgId/parity-groups
// returns).

import type { ParityGroupRow } from "@gopaylocal/shared/parity";

/** A parity group as GET /v1/teams/:orgId/parity-groups returns it. */
export interface ListedParityGroup {
  id: string;
  discountPercent: number;
  sortOrder: number;
  countries: string[];
}

export interface GroupModeScenario {
  name: string;
  groups: ListedParityGroup[];
  maxDiscountPercent: number;
  /** What a group-mode campaign serves per country (written out, not derived). */
  served: Record<string, { discount: number; tier: number }>;
  /** Countries that get no discount. */
  zero: string[];
}

export const GROUP_MODE_SCENARIOS: GroupModeScenario[] = [
  {
    // One country per default tier: US (tier 1, 0%), PT, BR, PH, IN.
    name: "a workspace without parity groups uses the default tiers",
    groups: [],
    maxDiscountPercent: 70,
    served: {
      PT: { discount: 20, tier: 2 },
      BR: { discount: 35, tier: 3 },
      PH: { discount: 50, tier: 4 },
      IN: { discount: 65, tier: 5 },
    },
    zero: ["US"],
  },
  {
    name: "the default tiers are capped at the campaign's maximum",
    groups: [],
    maxDiscountPercent: 40,
    served: {
      PT: { discount: 20, tier: 2 },
      BR: { discount: 35, tier: 3 },
      PH: { discount: 40, tier: 4 },
      IN: { discount: 40, tier: 5 },
    },
    zero: ["US"],
  },
  {
    name: "a workspace with one group of its own uses only that group",
    groups: [{ id: "grp_1", discountPercent: 40, sortOrder: 1, countries: ["IN"] }],
    maxDiscountPercent: 70,
    served: { IN: { discount: 40, tier: 1 } },
    zero: ["US", "PT", "BR", "PH"],
  },
  {
    name: "a group with no countries still turns the default tiers off",
    groups: [{ id: "grp_1", discountPercent: 40, sortOrder: 1, countries: [] }],
    maxDiscountPercent: 70,
    served: {},
    zero: ["US", "PT", "BR", "PH", "IN"],
  },
  {
    name: "a country in two groups takes the lowest sort order, then the lowest id",
    groups: [
      { id: "grp_b", discountPercent: 30, sortOrder: 2, countries: ["IN", "BR"] },
      { id: "grp_a", discountPercent: 50, sortOrder: 1, countries: ["IN"] },
      { id: "grp_c", discountPercent: 25, sortOrder: 2, countries: ["BR"] },
    ],
    maxDiscountPercent: 70,
    served: {
      IN: { discount: 50, tier: 1 },
      BR: { discount: 30, tier: 2 },
    },
    zero: ["US", "PT", "PH"],
  },
];

/** The (group, mapping) rows the KV builder's left join returns for these groups. */
export function builderGroupRows(groups: ListedParityGroup[]): ParityGroupRow[] {
  return groups.flatMap((g): ParityGroupRow[] =>
    g.countries.length > 0
      ? g.countries.map((countryCode) => ({ groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder, countryCode }))
      : [{ groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder, countryCode: null }],
  );
}

/**
 * The rows the database fallback's single-country query returns, as Postgres
 * would: nothing when the workspace has no groups; else the country's group
 * (lowest sort order, then lowest id), or one unmapped group row with a null
 * country code.
 */
export function fallbackGroupRows(groups: ListedParityGroup[], countryCode: string) {
  if (groups.length === 0) return [];
  const order = (a: ListedParityGroup, b: ListedParityGroup) =>
    a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const mapped = groups.filter((g) => g.countries.includes(countryCode)).sort(order)[0];
  const row = mapped ?? [...groups].sort(order)[0]!;
  return [{ discountPercent: row.discountPercent, sortOrder: row.sortOrder, countryCode: mapped ? countryCode : null }];
}
