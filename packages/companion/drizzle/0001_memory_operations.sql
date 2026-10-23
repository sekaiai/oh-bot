CREATE TYPE "companion"."agent_kind" AS ENUM('search', 'research', 'reminder', 'workflow');--> statement-breakpoint
CREATE TYPE "companion"."agent_run_status" AS ENUM('queued', 'running', 'paused', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "companion"."backup_kind" AS ENUM('local_export', 'offsite', 'restore_drill', 'pre_upgrade');--> statement-breakpoint
CREATE TYPE "companion"."backup_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."claim_kind" AS ENUM('direct', 'reported', 'hypothetical', 'fiction', 'tool');--> statement-breakpoint
CREATE TYPE "companion"."claim_status" AS ENUM('candidate', 'confirmed', 'refuted', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."commitment_status" AS ENUM('proposed', 'scheduled', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."episode_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."event_status" AS ENUM('candidate', 'confirmed', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."job_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "companion"."memory_index_status" AS ENUM('building', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "companion"."memory_source_status" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."migration_record_status" AS ENUM('prepared', 'imported', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."model_purpose" AS ENUM('chat', 'memory', 'embedding', 'search', 'rerank');--> statement-breakpoint
CREATE TYPE "companion"."model_test_status" AS ENUM('never', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."operation_key_status" AS ENUM('leased', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."participation" AS ENUM('direct', 'reported');--> statement-breakpoint
CREATE TYPE "companion"."preference_scope" AS ENUM('temporary', 'long_term');--> statement-breakpoint
CREATE TYPE "companion"."relationship_stage" AS ENUM('new', 'known', 'close', 'partner');--> statement-breakpoint
CREATE TYPE "companion"."tool_permission" AS ENUM('read', 'external_action');--> statement-breakpoint
CREATE TYPE "companion"."tool_run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'receipt_unknown');--> statement-breakpoint
CREATE TYPE "companion"."topic_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."trigger_mode" AS ENUM('mentioned', 'all', 'disabled');--> statement-breakpoint
CREATE TYPE "companion"."validation_status" AS ENUM('candidate', 'validated', 'conflict', 'rejected');--> statement-breakpoint
CREATE TABLE "companion"."disclosure_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"source_id" uuid,
	"claim_id" uuid,
	"scope" jsonb NOT NULL,
	"allowed_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"denied_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "disclosure_rules_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."event_participants" (
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"participation" "companion"."participation" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_participants_event_id_person_id_pk" PRIMARY KEY("event_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."knowledge_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"subject_entity_id" uuid,
	"speaker_person_id" uuid,
	"source_id" uuid NOT NULL,
	"claim_text" text,
	"status" "companion"."claim_status" DEFAULT 'candidate' NOT NULL,
	"scope" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "knowledge_claims_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."memory_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"model_profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"preprocessing_version" text NOT NULL,
	"collection_name" text NOT NULL,
	"status" "companion"."memory_index_status" DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "memory_indexes_collection_name_unique" UNIQUE("collection_name"),
	CONSTRAINT "memory_indexes_dimensions_range" CHECK ("companion"."memory_indexes"."dimensions" between 1 and 16000)
);
--> statement-breakpoint
CREATE TABLE "companion"."memory_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" text NOT NULL,
	"engine_memory_id" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"index_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_mappings_engine_id_unique" UNIQUE("engine_memory_id"),
	CONSTRAINT "memory_mappings_operation_engine_unique" UNIQUE("operation_key","engine_memory_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."memory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"revision" integer NOT NULL,
	"source_id" uuid NOT NULL,
	"engine_memory_id" text,
	"fact_text" text,
	"scope" jsonb NOT NULL,
	"subject_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"status" "companion"."memory_status" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memory_revision_number_unique" UNIQUE("character_id","canonical_key","revision"),
	CONSTRAINT "memory_revisions_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"source_kind" "companion"."source_kind" NOT NULL,
	"batch_key" text NOT NULL,
	"scope" jsonb NOT NULL,
	"subject_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"speaker_person_id" uuid,
	"participant_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"claim_kind" "companion"."claim_kind" NOT NULL,
	"allowed_for_extraction" boolean DEFAULT false NOT NULL,
	"status" "companion"."memory_source_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "memory_sources_batch_key_unique" UNIQUE("batch_key")
);
--> statement-breakpoint
CREATE TABLE "companion"."memory_validation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"engine_memory_id" text,
	"status" "companion"."validation_status" NOT NULL,
	"subject_person_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"evidence_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion"."person_identity_links" (
	"alias_person_id" uuid PRIMARY KEY NOT NULL,
	"canonical_person_id" uuid NOT NULL,
	"proof_challenge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_identity_links_distinct_people" CHECK ("companion"."person_identity_links"."alias_person_id" <> "companion"."person_identity_links"."canonical_person_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."shared_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" "companion"."event_status" DEFAULT 'candidate' NOT NULL,
	"source_message_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"scope" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shared_events_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."agent_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "companion"."agent_kind" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"tool_names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"model_profile_id" uuid,
	"permissions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"budget" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_definitions_name_unique" UNIQUE("name"),
	CONSTRAINT "agent_definitions_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid,
	"conversation_id" uuid,
	"definition_id" uuid,
	"parent_run_id" uuid,
	"turn_id" uuid,
	"graph_version" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" "companion"."agent_run_status" DEFAULT 'queued' NOT NULL,
	"task" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_runs_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."backup_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "companion"."backup_kind" NOT NULL,
	"status" "companion"."backup_status" NOT NULL,
	"manifest_path" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deletion_journal_sequence" bigint,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companion"."commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"description" text,
	"source_message_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"status" "companion"."commitment_status" DEFAULT 'proposed' NOT NULL,
	"job_id" text,
	"operation_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "commitments_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "commitments_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."conversation_policies" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"trigger_mode" "companion"."trigger_mode" DEFAULT 'mentioned' NOT NULL,
	"circle_disclosure_verified" boolean DEFAULT false NOT NULL,
	"proactive_enabled" boolean DEFAULT false NOT NULL,
	"quiet_start" text DEFAULT '22:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"max_per_day" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversation_policies_max_per_day_nonnegative" CHECK ("companion"."conversation_policies"."max_per_day" >= 0),
	CONSTRAINT "conversation_policies_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."emotion_states" (
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"pleasantness" real DEFAULT 0 NOT NULL,
	"activity" real DEFAULT 0.5 NOT NULL,
	"tension" real DEFAULT 0 NOT NULL,
	"care" real DEFAULT 0.5 NOT NULL,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "emotion_states_character_id_person_id_pk" PRIMARY KEY("character_id","person_id"),
	CONSTRAINT "emotion_pleasantness_range" CHECK ("companion"."emotion_states"."pleasantness" between -1 and 1),
	CONSTRAINT "emotion_activity_range" CHECK ("companion"."emotion_states"."activity" between 0 and 1),
	CONSTRAINT "emotion_tension_range" CHECK ("companion"."emotion_states"."tension" between 0 and 1),
	CONSTRAINT "emotion_care_range" CHECK ("companion"."emotion_states"."care" between 0 and 1),
	CONSTRAINT "emotion_states_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"topic_id" uuid,
	"summary" text,
	"source_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"scope" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" "companion"."episode_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "episodes_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."interaction_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source_message_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "companion"."interaction_preferences" (
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"preferences" jsonb NOT NULL,
	"scope" "companion"."preference_scope" NOT NULL,
	"expires_at" timestamp with time zone,
	"source_message_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "interaction_preferences_character_id_person_id_pk" PRIMARY KEY("character_id","person_id"),
	CONSTRAINT "interaction_preferences_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."job_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" text NOT NULL,
	"queue_name" text NOT NULL,
	"pg_boss_id" text,
	"status" "companion"."job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_logs_operation_key_unique" UNIQUE("operation_key")
);
--> statement-breakpoint
CREATE TABLE "companion"."media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"relative_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"scope" jsonb NOT NULL,
	"source_message_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_objects_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "companion"."migration_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_hash" text NOT NULL,
	"source_path" text NOT NULL,
	"backup_manifest_path" text NOT NULL,
	"status" "companion"."migration_record_status" NOT NULL,
	"counts" jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "migration_records_source_hash_unique" UNIQUE("source_hash")
);
--> statement-breakpoint
CREATE TABLE "companion"."model_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"purpose" "companion"."model_purpose" NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"credential_ref" text NOT NULL,
	"dimensions" integer,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"monthly_budget_usd" numeric,
	"last_test_at" timestamp with time zone,
	"last_test_status" "companion"."model_test_status" DEFAULT 'never' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "model_profiles_name_unique" UNIQUE("name"),
	CONSTRAINT "model_profiles_id_purpose_unique" UNIQUE("id","purpose"),
	CONSTRAINT "model_profiles_dimensions_positive" CHECK ("companion"."model_profiles"."dimensions" is null or "companion"."model_profiles"."dimensions" > 0),
	CONSTRAINT "model_profiles_max_tokens_positive" CHECK ("companion"."model_profiles"."max_tokens" > 0),
	CONSTRAINT "model_profiles_timeout_positive" CHECK ("companion"."model_profiles"."timeout_ms" > 0),
	CONSTRAINT "model_profiles_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."model_role_bindings" (
	"character_id" uuid NOT NULL,
	"purpose" "companion"."model_purpose" NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "model_role_bindings_character_id_purpose_pk" PRIMARY KEY("character_id","purpose")
);
--> statement-breakpoint
CREATE TABLE "companion"."operation_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" "companion"."operation_key_status" NOT NULL,
	"lease_owner" text,
	"expires_at" timestamp with time zone,
	"result_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "operation_keys_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."proactive_permissions" (
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"group_conversation_id" uuid,
	"quiet_start" text DEFAULT '22:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"max_per_day" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "proactive_permissions_character_id_person_id_pk" PRIMARY KEY("character_id","person_id"),
	CONSTRAINT "proactive_permissions_max_per_day_nonnegative" CHECK ("companion"."proactive_permissions"."max_per_day" >= 0),
	CONSTRAINT "proactive_permissions_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."relationship_states" (
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"familiarity" real DEFAULT 0 NOT NULL,
	"trust" real DEFAULT 0 NOT NULL,
	"stage" "companion"."relationship_stage" DEFAULT 'new' NOT NULL,
	"boundaries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "relationship_states_character_id_person_id_pk" PRIMARY KEY("character_id","person_id"),
	CONSTRAINT "relationship_familiarity_range" CHECK ("companion"."relationship_states"."familiarity" between 0 and 1),
	CONSTRAINT "relationship_trust_range" CHECK ("companion"."relationship_states"."trust" between 0 and 1),
	CONSTRAINT "relationship_states_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid,
	"turn_id" uuid NOT NULL,
	"name" text NOT NULL,
	"operation_key" text NOT NULL,
	"permission" "companion"."tool_permission" NOT NULL,
	"status" "companion"."tool_run_status" DEFAULT 'pending' NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tool_runs_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "tool_runs_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"scope" jsonb NOT NULL,
	"source_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"status" "companion"."topic_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "topics_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "companion"."disclosure_rules" ADD CONSTRAINT "disclosure_rules_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."disclosure_rules" ADD CONSTRAINT "disclosure_rules_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "companion"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."disclosure_rules" ADD CONSTRAINT "disclosure_rules_claim_id_knowledge_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "companion"."knowledge_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."event_participants" ADD CONSTRAINT "event_participants_event_id_shared_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "companion"."shared_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."event_participants" ADD CONSTRAINT "event_participants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."knowledge_claims" ADD CONSTRAINT "knowledge_claims_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."knowledge_claims" ADD CONSTRAINT "knowledge_claims_subject_entity_id_person_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "companion"."person_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."knowledge_claims" ADD CONSTRAINT "knowledge_claims_speaker_person_id_people_id_fk" FOREIGN KEY ("speaker_person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."knowledge_claims" ADD CONSTRAINT "knowledge_claims_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "companion"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_indexes" ADD CONSTRAINT "memory_indexes_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_indexes" ADD CONSTRAINT "memory_indexes_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "companion"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_mappings" ADD CONSTRAINT "memory_mappings_revision_id_memory_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "companion"."memory_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_mappings" ADD CONSTRAINT "memory_mappings_index_id_memory_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "companion"."memory_indexes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_revisions" ADD CONSTRAINT "memory_revisions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_revisions" ADD CONSTRAINT "memory_revisions_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "companion"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_revisions" ADD CONSTRAINT "memory_revisions_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "companion"."memory_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_sources" ADD CONSTRAINT "memory_sources_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_sources" ADD CONSTRAINT "memory_sources_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_sources" ADD CONSTRAINT "memory_sources_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_sources" ADD CONSTRAINT "memory_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_sources" ADD CONSTRAINT "memory_sources_speaker_person_id_people_id_fk" FOREIGN KEY ("speaker_person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."memory_validation_records" ADD CONSTRAINT "memory_validation_records_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "companion"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."person_identity_links" ADD CONSTRAINT "person_identity_links_alias_person_id_people_id_fk" FOREIGN KEY ("alias_person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."person_identity_links" ADD CONSTRAINT "person_identity_links_canonical_person_id_people_id_fk" FOREIGN KEY ("canonical_person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."person_identity_links" ADD CONSTRAINT "person_identity_links_proof_challenge_id_binding_challenges_id_fk" FOREIGN KEY ("proof_challenge_id") REFERENCES "companion"."binding_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."shared_events" ADD CONSTRAINT "shared_events_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_definitions" ADD CONSTRAINT "agent_definitions_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "companion"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_definition_id_agent_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "companion"."agent_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_parent_fk" FOREIGN KEY ("parent_run_id") REFERENCES "companion"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."commitments" ADD CONSTRAINT "commitments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."commitments" ADD CONSTRAINT "commitments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."commitments" ADD CONSTRAINT "commitments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."commitments" ADD CONSTRAINT "commitments_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."conversation_policies" ADD CONSTRAINT "conversation_policies_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."emotion_states" ADD CONSTRAINT "emotion_states_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."emotion_states" ADD CONSTRAINT "emotion_states_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."episodes" ADD CONSTRAINT "episodes_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."episodes" ADD CONSTRAINT "episodes_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "companion"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_events" ADD CONSTRAINT "interaction_events_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_events" ADD CONSTRAINT "interaction_events_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_events" ADD CONSTRAINT "interaction_events_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_preferences" ADD CONSTRAINT "interaction_preferences_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_preferences" ADD CONSTRAINT "interaction_preferences_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."interaction_preferences" ADD CONSTRAINT "interaction_preferences_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."media_objects" ADD CONSTRAINT "media_objects_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."media_objects" ADD CONSTRAINT "media_objects_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."model_role_bindings" ADD CONSTRAINT "model_role_bindings_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."model_role_bindings" ADD CONSTRAINT "model_role_bindings_profile_purpose_fk" FOREIGN KEY ("profile_id","purpose") REFERENCES "companion"."model_profiles"("id","purpose") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."proactive_permissions" ADD CONSTRAINT "proactive_permissions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."proactive_permissions" ADD CONSTRAINT "proactive_permissions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."proactive_permissions" ADD CONSTRAINT "proactive_permissions_group_conversation_id_conversations_id_fk" FOREIGN KEY ("group_conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."relationship_states" ADD CONSTRAINT "relationship_states_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."relationship_states" ADD CONSTRAINT "relationship_states_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."tool_runs" ADD CONSTRAINT "tool_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "companion"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."topics" ADD CONSTRAINT "topics_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_indexes_one_active_per_character" ON "companion"."memory_indexes" USING btree ("character_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revision_current_validated_unique" ON "companion"."memory_revisions" USING btree ("character_id","canonical_key") WHERE "status" = 'validated' AND "valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "memory_sources_character_created_idx" ON "companion"."memory_sources" USING btree ("character_id","created_at");--> statement-breakpoint
ALTER TABLE "companion"."relationship_edges" ADD CONSTRAINT "relationship_edges_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;