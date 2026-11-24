-- One subscription row per organization, and what each one is.
-- Dodo sends subscription.active and subscription.renewed at the same moment
-- for a new subscription; with no unique key both deliveries could insert a
-- row. Keep the most recently updated row of each organization (the webhook
-- updated every row of an organization alike, so the copies match), then add
-- the key the webhook now upserts on.
DELETE FROM "subscriptions" AS s
USING "subscriptions" AS k
WHERE s."organization_id" = k."organization_id"
  AND (s."updated_at", s."id") < (k."updated_at", k."id");--> statement-breakpoint
-- The Dodo mode the subscription was paid in. Existing rows default to live;
-- a deployment that billed in test mode before this migration marks those
-- rows itself.
ALTER TABLE "subscriptions" ADD COLUMN "environment" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "recurring_amount" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_country" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_unique" UNIQUE("organization_id");
