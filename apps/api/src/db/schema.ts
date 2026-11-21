import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import * as t from "drizzle-orm/pg-core";
import type {
  Plan,
  PricingMode,
  DiscountDelivery,
  CharmPricingStrategy,
  CampaignStatus,
  IntegrationProvider,
  ApiKeyType,
} from "@gopaylocal/shared/types";
import type { DealCodeSource } from "@gopaylocal/shared/deals";

// ── Postgres 18 Notes ───────────────────────────────────────────────────────
// TODO: Switch from JS ulid() to Postgres-native uuidv7() for IDs once Drizzle
//       adds first-class support. UUIDv7 is time-sorted like ULIDs but generated
//       server-side. Use: t.uuid().default(sql`uuidv7()`)
// TODO: Add virtual generated columns for computed fields like discount amounts:
//       discountAmount: t.doublePrecision().generatedAlwaysAs(sql`base_price * discount_percent / 100`)
//       (never t.real() for money: float4 keeps about 7 significant digits)
// NOTE: Postgres 18 makes adding NOT NULL to existing columns cheap (no full table rewrite)
// NOTE: JSONB subscripting performance is improved in Pg18 — benefits our
//       discount_overrides and allowed_domains queries

// ── Better Auth Tables ──────────────────────────────────────────────────────
// These tables are used by Better Auth at runtime, but in this repo they are
// defined and migrated via Drizzle Kit with the rest of the schema.
// Keep these columns aligned with the Better Auth version/plugins in `auth.ts`.

export const users = pgTable("user", {
  id: t.text("id").primaryKey(),
  name: t.text("name"),
  email: t.text("email").notNull(),
  emailVerified: t.boolean("emailVerified").default(false).notNull(),
  image: t.text("image"),
  role: t.text("role"),
  banned: t.boolean("banned"),
  banReason: t.text("banReason"),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
  updatedAt: t.timestamp("updatedAt").defaultNow().notNull(),
});

export const accounts = pgTable("account", {
  id: t.text("id").primaryKey(),
  accountId: t.text("accountId").notNull(),
  providerId: t.text("providerId").notNull(),
  userId: t.text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: t.text("accessToken"),
  refreshToken: t.text("refreshToken"),
  idToken: t.text("idToken"),
  accessTokenExpiresAt: t.timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: t.timestamp("refreshTokenExpiresAt"),
  scope: t.text("scope"),
  password: t.text("password"),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
  updatedAt: t.timestamp("updatedAt").defaultNow().notNull(),
});

export const sessions = pgTable("session", {
  id: t.text("id").primaryKey(),
  expiresAt: t.timestamp("expiresAt").notNull(),
  token: t.text("token").unique().notNull(),
  ipAddress: t.text("ipAddress"),
  userAgent: t.text("userAgent"),
  userId: t.text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  activeOrganizationId: t.text("activeOrganizationId"),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
  updatedAt: t.timestamp("updatedAt").defaultNow().notNull(),
});

export const verifications = pgTable("verification", {
  id: t.text("id").primaryKey(),
  identifier: t.text("identifier").notNull(),
  value: t.text("value").notNull(),
  expiresAt: t.timestamp("expiresAt").notNull(),
  createdAt: t.timestamp("createdAt"),
  updatedAt: t.timestamp("updatedAt"),
});

export const organizations = pgTable("organization", {
  id: t.text("id").primaryKey(),
  name: t.text("name").notNull(),
  slug: t.text("slug"),
  logo: t.text("logo"),
  // Better Auth's organization plugin expects this column; 1.7 validates the schema on every request.
  metadata: t.text("metadata"),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
});

export const members = pgTable("member", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organizationId").notNull(),
  userId: t.text("userId").notNull(),
  role: t.text("role").notNull(),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
});

export const invitations = pgTable("invitation", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organizationId").notNull(),
  email: t.text("email").notNull(),
  role: t.text("role"),
  status: t.text("status").notNull().default("pending"),
  teamId: t.text("teamId"),
  inviterId: t.text("inviterId").notNull(),
  expiresAt: t.timestamp("expiresAt").notNull(),
  createdAt: t.timestamp("createdAt").defaultNow().notNull(),
});

// ── Subscriptions ───────────────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  plan: t.text("plan").$type<Plan>().notNull(),
  dodoCustId: t.text("dodo_cust_id"),
  dodoSubId: t.text("dodo_sub_id"),
  status: t.text("status").notNull(),
  currentPeriodEnd: t.timestamp("current_period_end"),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
});

