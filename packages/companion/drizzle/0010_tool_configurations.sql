CREATE TABLE "companion"."tool_configurations" (
  "tool_id" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tool_configurations_tool_id_check" CHECK ("tool_id" IN ('search', 'weather')),
  CONSTRAINT "tool_configurations_version_positive" CHECK ("version" > 0)
);
