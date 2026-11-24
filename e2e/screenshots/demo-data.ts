// Made-up data for the dashboard screenshots. Nothing here comes from a real
// account: the repository is public and the images go into the docs and the
// README. Ids, names and addresses are invented; emails use example.com.

export const ORG_ID = "org_demo";

const created = (date: string) => ({ createdAt: date, updatedAt: date });

export const user = {
  id: "user_demo",
  name: "Demo User",
  email: "demo@example.com",
  emailVerified: true,
  image: null,
  ...created("2026-10-01T09:00:00.000Z"),
};

export const session = {
  session: {
    id: "session_demo",
    userId: user.id,
    activeOrganizationId: ORG_ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    token: "demo-session",
    ...created("2026-11-20T09:00:00.000Z"),
  },
  user,
};

export const organizations = [
  { id: ORG_ID, name: "Demo workspace", slug: "demo", logo: null, metadata: null, createdAt: "2026-10-01T09:00:00.000Z" },
];

export const members = [
  { id: "member_demo", userId: user.id, name: user.name, email: user.email, image: null, role: "owner", createdAt: "2026-10-01T09:00:00.000Z" },
];

export const usage = {
  plan: "pro",
  billingEnabled: true,
  maxProducts: null,
  currentCount: 4,
  remaining: null,
  meters: {
    products: { current: 4, max: null },
    apiHits: { current: 182_340, max: null },
    teamMembers: { current: 1, max: null },
  },
};

type Env = "live" | "test";

function integration(fields: {
  id: string;
  provider: string;
  live: boolean;
  test: boolean;
  webhooks: Record<Env, { status: "active" | "missing" | "needs_attention" } | null>;
  health?: Array<{ area: string; message: string; environment?: Env; at: string }>;
  providerAccountId?: string | null;
  createdAt: string;
}) {
  return {
    id: fields.id,
    provider: fields.provider,
    providerAccountId: fields.providerAccountId ?? null,
    testProviderAccountId: null,
    status: "active",
    hasLiveCredentials: fields.live,
    hasTestCredentials: fields.test,
    webhooks: fields.webhooks,
    health: fields.health ?? [],
    organizationId: ORG_ID,
    ...created(fields.createdAt),
  };
}

export const dodo = integration({
  id: "int_dodo",
  provider: "dodopayments",
  live: true,
  test: true,
  webhooks: { live: { status: "active" }, test: { status: "active" } },
  createdAt: "2026-11-12T10:00:00.000Z",
});

export const gumroad = integration({
  id: "int_gumroad",
  provider: "gumroad",
  live: true,
  test: false,
  webhooks: { live: { status: "needs_attention" }, test: null },
  health: [
    {
      area: "webhook_delivery",
      environment: "live",
      // The text the API records (apps/api/src/routes/webhooks.ts).
      message:
        "A webhook delivery failed signature verification. If this keeps happening, re-create the webhook from the integrations page.",
      at: "2026-11-20T09:30:00.000Z",
    },
  ],
  createdAt: "2026-11-03T15:20:00.000Z",
});

/** What connecting Stripe returns in the "connect" shots. */
export function stripeConnected(env: Env, tracking: "active" | "failed") {
  return {
    ...integration({
      id: "int_stripe",
      provider: "stripe",
      live: env === "live",
      test: env === "test",
      webhooks: {
        live: env === "live" ? { status: tracking === "active" ? "active" : "missing" } : null,
        test: env === "test" ? { status: tracking === "active" ? "active" : "missing" } : null,
      },
      createdAt: "2026-11-24T10:00:00.000Z",
    }),
    webhookSetup:
      tracking === "active"
        ? { status: "active", environment: env }
        : {
            status: "failed",
            environment: env,
            error: "Stripe refused to create the webhook: the key is missing Webhook Endpoints: Write.",
          },
  };
}

const campaign = (id: string, name: string, productId: string, integrationId: string | null) => ({
  id,
  name,
  productId,
  integrationId,
  pricingMode: "ppp_factor",
  discountDelivery: "banner_coupon",
  charmPricingStrategy: "none",
  maxDiscountPercent: 60,
  status: "active",
  organizationId: ORG_ID,
  discountOverrides: null,
  couponPrefix: null,
  allowedDomains: ["shop.example.com"],
  environment: "live",
  ...created("2026-11-14T12:00:00.000Z"),
});

export const campaigns = [
  campaign("camp_pro", "Pro plan, launch pricing", "prod_pro", dodo.id),
  { ...campaign("camp_pro_b", "Pro plan, 45% max", "prod_pro", dodo.id), maxDiscountPercent: 45 },
  { ...campaign("camp_team", "Team plan", "prod_team", dodo.id), discountDelivery: "auto_apply" },
  { ...campaign("camp_course", "Pricing course", "prod_course", gumroad.id), status: "paused" },
  { ...campaign("camp_templates", "Template pack", "prod_templates", null), status: "draft" },
];

const product = (id: string, name: string, basePrice: number) => ({
  id,
  name,
  url: `https://shop.example.com/${id.replace("prod_", "")}`,
  currency: "USD",
  basePrice,
  environment: "live",
  organizationId: ORG_ID,
  ...created("2026-11-12T11:00:00.000Z"),
});

export const products = [
  product("prod_pro", "Pro plan", 29),
  product("prod_team", "Team plan", 79),
  product("prod_course", "Pricing course", 149),
  product("prod_templates", "Template pack", 39),
];