// ── API Keys ────────────────────────────────────────────────────────────────

export const apiKeys = pgTable("api_keys", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  name: t.text("name").notNull(),
  keyType: t.text("key_type").$type<ApiKeyType>().notNull(),
  keyHash: t.text("key_hash").unique().notNull(),
  keyPrefix: t.text("key_prefix").notNull(),
  // Plaintext full key — populated ONLY for keyType='public'. Public keys are
  // public by design: customers paste them into their own public HTML/JS where
  // anyone can read them, so there is no secret to protect and storing the
  // plaintext is acceptable. It lets the dashboard render a copy-paste-ready
  // banner snippet. Secret keys MUST stay null here (only their hash is stored).
  fullKey: t.text("full_key"),
  lastUsedAt: t.timestamp("last_used_at"),
  // Who created the key (shown in the key list). The key stays workspace-owned:
  // it keeps working when its creator leaves, and is refused while its creator
  // is banned (middleware/api-key.ts). Null for keys created before this column
  // and after the creator's user row is deleted.
  createdByUserId: t.text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
});

// ── Products ────────────────────────────────────────────────────────────────

export const products = pgTable("products", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  name: t.text("name").notNull(),
  url: t.text("url").notNull(),
  currency: t.text("currency").default("USD").notNull(),
  // double precision, not real: float4 keeps about 7 significant digits, so
  // IDR 17,999,999 read back as 18,000,000.
  basePrice: t.doublePrecision("base_price").notNull(),
  environment: t.text("environment").$type<"live" | "test">().default("live").notNull(),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
});

// ── Member Product Access ───────────────────────────────────────────────────
// Which products a role='member' works on (owners and admins: always all).
// member_product_scopes holds the explicit choice, one row per member:
//   all_products = true  -> every product in the workspace;
//   all_products = false -> exactly that member's member_product_access rows;
//                           no rows means NO products.
// A member with no scope row has the default, all products (what a member gets
// on joining). Both tables reference member.id ON DELETE CASCADE, so removing
// someone (remove-member, leave, workspace delete) removes their scope and
// grants too, and a person who rejoins starts from the default. Grants are
// read by member_id only. See lib/product-access.ts.
export const memberProductScopes = pgTable(
  "member_product_scopes",
  {
    memberId: t
      .text("member_id")
      .primaryKey()
      .references(() => members.id, { onDelete: "cascade" }),
    organizationId: t.text("organization_id").notNull(),
    allProducts: t.boolean("all_products").notNull(),
    updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [t.index("member_product_scopes_org_idx").on(table.organizationId)],
);

export const memberProductAccess = pgTable(
  "member_product_access",
  {
    id: t.text("id").primaryKey(),
    organizationId: t.text("organization_id").notNull(),
    userId: t.text("user_id").notNull(),
    // Nullable only so the column can be added to an existing table; every
    // write sets it, and rows without it are never read (see Migration notes
    // in the authz report for the backfill).
    memberId: t.text("member_id").references(() => members.id, { onDelete: "cascade" }),
    productId: t
      .text("product_id")
      .references(() => products.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    t.uniqueIndex("member_product_access_idx").on(
      table.organizationId,
      table.userId,
      table.productId,
    ),
    t.index("member_product_access_member_idx").on(table.memberId),
  ],
);

// ── Integrations ────────────────────────────────────────────────────────────

export const integrations = pgTable("integrations", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  provider: t.text("provider").$type<IntegrationProvider>().notNull(),
  liveAccessTokenEnc: t.text("live_access_token_enc"),
  liveRefreshTokenEnc: t.text("live_refresh_token_enc"),
  testAccessTokenEnc: t.text("test_access_token_enc"),
  testRefreshTokenEnc: t.text("test_refresh_token_enc"),
  providerAccountId: t.text("provider_account_id"),
  // Test-mode account id when it differs from the live one (e.g. a Whop sandbox
  // company); null means "same as provider_account_id".
  testProviderAccountId: t.text("test_provider_account_id"),
  // Auto-provisioned webhooks for redemption tracking, one per environment: the
  // provider's endpoint id (to delete on disconnect) + the signing secret
  // (encrypted). The unprefixed pair is the live endpoint.
  webhookEndpointId: t.text("webhook_endpoint_id"),
  webhookSecretEnc: t.text("webhook_secret_enc"),
  testWebhookEndpointId: t.text("test_webhook_endpoint_id"),
  testWebhookSecretEnc: t.text("test_webhook_secret_enc"),
  // Last problem per area (coupon_sync, webhook_setup, webhook_delivery,
  // credentials) shown to the merchant; see services/integration-health.service.ts.
  health: t.jsonb("health").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  status: t.text("status").default("active").notNull(),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
});

// ── Parity Groups ───────────────────────────────────────────────────────────

export const parityGroups = pgTable("parity_groups", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  name: t.text("name").notNull(),
  discountPercent: t.real("discount_percent").notNull(),
  sortOrder: t.integer("sort_order").notNull(),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
});

