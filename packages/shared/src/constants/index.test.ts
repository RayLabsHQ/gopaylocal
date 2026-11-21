import { describe, it, expect } from 'vitest';
import {
  PLAN_LIMITS,
  COUNTRY_NAMES,
  CURRENCY_BY_COUNTRY,
  CURRENCY_SYMBOLS,
  API_KEY_PREFIX_PUBLIC,
  API_KEY_PREFIX_SECRET,
  BANNER_DEFAULTS,
  LIMIT_ALERT_THRESHOLD,
  DEFAULT_BANNER_MESSAGE,
  DEFAULT_CTA_TEXT,
  KNOWN_DATACENTER_ORGS,
  SELF_HOSTED_LIMITS,
  PLAN_PRICES_USD,
  PRO_FAIR_USE_API_HITS_PER_MONTH,
  normalizePlan,
  isUnlimited,
  hasReachedLimit,
  remainingUnder,
  limitUsageRatio,
  formatLimit,
} from './index.js';

// ── PLAN_LIMITS ──────────────────────────────────────────────────────────────

describe('PLAN_LIMITS', () => {
  it('has exactly two plans: free and pro', () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(['free', 'pro']);
  });

  it('free plan: 1 product, 10K API calls/month, 1 seat, 7-day analytics', () => {
    expect(PLAN_LIMITS.free).toEqual({
      products: 1,
      apiHitsPerMonth: 10_000,
      teamMembers: 1,
      analyticsRetentionDays: 7,
    });
  });

  it('pro plan: unlimited products, API calls and seats, 365-day analytics', () => {
    expect(PLAN_LIMITS.pro).toEqual({
      products: null,
      apiHitsPerMonth: null,
      teamMembers: null,
      analyticsRetentionDays: 365,
    });
  });

  it('represents unlimited as null, never Infinity, so it survives JSON', () => {
    for (const limits of [PLAN_LIMITS.free, PLAN_LIMITS.pro, SELF_HOSTED_LIMITS]) {
      for (const value of Object.values(limits)) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(limits))).toEqual(limits);
    }
  });
});

describe('SELF_HOSTED_LIMITS', () => {
  it('is unlimited on every dimension', () => {
    expect(SELF_HOSTED_LIMITS).toEqual({
      products: null,
      apiHitsPerMonth: null,
      teamMembers: null,
      analyticsRetentionDays: null,
    });
  });
});

describe('PLAN_PRICES_USD', () => {
  it('Pro is $19/month or $180/year ($15/month billed annually)', () => {
    expect(PLAN_PRICES_USD.pro.month).toBe(19);
    expect(PLAN_PRICES_USD.pro.year).toBe(180);
    expect(PLAN_PRICES_USD.pro.year / 12).toBe(15);
  });

  it('Free costs nothing', () => {
    expect(PLAN_PRICES_USD.free).toEqual({ month: 0, year: 0 });
  });
});

describe('PRO_FAIR_USE_API_HITS_PER_MONTH', () => {
  it('is 20M calls/month', () => {
    expect(PRO_FAIR_USE_API_HITS_PER_MONTH).toBe(20_000_000);
  });
});

// ── Plan + limit helpers ─────────────────────────────────────────────────────

describe('normalizePlan', () => {
  it('passes free and pro through', () => {
    expect(normalizePlan('free')).toBe('free');
    expect(normalizePlan('pro')).toBe('pro');
  });

  it('folds the legacy business tier into pro', () => {
    expect(normalizePlan('business')).toBe('pro');
  });

  it('rejects unknown values', () => {
    expect(normalizePlan('enterprise')).toBeNull();
    expect(normalizePlan('PRO')).toBeNull();
    expect(normalizePlan('')).toBeNull();
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan(undefined)).toBeNull();
    expect(normalizePlan(1)).toBeNull();
  });
});

describe('isUnlimited', () => {
  it('is true only for null', () => {
    expect(isUnlimited(null)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(10_000)).toBe(false);
  });
});

describe('hasReachedLimit', () => {
  it('compares against a finite cap', () => {
    expect(hasReachedLimit(0, 1)).toBe(false);
    expect(hasReachedLimit(1, 1)).toBe(true);
    expect(hasReachedLimit(2, 1)).toBe(true);
  });

  it('is never reached when unlimited', () => {
    expect(hasReachedLimit(0, null)).toBe(false);
    expect(hasReachedLimit(Number.MAX_SAFE_INTEGER, null)).toBe(false);
  });

  it('treats a zero cap as reached', () => {
    expect(hasReachedLimit(0, 0)).toBe(true);
  });
});