// ── Overview ─────────────────────────────────────────────────────────────────

const country = (countryCode: string, impressions: number, clicks: number, copies: number, redemptions: number, usd: number) => ({
  countryCode,
  impressions,
  clicks,
  copies,
  redemptions,
  revenueSaved: usd,
  revenueSavedByCurrency: usd > 0 ? { USD: usd } : {},
});

export const byCountry = [
  country("IN", 4_820, 1_210, 642, 58, 1_044.4),
  country("BR", 2_960, 690, 371, 31, 489.8),
  country("ID", 2_310, 512, 266, 22, 401.6),
  country("MX", 1_870, 401, 198, 17, 263.5),
  country("PL", 1_420, 288, 141, 12, 151.2),
  country("TR", 1_180, 262, 133, 11, 189.2),
  country("NG", 990, 241, 118, 9, 165.6),
  country("PH", 870, 190, 92, 8, 136),
  country("VN", 760, 170, 81, 6, 104.4),
  country("EG", 640, 151, 70, 5, 89.5),
  country("AR", 520, 118, 55, 4, 63.2),
  country("ZA", 410, 84, 39, 3, 40.5),
];

const sum = (k: "impressions" | "clicks" | "copies" | "redemptions" | "revenueSaved") =>
  Math.round(byCountry.reduce((n, r) => n + r[k], 0) * 100) / 100;

export const overview = {
  totalImpressions: sum("impressions"),
  totalClicks: sum("clicks"),
  totalCopies: sum("copies"),
  totalRedemptions: sum("redemptions"),
  totalRevenueSaved: sum("revenueSaved"),
  revenueSavedByCurrency: { USD: sum("revenueSaved") },
};

// ── Campaign page ────────────────────────────────────────────────────────────

export const bannerConfig = {
  position: "top",
  messageTemplate: "Hi {{countryName}}! Use {{code}} for {{discount}}% off: {{localPrice}} instead of {{localOriginalPrice}}.",
  ctaText: "Copy code",
  backgroundColor: "#111111",
  textColor: "#FFFFFF",
  ctaColor: "#E42313",
  ctaTextColor: "#FFFFFF",
  showFlag: true,
  showCloseBtn: true,
};

// ── A/B test ─────────────────────────────────────────────────────────────────

const arm = (campaignId: string, impressions: number, clicks: number, copies: number, redemptions: number, usd: number) => ({
  campaignId,
  impressions,
  clicks,
  copies,
  redemptions,
  revenueSavedByCurrency: { USD: usd },
  clickRate: clicks / impressions,
  copyRate: copies / impressions,
  conversionRate: redemptions / impressions,
  redemptionsPerCopy: redemptions / copies,
});

export const experiment = {
  id: "exp_launch",
  organizationId: ORG_ID,
  productId: "prod_pro",
  environment: "live",
  name: "Launch pricing: 60% or 45% max",
  status: "running",
  campaignAId: "camp_pro",
  campaignBId: "camp_pro_b",
  campaignAName: "Pro plan, launch pricing",
  campaignBName: "Pro plan, 45% max",
  trafficSplitB: 50,
  winnerCampaignId: null,
  startedAt: "2026-11-10T00:00:00.000Z",
  endedAt: null,
  campaignA: { id: "camp_pro", name: "Pro plan, launch pricing", status: "active" },
  campaignB: { id: "camp_pro_b", name: "Pro plan, 45% max", status: "active" },
  ...created("2026-11-10T00:00:00.000Z"),
};

export const experimentDetail = {
  ...experiment,
  results: {
    granularity: "day",
    from: "2026-11-10T00:00:00.000Z",
    to: null,
    truncatedByRetention: false,
    a: arm("camp_pro", 5_100, 1_190, 1_428, 204, 3_549.6),
    b: arm("camp_pro_b", 5_080, 1_240, 1_524, 279, 3_640.95),
    observedShareB: 0.499,
  },
};

// ── Settings ─────────────────────────────────────────────────────────────────

export const billing = {
  plan: "pro",
  effectivePlan: "pro",
  status: "active",
  currentPeriodEnd: "2026-12-14T00:00:00.000Z",
  dodoCustId: "cus_demo",
  dodoSubId: "sub_demo",
  billingEnabled: true,
};

export const freeBilling = { ...billing, plan: "free", effectivePlan: "free", status: "active", currentPeriodEnd: null, dodoCustId: null, dodoSubId: null };

export const freeUsage = {
  plan: "free",
  billingEnabled: true,
  maxProducts: 1,
  currentCount: 1,
  remaining: 0,
  meters: {
    products: { current: 1, max: 1 },
    apiHits: { current: 8_420, max: 10_000 },
    teamMembers: { current: 1, max: 1 },
  },
};

export const apiKeys = [
  {
    id: "key_site",
    name: "Website banner",
    keyPrefix: "gpl_pk_live_DEMO",
    keyType: "public",
    fullKey: "gpl_pk_live_DEMO_FAKE_KEY_0000",
    createdAt: "2026-11-12T10:00:00.000Z",
    lastUsedAt: "2026-11-24T08:30:00.000Z",
    createdBy: { id: user.id, name: user.name },
  },
  {
    id: "key_server",
    name: "Server",
    keyPrefix: "gpl_sk_live_DEMO",
    keyType: "secret",
    fullKey: null,
    createdAt: "2026-11-12T10:05:00.000Z",
    lastUsedAt: null,
    createdBy: { id: user.id, name: user.name },
  },
];
