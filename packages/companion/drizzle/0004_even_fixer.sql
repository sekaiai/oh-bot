ALTER TABLE "companion"."conversations" ADD COLUMN "roster_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companion"."delivery_outbox" ADD COLUMN "lease_owner" text;