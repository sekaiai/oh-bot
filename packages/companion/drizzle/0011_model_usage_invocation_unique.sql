DO $$
BEGIN
  IF EXISTS (
    SELECT profile_id, invocation_id
    FROM companion.model_usage
    GROUP BY profile_id, invocation_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'model_usage duplicate cross-month invocations require manual audit before migration 0011';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE companion.model_usage
  DROP CONSTRAINT IF EXISTS model_usage_profile_month_invocation_unique;
--> statement-breakpoint
ALTER TABLE companion.model_usage
  ADD CONSTRAINT model_usage_profile_invocation_unique UNIQUE (profile_id, invocation_id);
