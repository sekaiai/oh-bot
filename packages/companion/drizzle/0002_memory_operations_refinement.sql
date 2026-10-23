ALTER TABLE "companion"."operation_keys" RENAME COLUMN "expires_at" TO "lease_expires_at";--> statement-breakpoint
ALTER TABLE "companion"."proactive_permissions" DROP CONSTRAINT "proactive_permissions_group_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "companion"."agent_runs" ADD CONSTRAINT "agent_runs_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "companion"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."tool_runs" ADD CONSTRAINT "tool_runs_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "companion"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion"."proactive_permissions" DROP COLUMN "group_conversation_id";