CREATE TABLE IF NOT EXISTS "onboarding_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"milestone" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_progress" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"selected_path" text,
	"current_step" text DEFAULT 'workspace_basics' NOT NULL,
	"connection_id" text,
	"source_status" text,
	"started_at" timestamp with time zone,
	"healthy_context_at" timestamp with time zone,
	"data_verified_at" timestamp with time zone,
	"readiness_viewed_at" timestamp with time zone,
	"first_radar_initiated_at" timestamp with time zone,
	"first_radar_created_at" timestamp with time zone,
	"first_radar_id" text,
	"radar_idempotency_key" text,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_remediation" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_milestones" ADD CONSTRAINT "onboarding_milestones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_milestones" ADD CONSTRAINT "onboarding_milestones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_milestones_workspace_milestone_uq" ON "onboarding_milestones" USING btree ("workspace_id","milestone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_milestones_workspace_time_idx" ON "onboarding_milestones" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_progress_workspace_updated_idx" ON "onboarding_progress" USING btree ("workspace_id","updated_at");
--> statement-breakpoint
ALTER TABLE "onboarding_progress" DROP CONSTRAINT IF EXISTS "onboarding_progress_status_check";--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_status_check" CHECK ("status" in ('not_started','in_progress','waiting_for_connection','syncing','waiting_for_data','data_detected','readiness_available','radar_in_progress','completed','blocked'));--> statement-breakpoint
ALTER TABLE "onboarding_progress" DROP CONSTRAINT IF EXISTS "onboarding_progress_path_check";--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_path_check" CHECK ("selected_path" is null or "selected_path" in ('ecommerce','saas','custom'));--> statement-breakpoint
ALTER TABLE "onboarding_milestones" DROP CONSTRAINT IF EXISTS "onboarding_milestones_name_check";--> statement-breakpoint
ALTER TABLE "onboarding_milestones" ADD CONSTRAINT "onboarding_milestones_name_check" CHECK ("milestone" in ('onboarding_started','onboarding_path_selected','context_connection_started','context_connection_succeeded','context_connection_failed','incoming_data_verified','readiness_viewed','first_radar_initiated','first_radar_created','onboarding_completed'));
