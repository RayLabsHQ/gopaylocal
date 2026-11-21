CREATE TABLE "api_usage_daily" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"environment" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_daily_organization_id_day_environment_pk" PRIMARY KEY("organization_id","day","environment")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" text NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"campaign_a_id" text NOT NULL,
	"campaign_b_id" text NOT NULL,
	"campaign_a_name" text NOT NULL,
	"campaign_b_name" text NOT NULL,
	"traffic_split_b" integer DEFAULT 50 NOT NULL,
	"winner_campaign_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_product_scopes" (
	"member_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"all_products" boolean NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_integration_id_integrations_id_fk";
--> statement-breakpoint
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_integration_id_integrations_id_fk";
--> statement-breakpoint
-- Hand-written data step (1 of 4). The two foreign keys dropped above are re-added
-- below with ON DELETE rules. Clear references to integrations that no longer exist
-- so the re-add cannot fail. A no-op on a database where the old keys were enforced.
UPDATE "campaigns" SET "integration_id" = NULL
WHERE "integration_id" IS NOT NULL
  AND "integration_id" NOT IN (SELECT "id" FROM "integrations");
--> statement-breakpoint
DELETE FROM "coupons"
WHERE "integration_id" IS NOT NULL
  AND "integration_id" NOT IN (SELECT "id" FROM "integrations");
--> statement-breakpoint
-- Hand-written data step (2 of 4). coupons_one_active_per_country_idx (below) allows
-- one active coupon per campaign and country. Where there are several, keep the
-- newest active and mark the others as retiring.
UPDATE "coupons" AS c SET "status" = 'retiring'
FROM (
	SELECT "id", row_number() OVER (
		PARTITION BY "campaign_id", "country_code"
		ORDER BY "created_at" DESC, "id" DESC
	) AS rn
	FROM "coupons"
	WHERE "status" = 'active'
) AS d
WHERE c."id" = d."id" AND d.rn > 1;
--> statement-breakpoint
-- Hand-written data step (3 of 4). The old unique index treated NULL campaign_id and
-- country_code as distinct, so the same rollup bucket could exist more than once.
-- The new constraint (end of this file) treats NULLs as equal. Sum each set of
-- duplicates into the row with the lowest id, then delete the rest.
UPDATE "analytics_rollups" AS t
SET "impressions" = s.impressions,
	"clicks" = s.clicks,
	"copies" = s.copies,
	"redemptions" = s.redemptions,
	"revenue_saved" = s.revenue_saved
FROM (
	SELECT min("id") AS keep_id,
		sum("impressions") AS impressions,
		sum("clicks") AS clicks,
		sum("copies") AS copies,
		sum("redemptions") AS redemptions,
		sum("revenue_saved") AS revenue_saved
	FROM "analytics_rollups"
	GROUP BY "organization_id", "campaign_id", "country_code", "period", "period_start", "environment"
	HAVING count(*) > 1
) AS s
WHERE t."id" = s.keep_id;
--> statement-breakpoint
DELETE FROM "analytics_rollups" AS a
USING (
	SELECT "id", min("id") OVER (
		PARTITION BY "organization_id", "campaign_id", "country_code", "period", "period_start", "environment"
	) AS keep_id
	FROM "analytics_rollups"
) AS r
WHERE a."id" = r."id" AND r."id" <> r.keep_id;
--> statement-breakpoint
DROP INDEX IF EXISTS "analytics_rollups_upsert_idx";--> statement-breakpoint
ALTER TABLE "analytics_rollups" ADD COLUMN "revenue_saved_by_currency" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "test_provider_account_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "test_webhook_endpoint_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "test_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "health" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "member_product_access" ADD COLUMN "member_id" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_product_scopes" ADD CONSTRAINT "member_product_scopes_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_one_running_idx" ON "experiments" USING btree ("product_id","environment") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "experiments_org_idx" ON "experiments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "experiments_campaign_a_idx" ON "experiments" USING btree ("campaign_a_id");--> statement-breakpoint
CREATE INDEX "experiments_campaign_b_idx" ON "experiments" USING btree ("campaign_b_id");--> statement-breakpoint
CREATE INDEX "member_product_scopes_org_idx" ON "member_product_scopes" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_product_access" ADD CONSTRAINT "member_product_access_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_integration_idx" ON "campaigns" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_one_active_per_country_idx" ON "coupons" USING btree ("campaign_id","country_code") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "coupons_integration_idx" ON "coupons" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "member_product_access_member_idx" ON "member_product_access" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_created_idx" ON "webhook_events" USING btree ("created_at") WHERE "processed" = false;--> statement-breakpoint
ALTER TABLE "analytics_rollups" ADD CONSTRAINT "analytics_rollups_upsert_key" UNIQUE NULLS NOT DISTINCT("organization_id","campaign_id","country_code","period","period_start","environment");
--> statement-breakpoint
-- Hand-written data step (4 of 4). Product grants used to be keyed by user; they are
-- now keyed by membership. Link each existing grant to its membership, drop grants of
-- people who have left the workspace, and keep members who had grants restricted to
-- those products (a member without a scope row can see every product).
UPDATE "member_product_access" AS mpa
SET "member_id" = m."id"
FROM "member" AS m
WHERE m."organizationId" = mpa."organization_id"
  AND m."userId" = mpa."user_id"
  AND mpa."member_id" IS NULL;
--> statement-breakpoint
DELETE FROM "member_product_access" WHERE "member_id" IS NULL;
--> statement-breakpoint
INSERT INTO "member_product_scopes" ("member_id", "organization_id", "all_products", "updated_at")
SELECT DISTINCT "member_id", "organization_id", false, now()
FROM "member_product_access"
ON CONFLICT ("member_id") DO NOTHING;
