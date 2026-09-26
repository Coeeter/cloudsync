CREATE COLLATION IF NOT EXISTS "natural" (provider = icu, locale = 'und-u-kn-ks-level2', deterministic = true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_listing_idx" ON "entries" ("parent_id", (CASE WHEN "kind" = 'directory' THEN 0 ELSE 1 END), "name" COLLATE "natural", "id") WHERE "deleted_at" IS NULL;
