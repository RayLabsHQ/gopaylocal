import { describe, it, expect } from 'vitest';
import {
  createProductSchema,
  updateProductSchema,
  createCampaignSchema,
  updateCampaignSchema,
  createParityGroupSchema,
  updateParityGroupSchema,
  setCountriesSchema,
  updateBannerConfigSchema,
  createApiKeySchema,
  createIntegrationSchema,
  normalizeProviderAccountId,
  PROVIDERS_WITHOUT_TEST_MODE,
  providerHasTestMode,
  analyticsEventSchema,
  analyticsEventBatchSchema,
} from './index.js';

// ── createProductSchema ──────────────────────────────────────────────────────

describe('createProductSchema', () => {
  it('accepts valid product data', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'https://example.com',
      currency: 'USD',
      basePrice: 29.99,
    });
    expect(result.success).toBe(true);
  });

  it('applies default currency of USD', () => {
    const result = createProductSchema.parse({
      name: 'My Product',
      url: 'https://example.com',
      basePrice: 29.99,
    });
    expect(result.currency).toBe('USD');
  });

  it('rejects missing name', () => {
    const result = createProductSchema.safeParse({
      url: 'https://example.com',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = createProductSchema.safeParse({
      name: '',
      url: 'https://example.com',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative price', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'https://example.com',
      basePrice: -10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero price', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'https://example.com',
      basePrice: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'not-a-url',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing URL', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing basePrice', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name exceeding 200 characters', () => {
    const result = createProductSchema.safeParse({
      name: 'a'.repeat(201),
      url: 'https://example.com',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });

  it('accepts name at exactly 200 characters', () => {
    const result = createProductSchema.safeParse({
      name: 'a'.repeat(200),
      url: 'https://example.com',
      basePrice: 29.99,
    });
    expect(result.success).toBe(true);
  });

  it('rejects currency that is not 3 characters', () => {
    const result = createProductSchema.safeParse({
      name: 'My Product',
      url: 'https://example.com',
      currency: 'US',
      basePrice: 29.99,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateProductSchema', () => {
  it('accepts partial data (all fields optional)', () => {
    const result = updateProductSchema.safeParse({ name: 'Updated' });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = updateProductSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('still validates provided fields', () => {
    const result = updateProductSchema.safeParse({ basePrice: -5 });
    expect(result.success).toBe(false);
  });

  // A PATCH writes parsed.data straight into the row, so a default here would
  // overwrite the stored value of every field the client did not send. Zod 4
  // applies .default() inside optional fields, which is why the update schemas
  // are not built as createXSchema.partial().
  it('returns only the fields sent (no defaults filled in)', () => {
    const result = updateProductSchema.safeParse({ name: 'Updated' });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ name: 'Updated' });
  });

  it('parses an empty object to an empty object', () => {
    expect(updateProductSchema.parse({})).toStrictEqual({});
  });
});

// ── createCampaignSchema ─────────────────────────────────────────────────────

describe('createCampaignSchema', () => {
  const validCampaign = {
    productId: 'prod_123',
    name: 'My Campaign',
  };

  it('accepts valid campaign data with all defaults', () => {
    const result = createCampaignSchema.safeParse(validCampaign);
    expect(result.success).toBe(true);
  });

  it('applies default status of draft', () => {
    const parsed = createCampaignSchema.parse(validCampaign);
    expect(parsed.status).toBe('draft');
  });

  it('applies default pricingMode of group', () => {
    const parsed = createCampaignSchema.parse(validCampaign);
    expect(parsed.pricingMode).toBe('group');
  });

  it('applies default discountDelivery of banner_coupon', () => {
    const parsed = createCampaignSchema.parse(validCampaign);
    expect(parsed.discountDelivery).toBe('banner_coupon');
  });

  it('applies default charmPricingStrategy of none', () => {
    const parsed = createCampaignSchema.parse(validCampaign);
    expect(parsed.charmPricingStrategy).toBe('none');
  });

  it('applies default maxDiscountPercent of 70', () => {
    const parsed = createCampaignSchema.parse(validCampaign);
    expect(parsed.maxDiscountPercent).toBe(70);
  });

  it('accepts all valid pricing modes', () => {
    for (const mode of ['group', 'ppp_factor', 'custom'] as const) {
      const result = createCampaignSchema.safeParse({
        ...validCampaign,
        pricingMode: mode,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid pricing mode', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      pricingMode: 'invalid_mode',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid statuses', () => {
    for (const status of ['active', 'paused', 'draft'] as const) {
      const result = createCampaignSchema.safeParse({
        ...validCampaign,
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid status', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      status: 'archived',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing productId', () => {
    const result = createCampaignSchema.safeParse({ name: 'Campaign' });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = createCampaignSchema.safeParse({ productId: 'prod_123' });
    expect(result.success).toBe(false);
  });

  it('rejects maxDiscountPercent > 100', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      maxDiscountPercent: 101,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxDiscountPercent < 0', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      maxDiscountPercent: -1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional nullable fields', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      integrationId: null,
      discountOverrides: null,
      couponPrefix: null,
      allowedDomains: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts discountOverrides as a record of string -> number', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      discountOverrides: { US: 10, IN: 50 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts allowedDomains as an array of strings', () => {
    const result = createCampaignSchema.safeParse({
      ...validCampaign,
      allowedDomains: ['example.com', 'mysite.org'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid charm pricing strategies', () => {
    for (const strategy of ['none', 'dot99', 'round_x9', 'nearest_5', 'region_aware'] as const) {
      const result = createCampaignSchema.safeParse({
        ...validCampaign,
        charmPricingStrategy: strategy,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('updateCampaignSchema', () => {
  it('accepts partial data', () => {
    const result = updateCampaignSchema.safeParse({ name: 'Updated Name' });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = updateCampaignSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // See updateProductSchema: a default here would reset status, pricingMode,
  // discountDelivery, charmPricingStrategy, maxDiscountPercent and environment
  // on every partial update.
  it('returns only the fields sent (no defaults filled in)', () => {
    const result = updateCampaignSchema.safeParse({ name: 'Updated Name' });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ name: 'Updated Name' });
  });

  it('parses an empty object to an empty object', () => {
    expect(updateCampaignSchema.parse({})).toStrictEqual({});
  });

  it('still validates provided fields', () => {
    expect(updateCampaignSchema.safeParse({ maxDiscountPercent: 101 }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(updateCampaignSchema.safeParse({ couponPrefix: 'BAD-PREFIX' }).success).toBe(false);
  });
});

// ── createParityGroupSchema ──────────────────────────────────────────────────

describe('createParityGroupSchema', () => {
  it('accepts valid parity group data', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Tier 1',
      discountPercent: 20,
      sortOrder: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects discount > 100', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Tier X',
      discountPercent: 101,
      sortOrder: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects discount < 0', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Tier X',
      discountPercent: -1,
      sortOrder: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts discount at boundary 0', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'No Discount',
      discountPercent: 0,
      sortOrder: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts discount at boundary 100', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Full Discount',
      discountPercent: 100,
      sortOrder: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = createParityGroupSchema.safeParse({
      discountPercent: 20,
      sortOrder: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = createParityGroupSchema.safeParse({
      name: '',
      discountPercent: 20,
      sortOrder: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects name exceeding 100 characters', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'a'.repeat(101),
      discountPercent: 20,
      sortOrder: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer sortOrder', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Tier 1',
      discountPercent: 20,
      sortOrder: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative sortOrder', () => {
    const result = createParityGroupSchema.safeParse({
      name: 'Tier 1',
      discountPercent: 20,
      sortOrder: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateParityGroupSchema', () => {
  it('accepts partial data', () => {
    const result = updateParityGroupSchema.safeParse({ discountPercent: 30 });
    expect(result.success).toBe(true);
  });

  it('still validates provided fields', () => {
    const result = updateParityGroupSchema.safeParse({ discountPercent: 150 });
    expect(result.success).toBe(false);
  });

  it('returns only the fields sent (no defaults filled in)', () => {
    const result = updateParityGroupSchema.safeParse({ name: 'Tier 2' });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ name: 'Tier 2' });
  });

  it('parses an empty object to an empty object', () => {
    expect(updateParityGroupSchema.parse({})).toStrictEqual({});
  });
});

describe('setCountriesSchema', () => {
  it('accepts array of 2-char country codes', () => {
    const result = setCountriesSchema.safeParse({
      countries: ['US', 'GB', 'IN'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects country codes that are not 2 characters', () => {
    const result = setCountriesSchema.safeParse({
      countries: ['USA', 'GB'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty countries array', () => {
    const result = setCountriesSchema.safeParse({ countries: [] });
    expect(result.success).toBe(true);
  });
});

// ── updateBannerConfigSchema ─────────────────────────────────────────────────

describe('updateBannerConfigSchema', () => {
  it('accepts partial data (all fields optional)', () => {
    const result = updateBannerConfigSchema.safeParse({
      position: 'top',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = updateBannerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // The banner config has no `name`; ctaText plays the same role here.
  it('returns only the fields sent (no defaults filled in)', () => {
    const result = updateBannerConfigSchema.safeParse({ ctaText: 'Claim discount' });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ ctaText: 'Claim discount' });
  });

  it('parses an empty object to an empty object', () => {
    expect(updateBannerConfigSchema.parse({})).toStrictEqual({});
  });

  it('accepts all valid position values', () => {
    for (const pos of ['top', 'bottom', 'bottom-left', 'bottom-right'] as const) {
      const result = updateBannerConfigSchema.safeParse({ position: pos });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid position value', () => {
    const result = updateBannerConfigSchema.safeParse({ position: 'center' });
    expect(result.success).toBe(false);
  });

  it('accepts boolean flags', () => {
    const result = updateBannerConfigSchema.safeParse({
      showFlag: false,
      showCloseBtn: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts color and text fields', () => {
    const result = updateBannerConfigSchema.safeParse({
      backgroundColor: '#000000',
      textColor: '#ffffff',
      ctaColor: '#ff0000',
      ctaTextColor: '#00ff00',
      messageTemplate: 'Hello {{country}}!',
      ctaText: 'Apply',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty messageTemplate', () => {
    const result = updateBannerConfigSchema.safeParse({
      messageTemplate: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ctaText exceeding 50 characters', () => {
    const result = updateBannerConfigSchema.safeParse({
      ctaText: 'a'.repeat(51),
    });
    expect(result.success).toBe(false);
  });
});

// ── createApiKeySchema ───────────────────────────────────────────────────────

describe('createApiKeySchema', () => {
  it('accepts valid public API key data', () => {
    const result = createApiKeySchema.safeParse({
      name: 'My Key',
      keyType: 'public',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid secret API key data', () => {
    const result = createApiKeySchema.safeParse({
      name: 'Server Key',
      keyType: 'secret',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid keyType', () => {
    const result = createApiKeySchema.safeParse({
      name: 'Bad Key',
      keyType: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = createApiKeySchema.safeParse({
      keyType: 'public',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = createApiKeySchema.safeParse({
      name: '',
      keyType: 'public',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name exceeding 100 characters', () => {
    const result = createApiKeySchema.safeParse({
      name: 'a'.repeat(101),
      keyType: 'public',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing keyType', () => {
    const result = createApiKeySchema.safeParse({
      name: 'My Key',
    });
    expect(result.success).toBe(false);
  });
});

// ── createIntegrationSchema ──────────────────────────────────────────────────

describe('createIntegrationSchema', () => {
  it('accepts valid provider', () => {
    const result = createIntegrationSchema.safeParse({
      provider: 'stripe',
      accessToken: 'sk_test_abc123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid providers', () => {
    // Account ids in each provider's own format; ignored by providers that don't use one.
    const accountIds: Record<string, string> = {
      chargebee: 'acme',
      whop: 'biz_AbC123',
      woocommerce: 'https://shop.example.com',
    };
    // Keys in each provider's own format where the schema checks it.
    const tokens: Record<string, string> = {
      woocommerce: `ck_${'a'.repeat(40)}:cs_${'b'.repeat(40)}`,
    };
    const providers = [
      'dodopayments', 'stripe', 'paddle',
      'gumroad', 'chargebee', 'whop', 'polar',
      'creem',
      'woocommerce',
    ];
    for (const provider of providers) {
      const result = createIntegrationSchema.safeParse({
        provider,
        accessToken: tokens[provider] ?? 'token_abc',
        providerAccountId: accountIds[provider] ?? 'acct_1',
      });
      expect(result.success).toBe(true);
    }
  });

  it('requires providerAccountId for chargebee, whop and woocommerce', () => {
    for (const provider of ['chargebee', 'whop', 'woocommerce']) {
      const result = createIntegrationSchema.safeParse({
        provider,
        accessToken: 'token_abc',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['providerAccountId']);
      }
    }
    // Other providers stay valid without one
    const stripe = createIntegrationSchema.safeParse({
      provider: 'stripe',
      accessToken: 'token_abc',
    });
    expect(stripe.success).toBe(true);
  });

  it('rejects account ids in the wrong format for the provider', () => {
    const bad: Array<[string, string]> = [
      ['chargebee', 'evil.com/x?'], // would redirect the Basic-auth key elsewhere
      ['chargebee', 'acme_site'], // not a DNS label
      ['whop', 'acct_123'], // Whop account ids are biz_…
      ['whop', 'biz_'], // prefix only
      ['woocommerce', 'http://shop.example.com'], // the key would travel unencrypted
      ['woocommerce', 'https://127.0.0.1'], // full URL rules: woocommerce.test.ts
    ];
    for (const [provider, providerAccountId] of bad) {
      const result = createIntegrationSchema.safeParse({ provider, accessToken: 'tok', providerAccountId });
      expect(result.success, `${provider} ${providerAccountId}`).toBe(false);
    }
  });

  it('rejects a whitespace-only access token', () => {
    expect(createIntegrationSchema.safeParse({ provider: 'stripe', accessToken: '   ' }).success).toBe(false);
  });

  it('requires a WooCommerce key as ck_…:cs_…', () => {
    const ck = `ck_${'a'.repeat(40)}`;
    const cs = `cs_${'b'.repeat(40)}`;
    const parse = (accessToken: string) =>
      createIntegrationSchema.safeParse({ provider: 'woocommerce', accessToken, providerAccountId: 'https://shop.example.com' });
    expect(parse(`${ck}:${cs}`).success).toBe(true);
    for (const bad of [ck, cs, `${cs}:${ck}`, 'token_abc', `${ck}:${cs}?x=1`]) {
      const result = parse(bad);
      expect(result.success, bad).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['accessToken']);
    }
  });

  it('refuses test-mode credentials for providers without a test mode, and only for them', () => {
    expect(Object.keys(PROVIDERS_WITHOUT_TEST_MODE).sort()).toEqual(['gumroad', 'woocommerce']);
    const woo = { accessToken: `ck_${'a'.repeat(40)}:cs_${'b'.repeat(40)}`, providerAccountId: 'https://shop.example.com' };
    const gumroad = createIntegrationSchema.safeParse({ provider: 'gumroad', accessToken: 'tok', environment: 'test' });
    const wooTest = createIntegrationSchema.safeParse({ provider: 'woocommerce', ...woo, environment: 'test' });
    for (const [result, name] of [[gumroad, 'Gumroad'], [wooTest, 'WooCommerce']] as const) {
      expect(result.success, name).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          expect.objectContaining({ path: ['environment'], message: `${name} has no test mode. Connect it in Live.` }),
        ]);
      }
    }
    expect(createIntegrationSchema.safeParse({ provider: 'gumroad', accessToken: 'tok', environment: 'live' }).success).toBe(true);
    expect(createIntegrationSchema.safeParse({ provider: 'woocommerce', ...woo }).success).toBe(true);
    expect(createIntegrationSchema.safeParse({ provider: 'stripe', accessToken: 'tok', environment: 'test' }).success).toBe(true);
    expect(providerHasTestMode('stripe')).toBe(true);
    expect(providerHasTestMode('woocommerce')).toBe(false);
    expect(providerHasTestMode('toString')).toBe(true);
  });

  it('rejects invalid provider', () => {
    const result = createIntegrationSchema.safeParse({
      provider: 'paypal',
    });
    expect(result.success).toBe(false);
  });

  it('rejects provider without access token', () => {
    const result = createIntegrationSchema.safeParse({
      provider: 'paddle',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all optional fields', () => {
    const result = createIntegrationSchema.safeParse({
      provider: 'stripe',
      accessToken: 'tok_abc',
      refreshToken: 'ref_abc',
      providerAccountId: 'acct_123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty accessToken', () => {
    const result = createIntegrationSchema.safeParse({
      provider: 'stripe',
      accessToken: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing provider', () => {
    const result = createIntegrationSchema.safeParse({
      accessToken: 'tok_abc',
    });
    expect(result.success).toBe(false);
  });
});

// ── normalizeProviderAccountId ───────────────────────────────────────────────

describe('normalizeProviderAccountId', () => {
  it('reduces a pasted Chargebee URL to the site name', () => {
    expect(normalizeProviderAccountId('chargebee', 'https://Acme.chargebee.com/')).toEqual({ ok: true, value: 'acme' });
    expect(normalizeProviderAccountId('chargebee', 'acme.chargebee.com')).toEqual({ ok: true, value: 'acme' });
    expect(normalizeProviderAccountId('chargebee', 'acme')).toEqual({ ok: true, value: 'acme' });
  });

  it('stores one Chargebee site for both modes (the adapter adds -test itself)', () => {
    expect(normalizeProviderAccountId('chargebee', 'acme-test', 'test')).toEqual({ ok: true, value: 'acme' });
    expect(normalizeProviderAccountId('chargebee', 'https://acme-test.chargebee.com', 'test')).toEqual({
      ok: true,
      value: 'acme',
    });
    // Live mode leaves a site literally named "*-test" alone.
    expect(normalizeProviderAccountId('chargebee', 'acme-test', 'live')).toEqual({ ok: true, value: 'acme-test' });
  });

  it('requires a biz_ id for Whop', () => {
    expect(normalizeProviderAccountId('whop', ' biz_AbC123 ')).toEqual({ ok: true, value: 'biz_AbC123' });
    expect(normalizeProviderAccountId('whop', 'AbC123').ok).toBe(false);
  });

  it('ignores account ids for providers that do not use one', () => {
    for (const provider of ['stripe', 'paddle', 'polar', 'dodopayments', 'gumroad', 'creem']) {
      expect(normalizeProviderAccountId(provider, 'anything')).toEqual({ ok: true, value: undefined });
    }
  });
});

// ── analyticsEventSchema ─────────────────────────────────────────────────────

describe('analyticsEventSchema', () => {
  const validEvent = {
    eventType: 'impression' as const,
    campaignId: 'camp_123',
    countryCode: 'US',
  };

  it('accepts valid analytics event', () => {
    const result = analyticsEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it('accepts all valid event types', () => {
    for (const eventType of ['impression', 'click', 'copy', 'dismiss', 'redemption'] as const) {
      const result = analyticsEventSchema.safeParse({
        ...validEvent,
        eventType,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid eventType', () => {
    const result = analyticsEventSchema.safeParse({
      ...validEvent,
      eventType: 'pageview',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing campaignId', () => {
    const result = analyticsEventSchema.safeParse({
      eventType: 'impression',
      countryCode: 'US',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty campaignId', () => {
    const result = analyticsEventSchema.safeParse({
      eventType: 'impression',
      campaignId: '',
      countryCode: 'US',
    });
    expect(result.success).toBe(false);
  });

  it('rejects countryCode that is not 2 characters', () => {
    const result = analyticsEventSchema.safeParse({
      ...validEvent,
      countryCode: 'USA',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = analyticsEventSchema.safeParse({
      ...validEvent,
      couponId: 'cpn_123',
      pageUrl: 'https://example.com/pricing',
      discountPercent: 30,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid pageUrl', () => {
    const result = analyticsEventSchema.safeParse({
      ...validEvent,
      pageUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });
});

describe('analyticsEventBatchSchema', () => {
  it('accepts valid batch', () => {
    const result = analyticsEventBatchSchema.safeParse({
      key: 'gpl_pk_abc',
      events: [
        {
          eventType: 'impression',
          campaignId: 'camp_123',
          countryCode: 'US',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty events array', () => {
    const result = analyticsEventBatchSchema.safeParse({
      key: 'gpl_pk_abc',
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 50 events', () => {
    const events = Array.from({ length: 51 }, () => ({
      eventType: 'impression' as const,
      campaignId: 'camp_123',
      countryCode: 'US',
    }));
    const result = analyticsEventBatchSchema.safeParse({
      key: 'gpl_pk_abc',
      events,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing key', () => {
    const result = analyticsEventBatchSchema.safeParse({
      events: [
        {
          eventType: 'impression',
          campaignId: 'camp_123',
          countryCode: 'US',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty key', () => {
    const result = analyticsEventBatchSchema.safeParse({
      key: '',
      events: [
        {
          eventType: 'impression',
          campaignId: 'camp_123',
          countryCode: 'US',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
