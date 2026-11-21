// ── PPP Multipliers ─────────────────────────────────────────────────────────
// Purchasing Power Parity multipliers relative to USD.
// A multiplier of 0.3 means local purchasing power is ~30% of the US,
// suggesting a ~70% discount is needed for parity.
// The table is GoPayLocal's own, compiled from several public sources,
// including World Bank purchasing-power data and the Big Mac Index. It is not
// a copy of any one of them.

export const PPP_MULTIPLIERS: Record<string, number> = {
  // Tier 1 — Parity (no discount)
  US: 1.0, CH: 1.05, NO: 1.02, DK: 0.98, AU: 0.96,
  SE: 0.95, IE: 0.95, NL: 0.94, AT: 0.93, FI: 0.92,
  DE: 0.91, CA: 0.90, BE: 0.90, GB: 0.89, FR: 0.88,
  NZ: 0.87, SG: 0.87, IL: 0.86, QA: 0.85, AE: 0.84,
  KW: 0.83, HK: 0.82, JP: 0.82, KR: 0.81, IT: 0.80,
  ES: 0.79, TW: 0.78,

  // Tier 2 — Mild discount
  PT: 0.72, CZ: 0.70, SA: 0.70, PL: 0.65, CL: 0.63,
  HU: 0.62, CR: 0.61, PA: 0.60, RO: 0.58, UY: 0.57,
  BH: 0.56, TR: 0.55, MY: 0.53, MX: 0.52, TH: 0.50,

  // Tier 3 — Medium discount
  AR: 0.45, BR: 0.44, CO: 0.43, ZA: 0.42, PE: 0.40,
  CN: 0.40, DO: 0.38, JO: 0.37, EC: 0.36, GT: 0.35,
  TN: 0.34, MA: 0.33, LB: 0.32,

  // Tier 4 — Strong discount
  PH: 0.30, ID: 0.28, VN: 0.27, UA: 0.26, EG: 0.25,
  LK: 0.24, GH: 0.23, KH: 0.22, NG: 0.21,

  // Tier 5 — Maximum discount
  IN: 0.20, PK: 0.18, BD: 0.17, NP: 0.16, KE: 0.15,
  TZ: 0.14, UG: 0.14, ET: 0.13, MM: 0.12, LA: 0.11,
  VE: 0.10,
};

// ── Default Parity Tiers ────────────────────────────────────────────────────

export interface DefaultParityTier {
  name: string;
  discountPercent: number;
  sortOrder: number;
  countries: string[];
}

