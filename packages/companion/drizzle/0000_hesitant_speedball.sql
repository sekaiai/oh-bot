CREATE SCHEMA "companion";
--> statement-breakpoint
CREATE TYPE "companion"."actor_kind" AS ENUM('admin', 'person', 'system');--> statement-breakpoint
CREATE TYPE "companion"."business_outbox_status" AS ENUM('pending', 'leased', 'dispatched', 'failed');--> statement-breakpoint
CREATE TYPE "companion"."conversation_kind" AS ENUM('private', 'group');--> statement-breakpoint
CREATE TYPE "companion"."deletion_status" AS ENUM('pending', 'applied');--> statement-breakpoint
CREATE TYPE "companion"."delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'receipt_unknown');--> statement-breakpoint
CREATE TYPE "companion"."entity_status" AS ENUM('candidate', 'confirmed', 'superseded');--> statement-breakpoint
CREATE TYPE "companion"."member_role" AS ENUM('member', 'owner');--> statement-breakpoint
CREATE TYPE "companion"."memory_status" AS ENUM('candidate', 'validated', 'conflict', 'superseded', 'deleted');--> statement-breakpoint
CREATE TYPE "companion"."message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "companion"."person_status" AS ENUM('active', 'erased');--> statement-breakpoint
CREATE TYPE "companion"."platform" AS ENUM('qq', 'weixin', 'dingtalk');--> statement-breakpoint
CREATE TYPE "companion"."source_kind" AS ENUM('user', 'assistant', 'tool', 'legacy');--> statement-breakpoint
CREATE TYPE "companion"."turn_status" AS ENUM('received', 'processing', 'generated', 'sent', 'failed', 'receipt_unknown');--> statement-breakpoint
CREATE TABLE "companion"."binding_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"source_identity_id" uuid NOT NULL,
	"target_platform" "companion"."platform" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_challenges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "companion"."character_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"core" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "character_versions_character_revision_unique" UNIQUE("character_id","revision"),
	CONSTRAINT "character_versions_character_id_id_unique" UNIQUE("character_id","id")
);
--> statement-breakpoint
CREATE TABLE "companion"."characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "characters_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."circle_members" (
	"circle_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "companion"."member_role" DEFAULT 'member' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circle_members_circle_id_person_id_pk" PRIMARY KEY("circle_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" "companion"."person_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "people_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."person_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid,
	"display_name" text NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "person_entities_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."platform_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"platform" "companion"."platform" NOT NULL,
	"platform_user_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identity_platform_user_unique" UNIQUE("platform","platform_user_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."primary_relationship_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "primary_binding_character_unique" UNIQUE("character_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."relationship_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "companion"."entity_status" DEFAULT 'candidate' NOT NULL,
	"source_message_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "relationship_edges_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."social_circles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "social_circles_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" "companion"."actor_kind" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion"."business_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "companion"."business_outbox_status" DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_outbox_operation_key_unique" UNIQUE("operation_key")
);
--> statement-breakpoint
CREATE TABLE "companion"."conversation_members" (
	"conversation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_person_id_pk" PRIMARY KEY("conversation_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"platform" "companion"."platform" NOT NULL,
	"platform_conversation_id" text NOT NULL,
	"kind" "companion"."conversation_kind" NOT NULL,
	"circle_id" uuid,
	"participants_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversations_identity_unique" UNIQUE("character_id","platform","platform_conversation_id","kind"),
	CONSTRAINT "conversations_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."deletion_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"person_id" uuid,
	"scope" jsonb NOT NULL,
	"source_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"memory_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"operation_key" text NOT NULL,
	"status" "companion"."deletion_status" DEFAULT 'pending' NOT NULL,
	"journal_sequence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "deletion_records_operation_key_unique" UNIQUE("operation_key")
);
--> statement-breakpoint
CREATE TABLE "companion"."delivery_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" "companion"."delivery_status" DEFAULT 'pending' NOT NULL,
	"platform_receipt" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "delivery_outbox_turn_id_unique" UNIQUE("turn_id"),
	CONSTRAINT "delivery_outbox_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "delivery_outbox_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "companion"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"person_id" uuid,
	"platform" "companion"."platform" NOT NULL,
	"platform_event_id" text NOT NULL,
	"role" "companion"."message_role" NOT NULL,
	"text" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "messages_platform_event_unique" UNIQUE("platform","platform_event_id")
);
--> statement-breakpoint
CREATE TABLE "companion"."turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_message_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "companion"."turn_status" DEFAULT 'received' NOT NULL,
	"graph_thread_id" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_inbound_message_id_unique" UNIQUE("inbound_message_id"),
	CONSTRAINT "turns_version_positive" CHECK ("version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "companion"."binding_challenges" ADD CONSTRAINT "binding_challenges_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."binding_challenges" ADD CONSTRAINT "binding_challenges_source_identity_id_platform_identities_id_fk" FOREIGN KEY ("source_identity_id") REFERENCES "companion"."platform_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."character_versions" ADD CONSTRAINT "character_versions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."characters" ADD CONSTRAINT "characters_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "companion"."character_versions"("character_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."circle_members" ADD CONSTRAINT "circle_members_circle_id_social_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "companion"."social_circles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."circle_members" ADD CONSTRAINT "circle_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."person_entities" ADD CONSTRAINT "person_entities_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."person_entities" ADD CONSTRAINT "person_entities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."platform_identities" ADD CONSTRAINT "platform_identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."primary_relationship_bindings" ADD CONSTRAINT "primary_relationship_bindings_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."primary_relationship_bindings" ADD CONSTRAINT "primary_relationship_bindings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."relationship_edges" ADD CONSTRAINT "relationship_edges_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."relationship_edges" ADD CONSTRAINT "relationship_edges_subject_entity_id_person_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "companion"."person_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."relationship_edges" ADD CONSTRAINT "relationship_edges_object_entity_id_person_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "companion"."person_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."social_circles" ADD CONSTRAINT "social_circles_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."conversation_members" ADD CONSTRAINT "conversation_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."conversations" ADD CONSTRAINT "conversations_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."conversations" ADD CONSTRAINT "conversations_circle_id_social_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "companion"."social_circles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."deletion_records" ADD CONSTRAINT "deletion_records_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "companion"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."deletion_records" ADD CONSTRAINT "deletion_records_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."delivery_outbox" ADD CONSTRAINT "delivery_outbox_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "companion"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."delivery_outbox" ADD CONSTRAINT "delivery_outbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."messages" ADD CONSTRAINT "messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "companion"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."turns" ADD CONSTRAINT "turns_inbound_message_id_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "companion"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."turns" ADD CONSTRAINT "turns_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "companion"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "circle_members_person_idx" ON "companion"."circle_members" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_entities_character_idx" ON "companion"."person_entities" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "platform_identity_person_idx" ON "companion"."platform_identities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "primary_binding_person_idx" ON "companion"."primary_relationship_bindings" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "relationship_edges_character_idx" ON "companion"."relationship_edges" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "social_circles_character_idx" ON "companion"."social_circles" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "companion"."audit_events" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "business_outbox_dispatch_idx" ON "companion"."business_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "conversation_members_person_idx" ON "companion"."conversation_members" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "conversations_character_idx" ON "companion"."conversations" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "deletion_records_person_idx" ON "companion"."deletion_records" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_outbox_status_idx" ON "companion"."delivery_outbox" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_occurred_idx" ON "companion"."messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_person_idx" ON "companion"."messages" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "turns_status_lease_idx" ON "companion"."turns" USING btree ("status","lease_expires_at");