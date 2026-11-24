CREATE TABLE "campaign_country_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider_product_id" text NOT NULL,
	"wanted" text NOT NULL,
	"published" jsonb,
	"last_sync" jsonb,
	"remaining" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "provider_product_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_country_prices_campaign_product_idx" ON "campaign_country_prices" USING btree ("campaign_id","provider_product_id");--> statement-breakpoint
CREATE INDEX "campaign_country_prices_org_idx" ON "campaign_country_prices" USING btree ("organization_id");