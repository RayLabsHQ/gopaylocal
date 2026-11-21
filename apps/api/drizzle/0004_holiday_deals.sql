-- Holiday deals: a named percentage with a start and an end, attached to a
-- campaign, with one discount code for every visitor. Additive only: a new
-- table, a nullable column on coupons and three indexes.
-- coupons.deal_id has no foreign key on purpose (see db/schema.ts): a coupon
-- whose deal is gone is a code that still has to be removed at the provider.
CREATE TABLE "deals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"discount_percent" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"message_template" text NOT NULL,
	"code_source" text NOT NULL,
	"manual_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN "deal_id" text;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_campaign_idx" ON "deals" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "deals_ends_at_idx" ON "deals" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_one_active_per_deal_idx" ON "coupons" USING btree ("deal_id") WHERE "status" = 'active';