describe('remainingUnder', () => {
  it('returns headroom, floored at zero', () => {
    expect(remainingUnder(1, 0)).toBe(1);
    expect(remainingUnder(1, 1)).toBe(0);
    expect(remainingUnder(1, 5)).toBe(0);
  });

  it('returns null when unlimited', () => {
    expect(remainingUnder(null, 0)).toBeNull();
    expect(remainingUnder(null, 1_000_000)).toBeNull();
  });
});

describe('limitUsageRatio', () => {
  it('returns the consumed fraction of a finite cap', () => {
    expect(limitUsageRatio(8_000, 10_000)).toBe(0.8);
    expect(limitUsageRatio(12_000, 10_000)).toBe(1.2);
    expect(limitUsageRatio(0, 10_000)).toBe(0);
  });

  it('returns null for an unlimited cap (no division)', () => {
    expect(limitUsageRatio(50_000_000, null)).toBeNull();
  });

  it('treats a zero cap as fully consumed instead of dividing by zero', () => {
    expect(limitUsageRatio(0, 0)).toBe(1);
    expect(limitUsageRatio(5, 0)).toBe(1);
  });
});

describe('formatLimit', () => {
  it('formats finite caps with separators and unlimited as "Unlimited"', () => {
    expect(formatLimit(10_000)).toBe('10,000');
    expect(formatLimit(1)).toBe('1');
    expect(formatLimit(null)).toBe('Unlimited');
  });
});

// ── COUNTRY_NAMES ────────────────────────────────────────────────────────────

