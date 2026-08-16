DO $$ BEGIN
 CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'api_key');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."data_lifecycle_kind" AS ENUM('subject_export', 'subject_deletion', 'workspace_deletion');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" "audit_actor_type" DEFAULT 'user' NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"resource_type" text NOT NULL,
	"resource_id" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_lifecycle_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" "data_lifecycle_kind" NOT NULL,
	"target_customer_id" text,
	"status" "customer_context_backfill_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_email" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cursor" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result_ref" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ws_at_idx" ON "audit_log" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ws_actor_at_idx" ON "audit_log" USING btree ("workspace_id","actor_user_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ws_category_at_idx" ON "audit_log" USING btree ("workspace_id","category","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ws_resource_idx" ON "audit_log" USING btree ("workspace_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_lifecycle_requests_ws_status_idx" ON "data_lifecycle_requests" USING btree ("workspace_id","kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_lifecycle_requests_ws_target_idx" ON "data_lifecycle_requests" USING btree ("workspace_id","target_customer_id");