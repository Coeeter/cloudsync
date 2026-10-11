CREATE TABLE "archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "archives_fingerprint_idx" ON "archives" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "archives_expiry_idx" ON "archives" USING btree ("expires_at");