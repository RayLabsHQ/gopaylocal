import { describe, it, expect } from 'vitest';
import {
  PPP_MULTIPLIERS,
  DEFAULT_PARITY_TIERS,
  getParityTier,
  calculatePppDiscount,
  countryDiscount,
  defaultTierGroup,
  parityGroupFor,
  workspaceParityGroups,
  workspaceParityGroupsFromList,
} from './index.js';

// ── PPP_MULTIPLIERS ──────────────────────────────────────────────────────────

describe('PPP_MULTIPLIERS', () => {
  it('US multiplier is 1.0', () => {
    expect(PPP_MULTIPLIERS.US).toBe(1.0);
  });

  it('IN multiplier is 0.20', () => {
    expect(PPP_MULTIPLIERS.IN).toBe(0.20);
  });

  it('BR multiplier is 0.44', () => {
    expect(PPP_MULTIPLIERS.BR).toBe(0.44);
  });

  it('has correct multipliers for at least 10 countries', () => {
    expect(PPP_MULTIPLIERS.CH).toBe(1.05);
    expect(PPP_MULTIPLIERS.NO).toBe(1.02);
    expect(PPP_MULTIPLIERS.DK).toBe(0.98);
    expect(PPP_MULTIPLIERS.AU).toBe(0.96);
    expect(PPP_MULTIPLIERS.GB).toBe(0.89);
    expect(PPP_MULTIPLIERS.JP).toBe(0.82);
    expect(PPP_MULTIPLIERS.MX).toBe(0.52);
    expect(PPP_MULTIPLIERS.ZA).toBe(0.42);
    expect(PPP_MULTIPLIERS.PH).toBe(0.30);
    expect(PPP_MULTIPLIERS.VE).toBe(0.10);
  });

  it('all multipliers are positive numbers', () => {
    for (const [code, multiplier] of Object.entries(PPP_MULTIPLIERS)) {
      expect(multiplier).toBeGreaterThan(0);
      expect(typeof multiplier).toBe('number');
    }
  });

  it('all keys are 2-char uppercase country codes', () => {
    for (const code of Object.keys(PPP_MULTIPLIERS)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});

// ── DEFAULT_PARITY_TIERS ─────────────────────────────────────────────────────

describe('DEFAULT_PARITY_TIERS', () => {
  it('has exactly 5 tiers', () => {
    expect(DEFAULT_PARITY_TIERS).toHaveLength(5);
  });

  it('tiers have correct discount percentages', () => {
    const discounts = DEFAULT_PARITY_TIERS.map((t) => t.discountPercent);
    expect(discounts).toEqual([0, 20, 35, 50, 65]);
  });

  it('tiers have correct sort orders 1-5', () => {
    const sortOrders = DEFAULT_PARITY_TIERS.map((t) => t.sortOrder);
    expect(sortOrders).toEqual([1, 2, 3, 4, 5]);
  });

  it('each tier has a non-empty name', () => {
    for (const tier of DEFAULT_PARITY_TIERS) {
      expect(tier.name.length).toBeGreaterThan(0);
    }
  });

  it('each tier has at least one country assigned', () => {
    for (const tier of DEFAULT_PARITY_TIERS) {
      expect(tier.countries.length).toBeGreaterThan(0);
    }
  });

  it('no country appears in multiple tiers', () => {
    const seen = new Set<string>();
    for (const tier of DEFAULT_PARITY_TIERS) {
      for (const country of tier.countries) {
        expect(seen.has(country)).toBe(false);
        seen.add(country);
      }
    }
  });

  it('all country codes in tiers are 2-char uppercase', () => {
    for (const tier of DEFAULT_PARITY_TIERS) {
      for (const country of tier.countries) {
        expect(country).toMatch(/^[A-Z]{2}$/);
      }
    }
  });

  it('tier 1 includes US and other high-parity countries', () => {
    const tier1 = DEFAULT_PARITY_TIERS[0]!;
    expect(tier1.countries).toContain('US');
    expect(tier1.countries).toContain('CH');
    expect(tier1.countries).toContain('GB');
    expect(tier1.countries).toContain('DE');
  });

  it('tier 5 includes low-PPP countries', () => {
    const tier5 = DEFAULT_PARITY_TIERS[4]!;
    expect(tier5.countries).toContain('IN');
    expect(tier5.countries).toContain('PK');
    expect(tier5.countries).toContain('BD');
  });
});

// ── getParityTier ────────────────────────────────────────────────────────────

describe('getParityTier', () => {
  it('returns 1 for US', () => {
    expect(getParityTier('US')).toBe(1);
  });

  it('returns 5 for IN', () => {
    expect(getParityTier('IN')).toBe(5);
  });

  it('returns 2 for PT (tier 2 country)', () => {
    expect(getParityTier('PT')).toBe(2);
  });

  it('returns 3 for BR (tier 3 country)', () => {
    expect(getParityTier('BR')).toBe(3);
  });

  it('returns 4 for PH (tier 4 country)', () => {
    expect(getParityTier('PH')).toBe(4);
  });

  it('returns null for unknown country code ZZ', () => {
    expect(getParityTier('ZZ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getParityTier('')).toBeNull();
  });

  it('handles lowercase input by converting to uppercase', () => {
    expect(getParityTier('us')).toBe(1);
    expect(getParityTier('in')).toBe(5);
  });

  it('returns null for a nonsense code', () => {
    expect(getParityTier('XX')).toBeNull();
    expect(getParityTier('00')).toBeNull();
  });
});

// ── calculatePppDiscount ─────────────────────────────────────────────────────

describe('calculatePppDiscount', () => {
  it('returns 0 for US (multiplier 1.0)', () => {
    expect(calculatePppDiscount('US')).toBe(0);
  });

  it('returns 0 for CH (multiplier > 1.0, so raw discount would be negative)', () => {
    // CH multiplier is 1.05 -> raw = (1 - 1.05) * 100 = -5, clamped to 0
    expect(calculatePppDiscount('CH')).toBe(0);
  });

  it('returns capped discount for IN (multiplier 0.20)', () => {
    // raw = (1 - 0.20) * 100 = 80, capped at 70
    expect(calculatePppDiscount('IN')).toBe(70);
  });

  it('returns correct discount for BR (multiplier 0.44)', () => {
    // raw = (1 - 0.44) * 100 = 56
    expect(calculatePppDiscount('BR')).toBe(56);
  });

  it('returns correct discount for MX (multiplier 0.52)', () => {
    // raw = (1 - 0.52) * 100 = 48
    expect(calculatePppDiscount('MX')).toBe(48);
  });

  it('returns correct discount for PH (multiplier 0.30)', () => {
    // raw = (1 - 0.30) * 100 = 70, at exactly the cap
    expect(calculatePppDiscount('PH')).toBe(70);
  });

  it('returns 0 for unknown country', () => {
    expect(calculatePppDiscount('ZZ')).toBe(0);
    expect(calculatePppDiscount('XX')).toBe(0);
  });

  it('respects custom maxDiscount cap', () => {
    // IN: raw = 80, should cap at 50 when maxDiscount is 50
    expect(calculatePppDiscount('IN', 50)).toBe(50);
  });

  it('custom maxDiscount does not affect countries below the cap', () => {
    // MX: raw = 48, maxDiscount = 50 -> still 48
    expect(calculatePppDiscount('MX', 50)).toBe(48);
  });

  it('maxDiscount of 100 allows full discount', () => {
    // IN: raw = 80
    expect(calculatePppDiscount('IN', 100)).toBe(80);
  });

  it('maxDiscount of 0 always returns 0 for countries needing discount', () => {
    expect(calculatePppDiscount('IN', 0)).toBe(0);
    expect(calculatePppDiscount('BR', 0)).toBe(0);
  });

  it('handles lowercase country codes', () => {
    expect(calculatePppDiscount('us')).toBe(0);
    expect(calculatePppDiscount('in')).toBe(70);
    expect(calculatePppDiscount('br')).toBe(56);
  });

  it('returns rounded values', () => {
    // GB: raw = (1 - 0.89) * 100 = 11.000...0001 (floating point), rounds to 11
    const result = calculatePppDiscount('GB');
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(11);
  });
});

// ── Group resolution (shared by the API and the dashboard preview) ──────────

describe('defaultTierGroup', () => {
  it('gives each default-tier country its tier as a group', () => {
    for (const tier of DEFAULT_PARITY_TIERS) {
      for (const cc of tier.countries) {
        expect(defaultTierGroup(cc)).toEqual({ discountPercent: tier.discountPercent, sortOrder: tier.sortOrder });
      }
    }
    expect(defaultTierGroup('in')).toEqual({ discountPercent: 65, sortOrder: 5 });
    expect(defaultTierGroup('ZZ')).toBeNull();
  });
});

describe('workspace parity groups', () => {
  it('a group without countries still counts as the workspace having groups', () => {
    const fromList = workspaceParityGroupsFromList([{ id: 'g1', discountPercent: 40, sortOrder: 1, countries: [] }]);
    expect(fromList.hasOwnGroups).toBe(true);
    expect(fromList.byCountry.size).toBe(0);
    const fromRows = workspaceParityGroups([{ groupId: 'g1', discountPercent: 40, sortOrder: 1, countryCode: null }]);
    expect(fromRows).toEqual(fromList);
    expect(workspaceParityGroups([]).hasOwnGroups).toBe(false);
    expect(workspaceParityGroupsFromList([]).hasOwnGroups).toBe(false);
  });

  it('the list and the rows give the same map, with the same tie-break', () => {
    const list = [
      { id: 'g_b', discountPercent: 30, sortOrder: 2, countries: ['IN', 'BR'] },
      { id: 'g_a', discountPercent: 50, sortOrder: 2, countries: ['IN'] },
    ];
    const rows = list.flatMap((g) =>
      g.countries.map((countryCode) => ({ groupId: g.id, discountPercent: g.discountPercent, sortOrder: g.sortOrder, countryCode })),
    );
    expect(workspaceParityGroupsFromList(list)).toEqual(workspaceParityGroups(rows));
    expect(workspaceParityGroupsFromList(list).byCountry.get('IN')).toEqual({ discountPercent: 50, sortOrder: 2 });
  });
});

describe('parityGroupFor and countryDiscount', () => {
  const none = workspaceParityGroupsFromList([]);
  const own = workspaceParityGroupsFromList([{ id: 'g1', discountPercent: 40, sortOrder: 1, countries: ['IN'] }]);
  const group = { pricingMode: 'group', maxDiscountPercent: 70, discountOverrides: null };
  const custom = { pricingMode: 'custom', maxDiscountPercent: 70, discountOverrides: { IN: 10 } };

  it('group mode without groups of its own uses the default tiers', () => {
    expect(parityGroupFor('group', 'BR', null, false)).toEqual({ discountPercent: 35, sortOrder: 3 });
    expect(countryDiscount(group, 'BR', none)).toEqual({ discount: 35, tier: 3 });
    expect(countryDiscount({ ...group, maxDiscountPercent: 30 }, 'IN', none)).toEqual({ discount: 30, tier: 5 });
  });

  it('group mode with groups of its own never mixes in the default tiers', () => {
    expect(parityGroupFor('group', 'BR', null, true)).toBeNull();
    expect(countryDiscount(group, 'BR', own)).toEqual({ discount: 0, tier: 0 });
    expect(countryDiscount(group, 'IN', own)).toEqual({ discount: 40, tier: 1 });
  });

  it("custom mode's fallback is the workspace's own group only", () => {
    expect(parityGroupFor('custom', 'BR', null, false)).toBeNull();
    expect(countryDiscount(custom, 'BR', none)).toEqual({ discount: 0, tier: 0 });
    expect(countryDiscount(custom, 'IN', none)).toEqual({ discount: 10, tier: 1 });
  });

  it('ppp_factor ignores groups', () => {
    // IN's multiplier is 0.20, which the PPP tier thresholds put in tier 4.
    expect(countryDiscount({ ...group, pricingMode: 'ppp_factor' }, 'IN', own)).toEqual({ discount: 70, tier: 4 });
    expect(countryDiscount({ ...group, pricingMode: 'ppp_factor' }, 'IN', none)).toEqual({ discount: 70, tier: 4 });
  });
});