// ── Country Parity Mappings ─────────────────────────────────────────────────

export const countryParityMappings = pgTable("country_parity_mappings", {
  id: t.text("id").primaryKey(),
  parityGroupId: t
    .text("parity_group_id")
    .references(() => parityGroups.id, { onDelete: "cascade" })
    .notNull(),
  countryCode: t.text("country_code").notNull(),
});

// ── Campaigns ───────────────────────────────────────────────────────────────

export const campaigns = pgTable("campaigns", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull(),
  productId: t
    .text("product_id")
    .references(() => products.id)
    .notNull(),
  // A campaign outlives its integration: disconnecting one leaves the campaign
  // without a provider (the disconnect route pauses auto-apply ones first).
  integrationId: t.text("integration_id").references(() => integrations.id, { onDelete: "set null" }),
  name: t.text("name").notNull(),
  environment: t.text("environment").$type<"live" | "test">().default("live").notNull(),
  status: t.text("status").$type<CampaignStatus>().default("draft").notNull(),
  pricingMode: t
    .text("pricing_mode")
    .$type<PricingMode>()
    .default("group")
    .notNull(),
  discountDelivery: t
    .text("discount_delivery")
    .$type<DiscountDelivery>()
    .default("banner_coupon")
    .notNull(),
  charmPricingStrategy: t
    .text("charm_pricing_strategy")
    .$type<CharmPricingStrategy>()
    .default("none")
    .notNull(),
  maxDiscountPercent: t.real("max_discount_percent").default(70).notNull(),
  discountOverrides: t.jsonb("discount_overrides"),
  couponPrefix: t.text("coupon_prefix"),
  allowedDomains: t.jsonb("allowed_domains"),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // Postgres doesn't index foreign keys itself; deleting an integration checks
  // (and nulls) campaigns by this column.
  t.index("campaigns_integration_idx").on(table.integrationId),
]);

// ── Experiments (A/B tests) ─────────────────────────────────────────────────
// Two campaigns of the same product and environment, split by traffic. At most
// one experiment per (product, environment) can be running; the partial unique
// index enforces it. The campaign foreign keys have no ON DELETE action on
// purpose: a campaign that is an arm of an experiment cannot be deleted until
// that experiment row is gone (the campaign delete removes ended experiments
// first and refuses while one is running).
export const experiments = pgTable(
  "experiments",
  {
    id: t.text("id").primaryKey(),
    organizationId: t.text("organization_id").notNull(),
    // A product can only be deleted once it has no campaigns (campaigns.product_id
    // has no ON DELETE), so this cascade only ever removes ended tests' history.
    productId: t
      .text("product_id")
      .references(() => products.id, { onDelete: "cascade" })
      .notNull(),
    environment: t.text("environment").$type<"live" | "test">().default("live").notNull(),
    name: t.text("name").notNull(),
    status: t.text("status").$type<"running" | "ended">().default("running").notNull(),
    // Arm ids are history, like analytics_rollups.campaign_id: no foreign key, so
    // deleting a campaign after its test ended keeps the test and its results
    // (rollups are looked up by these ids). While a test runs, the campaign
    // routes refuse to delete or pause an arm (services/experiment.service.ts).
    campaignAId: t.text("campaign_a_id").notNull(),
    campaignBId: t.text("campaign_b_id").notNull(),
    // Arm names when the test started, shown once a campaign is deleted.
    campaignAName: t.text("campaign_a_name").notNull(),
    campaignBName: t.text("campaign_b_name").notNull(),
    trafficSplitB: t.integer("traffic_split_b").default(50).notNull(),
    winnerCampaignId: t.text("winner_campaign_id"),
    startedAt: t.timestamp("started_at").defaultNow().notNull(),
    endedAt: t.timestamp("ended_at"),
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
    updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    t.uniqueIndex("experiments_one_running_idx")
      .on(table.productId, table.environment)
      .where(sql`"status" = 'running'`),
    t.index("experiments_org_idx").on(table.organizationId),
    t.index("experiments_campaign_a_idx").on(table.campaignAId),
    t.index("experiments_campaign_b_idx").on(table.campaignBId),
  ],
);