describe('COUNTRY_NAMES', () => {
  it('has at least 150 entries', () => {
    expect(Object.keys(COUNTRY_NAMES).length).toBeGreaterThanOrEqual(150);
  });

  it('all country codes are 2-char uppercase strings', () => {
    for (const code of Object.keys(COUNTRY_NAMES)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('contains well-known countries', () => {
    expect(COUNTRY_NAMES.US).toBe('United States');
    expect(COUNTRY_NAMES.GB).toBe('United Kingdom');
    expect(COUNTRY_NAMES.IN).toBe('India');
    expect(COUNTRY_NAMES.BR).toBe('Brazil');
    expect(COUNTRY_NAMES.JP).toBe('Japan');
    expect(COUNTRY_NAMES.AU).toBe('Australia');
    expect(COUNTRY_NAMES.DE).toBe('Germany');
    expect(COUNTRY_NAMES.FR).toBe('France');
  });

  it('all values are non-empty strings', () => {
    for (const name of Object.values(COUNTRY_NAMES)) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

// ── CURRENCY_BY_COUNTRY ──────────────────────────────────────────────────────

describe('CURRENCY_BY_COUNTRY', () => {
  it('maps to valid 3-char currency codes', () => {
    for (const currency of Object.values(CURRENCY_BY_COUNTRY)) {
      expect(currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('maps well-known countries to expected currencies', () => {
    expect(CURRENCY_BY_COUNTRY.US).toBe('USD');
    expect(CURRENCY_BY_COUNTRY.GB).toBe('GBP');
    expect(CURRENCY_BY_COUNTRY.JP).toBe('JPY');
    expect(CURRENCY_BY_COUNTRY.IN).toBe('INR');
    expect(CURRENCY_BY_COUNTRY.BR).toBe('BRL');
    expect(CURRENCY_BY_COUNTRY.DE).toBe('EUR');
    expect(CURRENCY_BY_COUNTRY.FR).toBe('EUR');
    expect(CURRENCY_BY_COUNTRY.AU).toBe('AUD');
    expect(CURRENCY_BY_COUNTRY.CA).toBe('CAD');
  });

  it('all keys are 2-char uppercase country codes', () => {
    for (const code of Object.keys(CURRENCY_BY_COUNTRY)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});

// ── CURRENCY_SYMBOLS ─────────────────────────────────────────────────────────

describe('CURRENCY_SYMBOLS', () => {
  it('has entries for major currencies', () => {
    expect(CURRENCY_SYMBOLS.USD).toBe('$');
    expect(CURRENCY_SYMBOLS.EUR).toBe('€');
    expect(CURRENCY_SYMBOLS.GBP).toBe('£');
    expect(CURRENCY_SYMBOLS.JPY).toBe('¥');
    expect(CURRENCY_SYMBOLS.INR).toBe('₹');
    expect(CURRENCY_SYMBOLS.BRL).toBe('R$');
  });

  it('all keys are 3-char uppercase currency codes', () => {
    for (const code of Object.keys(CURRENCY_SYMBOLS)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('all symbols are non-empty strings', () => {
    for (const symbol of Object.values(CURRENCY_SYMBOLS)) {
      expect(typeof symbol).toBe('string');
      expect(symbol.length).toBeGreaterThan(0);
    }
  });
});

// ── API Key Prefixes ─────────────────────────────────────────────────────────

describe('API_KEY_PREFIX_PUBLIC', () => {
  it('has the correct value', () => {
    expect(API_KEY_PREFIX_PUBLIC).toBe('gpl_pk_');
  });
});

describe('API_KEY_PREFIX_SECRET', () => {
  it('has the correct value', () => {
    expect(API_KEY_PREFIX_SECRET).toBe('gpl_sk_');
  });
});

// ── BANNER_DEFAULTS ──────────────────────────────────────────────────────────

describe('BANNER_DEFAULTS', () => {
  it('has all required BannerConfig fields', () => {
    expect(BANNER_DEFAULTS).toHaveProperty('position');
    expect(BANNER_DEFAULTS).toHaveProperty('messageTemplate');
    expect(BANNER_DEFAULTS).toHaveProperty('ctaText');
    expect(BANNER_DEFAULTS).toHaveProperty('backgroundColor');
    expect(BANNER_DEFAULTS).toHaveProperty('textColor');
    expect(BANNER_DEFAULTS).toHaveProperty('ctaColor');
    expect(BANNER_DEFAULTS).toHaveProperty('ctaTextColor');
    expect(BANNER_DEFAULTS).toHaveProperty('showFlag');
    expect(BANNER_DEFAULTS).toHaveProperty('showCloseBtn');
  });

  it('has valid position value', () => {
    expect(['top', 'bottom', 'bottom-left', 'bottom-right']).toContain(
      BANNER_DEFAULTS.position,
    );
  });

  it('position defaults to bottom', () => {
    expect(BANNER_DEFAULTS.position).toBe('bottom');
  });

  it('showFlag and showCloseBtn are booleans', () => {
    expect(typeof BANNER_DEFAULTS.showFlag).toBe('boolean');
    expect(typeof BANNER_DEFAULTS.showCloseBtn).toBe('boolean');
  });

  it('showFlag defaults to true', () => {
    expect(BANNER_DEFAULTS.showFlag).toBe(true);
  });

  it('showCloseBtn defaults to true', () => {
    expect(BANNER_DEFAULTS.showCloseBtn).toBe(true);
  });

  it('messageTemplate contains {{country}}, {{code}}, and {{discount}} placeholders', () => {
    expect(BANNER_DEFAULTS.messageTemplate).toContain('{{country}}');
    expect(BANNER_DEFAULTS.messageTemplate).toContain('{{code}}');
    expect(BANNER_DEFAULTS.messageTemplate).toContain('{{discount}}');
  });

  it('color fields are non-empty strings', () => {
    expect(BANNER_DEFAULTS.backgroundColor.length).toBeGreaterThan(0);
    expect(BANNER_DEFAULTS.textColor.length).toBeGreaterThan(0);
    expect(BANNER_DEFAULTS.ctaColor.length).toBeGreaterThan(0);
    expect(BANNER_DEFAULTS.ctaTextColor.length).toBeGreaterThan(0);
  });
});

// ── LIMIT_ALERT_THRESHOLD ────────────────────────────────────────────────────

describe('LIMIT_ALERT_THRESHOLD', () => {
  it('is 0.8 (80%)', () => {
    expect(LIMIT_ALERT_THRESHOLD).toBe(0.8);
  });
});

// ── DEFAULT_BANNER_MESSAGE & DEFAULT_CTA_TEXT ────────────────────────────────

describe('DEFAULT_BANNER_MESSAGE', () => {
  it('contains placeholder tokens', () => {
    expect(DEFAULT_BANNER_MESSAGE).toContain('{{country}}');
    expect(DEFAULT_BANNER_MESSAGE).toContain('{{code}}');
    expect(DEFAULT_BANNER_MESSAGE).toContain('{{discount}}');
  });
});

describe('DEFAULT_CTA_TEXT', () => {
  it('has the correct value', () => {
    expect(DEFAULT_CTA_TEXT).toBe('Copy Code');
  });
});

// ── KNOWN_DATACENTER_ORGS ────────────────────────────────────────────────────

describe('KNOWN_DATACENTER_ORGS', () => {
  it('includes major cloud providers', () => {
    const orgs = [...KNOWN_DATACENTER_ORGS];
    expect(orgs).toContain('amazon');
    expect(orgs).toContain('google');
    expect(orgs).toContain('microsoft');
    expect(orgs).toContain('cloudflare');
  });

  it('has at least 10 entries', () => {
    expect(KNOWN_DATACENTER_ORGS.length).toBeGreaterThanOrEqual(10);
  });
});
