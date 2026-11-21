CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"campaign_id" text,
	"country_code" text,
	"period" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"copies" integer DEFAULT 0 NOT NULL,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"revenue_saved" real DEFAULT 0 NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"key_type" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"full_key" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "banner_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"position" text DEFAULT 'bottom' NOT NULL,
	"message_template" text NOT NULL,
	"cta_text" text DEFAULT 'Copy Code' NOT NULL,
	"background_color" text DEFAULT '#1a1a2e' NOT NULL,
	"text_color" text DEFAULT '#ffffff' NOT NULL,
	"cta_color" text DEFAULT '#e94560' NOT NULL,
	"cta_text_color" text DEFAULT '#ffffff' NOT NULL,
	"show_flag" boolean DEFAULT true NOT NULL,
	"show_close_btn" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "banner_configs_campaign_id_unique" UNIQUE("campaign_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" text NOT NULL,
	"integration_id" text,
	"name" text NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"pricing_mode" text DEFAULT 'group' NOT NULL,
	"discount_delivery" text DEFAULT 'banner_coupon' NOT NULL,
	"charm_pricing_strategy" text DEFAULT 'none' NOT NULL,
	"max_discount_percent" real DEFAULT 70 NOT NULL,
	"discount_overrides" jsonb,
	"coupon_prefix" text,
	"allowed_domains" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_parity_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"parity_group_id" text NOT NULL,
	"country_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"integration_id" text,
	"parity_group_id" text,
	"country_code" text,
	"environment" text DEFAULT 'live' NOT NULL,
	"code" text NOT NULL,
	"discount_percent" real NOT NULL,
	"provider_coupon_id" text,
	"provider_promo_code_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"live_access_token_enc" text,
	"live_refresh_token_enc" text,
	"test_access_token_enc" text,
	"test_refresh_token_enc" text,
	"provider_account_id" text,
	"webhook_endpoint_id" text,
	"webhook_secret_enc" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"teamId" text,
	"inviterId" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_product_access" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_limit_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"max_products" integer,
	"max_api_hits_per_month" integer,
	"max_team_members" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_limit_overrides_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parity_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"discount_percent" real NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"base_price" real NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"activeOrganizationId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan" text NOT NULL,
	"dodo_cust_id" text,
	"dodo_sub_id" text,
	"status" text NOT NULL,
	"current_period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean,
	"banReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp,
	"updatedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider" text NOT NULL,
	"data" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "webhook_events_webhook_id_unique" UNIQUE("webhook_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banner_configs" ADD CONSTRAINT "banner_configs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "country_parity_mappings" ADD CONSTRAINT "country_parity_mappings_parity_group_id_parity_groups_id_fk" FOREIGN KEY ("parity_group_id") REFERENCES "public"."parity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_product_access" ADD CONSTRAINT "member_product_access_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_rollups_upsert_idx" ON "analytics_rollups" USING btree ("organization_id","campaign_id","country_code","period","period_start","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "member_product_access_idx" ON "member_product_access" USING btree ("organization_id","user_id","product_id");