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

const campaign = (id: string, name: string, productId: string, integrationId: string) => ({
  id,
  name,
  productId,
  integrationId,
  pricingMode: "country",
  discountDelivery: "coupon",
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
  campaign("camp_team", "Team plan", "prod_team", dodo.id),
  campaign("camp_course", "Pricing course", "prod_course", gumroad.id),
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
