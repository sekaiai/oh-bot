CREATE TABLE IF NOT EXISTS companion.model_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES companion.model_profiles(id),
  usage_month text NOT NULL CHECK (usage_month ~ '^[0-9]{4}-[0-9]{2}$'),
  invocation_id text NOT NULL,
  input_hash text NOT NULL,
  reserved_usd numeric(18, 8) NOT NULL CHECK (reserved_usd >= 0),
  actual_usd numeric(18, 8) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT model_usage_profile_month_invocation_unique UNIQUE (profile_id, usage_month, invocation_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_usage_profile_month_idx ON companion.model_usage (profile_id, usage_month);
