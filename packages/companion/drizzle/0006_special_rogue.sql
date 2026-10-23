ALTER TABLE "companion"."job_logs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "companion"."job_logs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companion"."job_logs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "companion"."job_logs" ADD CONSTRAINT "job_logs_version_positive" CHECK ("version" >= 1);