// ── Coupons ─────────────────────────────────────────────────────────────────

// ── Deals (holiday discounts) ───────────────────────────────────────────────
// A named percentage with a start and an end, attached to a campaign, with one
// discount code for every visitor (packages/shared/src/deals). While it runs,
// the banner offers a visitor the larger of the deal and their country's
// discount. A deal goes with its campaign.
//
// The code of a `provider` deal is a coupons row (coupons.deal_id, no country):
// redemption webhooks, an integration's removal and the retiring of superseded
// codes then treat it like any other coupon.
export const deals = pgTable(
  "deals",
  {
    id: t.text("id").primaryKey(),
    organizationId: t.text("organization_id").notNull(),
    campaignId: t
      .text("campaign_id")
      .references(() => campaigns.id, { onDelete: "cascade" })
      .notNull(),
    name: t.text("name").notNull(),
    // Fixed once the deal exists: the code at the payment platform carries it.
    discountPercent: t.integer("discount_percent").notNull(),
    // The deal runs from starts_at (inclusive) to ends_at (exclusive), UTC.
    startsAt: t.timestamp("starts_at").notNull(),
    endsAt: t.timestamp("ends_at").notNull(),
    messageTemplate: t.text("message_template").notNull(),
    // provider: GoPayLocal creates the code at the campaign's integration;
    // manual: manual_code, typed by the merchant; none: no code.
    codeSource: t.text("code_source").$type<DealCodeSource>().notNull(),
    manualCode: t.text("manual_code"),
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
    updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    t.index("deals_campaign_idx").on(table.campaignId),
    // The scheduled job looks for deals that have ended.
    t.index("deals_ends_at_idx").on(table.endsAt),
  ],
);

export const coupons = pgTable("coupons", {
  id: t.text("id").primaryKey(),
  campaignId: t
    .text("campaign_id")
    .references(() => campaigns.id)
    .notNull(),
  // A coupon row only means something together with its integration (the
  // credentials that can manage it and the webhook that reports it), so it
  // goes with it. The provider-side discount is left alone either way.
  integrationId: t.text("integration_id").references(() => integrations.id, { onDelete: "cascade" }),
  parityGroupId: t.text("parity_group_id"),
  countryCode: t.text("country_code"),
  // Set on the code of a holiday deal (then country_code is null). No foreign
  // key, on purpose: a row whose deal is gone is a code that still has to be
  // removed at the provider, and the scheduled job finds it by exactly that
  // (retireEndedDealCoupons in services/coupon.service.ts).
  dealId: t.text("deal_id"),
  environment: t.text("environment").$type<"live" | "test">().default("live").notNull(),
  code: t.text("code").unique().notNull(),
  discountPercent: t.real("discount_percent").notNull(),
  providerCouponId: t.text("provider_coupon_id"),
  providerPromoCodeId: t.text("provider_promo_code_id"),
  status: t.text("status").default("active").notNull(),
  expiresAt: t.timestamp("expires_at"),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // At most one active coupon per campaign and country: two banner loads that
  // race to create the first one can't both insert (the loser undoes its
  // provider discount and uses the winner's row).
  t.uniqueIndex("coupons_one_active_per_country_idx")
    .on(table.campaignId, table.countryCode)
    .where(sql`"status" = 'active'`),
  // Redemption webhooks and integration deletes look coupons up by integration.
  t.index("coupons_integration_idx").on(table.integrationId),
  // At most one active code per deal (rows without a deal are not compared:
  // NULLs are distinct in a unique index).
  t.uniqueIndex("coupons_one_active_per_deal_idx")
    .on(table.dealId)
    .where(sql`"status" = 'active'`),
]);

// ── Banner Configs ──────────────────────────────────────────────────────────

export const bannerConfigs = pgTable("banner_configs", {
  id: t.text("id").primaryKey(),
  campaignId: t
    .text("campaign_id")
    .references(() => campaigns.id, { onDelete: "cascade" })
    .unique()
    .notNull(),
  position: t.text("position").default("bottom").notNull(),
  messageTemplate: t.text("message_template").notNull(),
  ctaText: t.text("cta_text").default("Copy Code").notNull(),
  backgroundColor: t.text("background_color").default("#1a1a2e").notNull(),
  textColor: t.text("text_color").default("#ffffff").notNull(),
  ctaColor: t.text("cta_color").default("#e94560").notNull(),
  ctaTextColor: t.text("cta_text_color").default("#ffffff").notNull(),
  showFlag: t.boolean("show_flag").default(true).notNull(),
  showCloseBtn: t.boolean("show_close_btn").default(true).notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
});

