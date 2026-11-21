-- products.base_price and analytics_rollups.revenue_saved go from real (float4)
-- to double precision (float8), cast through text: a direct real -> double
-- precision cast exposes float4 noise (19.99 becomes 19.989999771118164), while
-- float4's text output is the shortest string that reads back as the same
-- float4 (19.99), so the new column holds the value that was shown.
-- The cast through text loses digits when the session's extra_float_digits is 0
-- (float4 text is then rounded to 6 significant digits: 1234567.9 would become
-- 1234570). SET LOCAL pins it to 1 for this transaction only; the migrator
-- applies all pending migrations in one transaction.
SET LOCAL extra_float_digits = 1;--> statement-breakpoint
ALTER TABLE "analytics_rollups" ALTER COLUMN "revenue_saved" SET DATA TYPE double precision USING ("revenue_saved"::text)::double precision;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "base_price" SET DATA TYPE double precision USING ("base_price"::text)::double precision;--> statement-breakpoint
-- Product currency codes are now stored trimmed and in upper case. Earlier
-- provider imports stored whatever case the provider sent ("usd").
UPDATE "products" SET "currency" = upper(btrim("currency")) WHERE "currency" <> upper(btrim("currency"));--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;