export const DEFAULT_PARITY_TIERS: DefaultParityTier[] = [
  {
    name: 'Tier 1 — Parity',
    discountPercent: 0,
    sortOrder: 1,
    countries: [
      'US', 'CH', 'NO', 'DK', 'AU', 'SE', 'IE', 'NL', 'AT', 'FI',
      'DE', 'CA', 'BE', 'GB', 'FR', 'NZ', 'SG', 'IL', 'QA', 'AE',
      'KW', 'HK', 'JP', 'KR', 'IT', 'ES', 'TW',
    ],
  },
  {
    name: 'Tier 2 — Mild Discount',
    discountPercent: 20,
    sortOrder: 2,
    countries: [
      'PT', 'CZ', 'SA', 'PL', 'CL', 'HU', 'CR', 'PA', 'RO', 'UY',
      'BH', 'TR', 'MY', 'MX', 'TH',
    ],
  },
  {
    name: 'Tier 3 — Medium Discount',
    discountPercent: 35,
    sortOrder: 3,
    countries: [
      'AR', 'BR', 'CO', 'ZA', 'PE', 'CN', 'DO', 'JO', 'EC', 'GT',
      'TN', 'MA', 'LB',
    ],
  },
  {
    name: 'Tier 4 — Strong Discount',
    discountPercent: 50,
    sortOrder: 4,
    countries: [
      'PH', 'ID', 'VN', 'UA', 'EG', 'LK', 'GH', 'KH', 'NG',
    ],
  },
  {
    name: 'Tier 5 — Maximum Discount',
    discountPercent: 65,
    sortOrder: 5,
    countries: [
      'IN', 'PK', 'BD', 'NP', 'KE', 'TZ', 'UG', 'ET', 'MM', 'LA', 'VE',
    ],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Get the parity tier index (1-5) for a country code, or null if unknown. */
export function getParityTier(countryCode: string): number | null {
  const idx = DEFAULT_PARITY_TIERS.findIndex((tier) =>
    tier.countries.includes(countryCode.toUpperCase()),
  );
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Calculate discount percentage based on PPP multiplier.
 * Discount = (1 - multiplier) * 100, clamped to [0, maxDiscount].
 */
export function calculatePppDiscount(
  countryCode: string,
  maxDiscount: number = 70,
): number {
  const multiplier = PPP_MULTIPLIERS[countryCode.toUpperCase()];
  if (multiplier == null) return 0;
  const raw = (1 - multiplier) * 100;
  return Math.min(Math.max(Math.round(raw), 0), maxDiscount);
}

// ── Discount per country ────────────────────────────────────────────────────
// One implementation for every reader: the API's KV banner document, its
// database fallback and the dashboard's New Campaign preview.

/** A country's parity group, as discounts read it. */
export interface CountryGroup {
  discountPercent: number;
  sortOrder: number;
}

/** A workspace's parity groups, as discounts read them. */
export interface WorkspaceParityGroups {
  /** Country -> its group (lowest sort order, then lowest group id, if in several). */
  byCountry: ReadonlyMap<string, CountryGroup>;
  /** True when the workspace has any parity group of its own, even one without countries. */
  hasOwnGroups: boolean;
}

/** One (group, country) pair; `countryCode` is null for a group without countries. */
export interface ParityGroupRow {
  groupId: string;
  discountPercent: number;
  sortOrder: number;
  countryCode: string | null;
}

/** A parity group with its countries, as GET /v1/teams/:orgId/parity-groups lists it. */
export interface ListedParityGroup {
  id: string;
  discountPercent: number;
  sortOrder: number;
  countries: readonly string[];
}

/** The campaign fields the discount computation reads. */
export interface DiscountCampaign {
  pricingMode: string;
  maxDiscountPercent: number;
  discountOverrides: unknown;
}

let defaultGroupByCountry: Map<string, CountryGroup> | null = null;

/** The default tier a country is in, as a group (null for a country in no tier). */
export function defaultTierGroup(countryCode: string): CountryGroup | null {
  if (!defaultGroupByCountry) {
    defaultGroupByCountry = new Map();
    for (const tier of DEFAULT_PARITY_TIERS) {
      for (const cc of tier.countries) {
        if (!defaultGroupByCountry.has(cc)) {
          defaultGroupByCountry.set(cc, { discountPercent: tier.discountPercent, sortOrder: tier.sortOrder });
        }
      }
    }
  }
  return defaultGroupByCountry.get(countryCode.toUpperCase()) ?? null;
}

/**
 * Country -> parity group from (group, country) rows. A country in several
 * groups resolves to the lowest sort order, then the lowest group id. Rows
 * without a country are skipped.
 */
export function pickCountryGroups(rows: readonly ParityGroupRow[]): Map<string, CountryGroup> {
  const best = new Map<string, { groupId: string; group: CountryGroup }>();
  for (const row of rows) {
    if (!row.countryCode) continue;
    const current = best.get(row.countryCode);
    const better =
      !current ||
      row.sortOrder < current.group.sortOrder ||
      (row.sortOrder === current.group.sortOrder && row.groupId < current.groupId);
    if (better) {
      best.set(row.countryCode, {
        groupId: row.groupId,
        group: { discountPercent: row.discountPercent, sortOrder: row.sortOrder },
      });
    }
  }
  return new Map([...best].map(([cc, v]) => [cc, v.group]));
}

/** A workspace's parity groups from (group, country) rows; one row per group at least. */
export function workspaceParityGroups(rows: readonly ParityGroupRow[]): WorkspaceParityGroups {
  return { byCountry: pickCountryGroups(rows), hasOwnGroups: rows.length > 0 };
}

/** A workspace's parity groups from the groups as the API lists them. */
export function workspaceParityGroupsFromList(groups: readonly ListedParityGroup[]): WorkspaceParityGroups {
  const rows: ParityGroupRow[] = [];
  for (const g of groups) {
    const base = { groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder };
    if (g.countries.length === 0) rows.push({ ...base, countryCode: null });
    for (const countryCode of g.countries) rows.push({ ...base, countryCode });
  }
  return { byCountry: pickCountryGroups(rows), hasOwnGroups: groups.length > 0 };
}

/**
 * The group that prices a country. Group-based tiers in a workspace without
 * any parity group of its own use the default tiers; once the workspace has a
 * group, only its own groups count (no mixing). Custom mode's fallback is the
 * workspace's own group only.
 */
export function parityGroupFor(
  pricingMode: string,
  countryCode: string,
  ownGroup: CountryGroup | null,
  hasOwnGroups: boolean,
): CountryGroup | null {
  if (pricingMode === "group" && !hasOwnGroups) return defaultTierGroup(countryCode);
  return ownGroup;
}

/** True when this campaign/country needs the parity group to price it. */
export function needsParityGroup(campaign: DiscountCampaign, countryCode: string): boolean {
  if (campaign.pricingMode === "group") return true;
  if (campaign.pricingMode !== "custom") return false;
  const overrides = campaign.discountOverrides as Record<string, unknown> | null;
  return !overrides || overrides[countryCode] === undefined;
}

/**
 * Discount and tier for one country, given the group that prices it
 * (parityGroupFor):
 *  - group: the group's percent, capped at maxDiscountPercent
 *  - ppp_factor: from PPP_MULTIPLIERS, capped at maxDiscountPercent
 *  - custom: the country's override (capped); no override -> its group
 */
export function computeCountryDiscount(
  campaign: DiscountCampaign,
  countryCode: string,
  group: CountryGroup | null,
): { discount: number; tier: number } {
  const max = campaign.maxDiscountPercent;
  const fromGroup = () =>
    group ? { discount: Math.min(group.discountPercent, max), tier: group.sortOrder } : { discount: 0, tier: 0 };

  switch (campaign.pricingMode) {
    case "custom": {
      const overrides = campaign.discountOverrides as Record<string, unknown> | null;
      const override = overrides ? overrides[countryCode] : undefined;
      if (override !== undefined) {
        const discount = Math.min(Number(override) || 0, max);
        return { discount, tier: discount > 0 ? Math.ceil(discount / 15) : 0 };
      }
      return fromGroup();
    }
    case "ppp_factor": {
      const discount = calculatePppDiscount(countryCode, max);
      const multiplier = PPP_MULTIPLIERS[countryCode];
      let tier = 0;
      if (multiplier != null) {
        if (multiplier >= 0.8) tier = 1;
        else if (multiplier >= 0.5) tier = 2;
        else if (multiplier >= 0.3) tier = 3;
        else if (multiplier >= 0.2) tier = 4;
        else tier = 5;
      }
      return { discount, tier };
    }
    case "group":
      return fromGroup();
    default:
      return { discount: 0, tier: 0 };
  }
}

/** Discount and tier for one country over a workspace's parity groups. */
export function countryDiscount(
  campaign: DiscountCampaign,
  countryCode: string,
  groups: WorkspaceParityGroups,
): { discount: number; tier: number } {
  const group = parityGroupFor(campaign.pricingMode, countryCode, groups.byCountry.get(countryCode) ?? null, groups.hasOwnGroups);
  return computeCountryDiscount(campaign, countryCode, group);
}