// ── Webhook Events ──────────────────────────────────────────────────────────

export const webhookEvents = pgTable("webhook_events", {
  id: t.text("id").primaryKey(),
  webhookId: t.text("webhook_id").unique().notNull(),
  eventType: t.text("event_type").notNull(),
  provider: t.text("provider").notNull(),
  data: t.jsonb("data"),
  processed: t.boolean("processed").default(false).notNull(),
  errorMessage: t.text("error_message"),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  processedAt: t.timestamp("processed_at"),
}, (table) => [
  // The */10 retry job scans unprocessed rows oldest first; processed rows
  // (nearly all of them) stay out of the index.
  t.index("webhook_events_unprocessed_created_idx")
    .on(table.createdAt)
    .where(sql`"processed" = false`),
]);

// ── Analytics Rollups ───────────────────────────────────────────────────────

export const analyticsRollups = pgTable(
  "analytics_rollups",
  {
    id: t.text("id").primaryKey(),
    organizationId: t.text("organization_id").notNull(),
    campaignId: t.text("campaign_id"),
    countryCode: t.text("country_code"),
    period: t.text("period").notNull(), // 'day' | 'week' | 'month'
    periodStart: t.timestamp("period_start").notNull(),
    impressions: t.integer("impressions").default(0).notNull(),
    clicks: t.integer("clicks").default(0).notNull(),
    copies: t.integer("copies").default(0).notNull(),
    redemptions: t.integer("redemptions").default(0).notNull(),
    // USD savings only, in dollars (kept for existing readers). Every currency,
    // USD included, is in revenue_saved_by_currency as integer minor units keyed
    // by ISO 4217 code, e.g. {"USD": 4000, "INR": 120000}; never sum across keys.
    // double precision for the same reason as products.base_price: a float4
    // sum stops registering small additions once it is large.
    revenueSaved: t.doublePrecision("revenue_saved").default(0).notNull(),
    revenueSavedByCurrency: t
      .jsonb("revenue_saved_by_currency")
      .$type<Record<string, number>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    environment: t.text("environment").$type<"live" | "test">().default("live").notNull(),
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // The ON CONFLICT target of every rollup upsert. campaign_id and
    // country_code are nullable; NULLS NOT DISTINCT (Postgres 15+) makes a row
    // with a NULL key conflict like any other instead of inserting a duplicate
    // row per event. Drizzle only offers nullsNotDistinct() on a unique
    // constraint (not on uniqueIndex), hence the constraint and the new name.
    t.unique("analytics_rollups_upsert_key")
      .on(
        table.organizationId,
        table.campaignId,
        table.countryCode,
        table.period,
        table.periodStart,
        table.environment,
      )
      .nullsNotDistinct(),
  ],
);

// ── API Usage (metered banner config requests) ────────────────────────────
// One row per organization, UTC day and environment. Written by the banner
// config endpoint (services/usage-meter.ts); the plan quota, the dashboard
// usage meter and admin alerts sum the 'live' rows (lib/limits.ts).
export const apiUsageDaily = pgTable(
  "api_usage_daily",
  {
    organizationId: t.text("organization_id").notNull(),
    day: t.date("day", { mode: "string" }).notNull(),
    environment: t.text("environment").$type<"live" | "test">().notNull(),
    count: t.integer("count").default(0).notNull(),
  },
  (table) => [
    t.primaryKey({ columns: [table.organizationId, table.day, table.environment] }),
  ],
);

// ── Organization Limit Overrides ──────────────────────────────────────────

export const organizationLimitOverrides = pgTable("organization_limit_overrides", {
  id: t.text("id").primaryKey(),
  organizationId: t.text("organization_id").notNull().unique(),
  maxProducts: t.integer("max_products"),
  maxApiHitsPerMonth: t.integer("max_api_hits_per_month"),
  maxTeamMembers: t.integer("max_team_members"),
  note: t.text(),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
  updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
});

// ── Admin Audit Log ──────────────────────────────────────────────────────

export const adminAuditLog = pgTable("admin_audit_log", {
  id: t.text("id").primaryKey(),
  adminUserId: t.text("admin_user_id").notNull(),
  action: t.text("action").notNull(),
  targetType: t.text("target_type").notNull(),
  targetId: t.text("target_id").notNull(),
  details: t.jsonb(),
  createdAt: t.timestamp("created_at").defaultNow().notNull(),
});
