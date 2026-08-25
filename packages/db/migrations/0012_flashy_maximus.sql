CREATE TABLE IF NOT EXISTS "quality_evaluations" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data_health_score" integer DEFAULT 100 NOT NULL,
	"data_health_status" text DEFAULT 'healthy' NOT NULL,
	"context_coverage_score" integer DEFAULT 0 NOT NULL,
	"identity_coverage" integer DEFAULT 0 NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_freshness" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duplicate_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warnings_count" integer DEFAULT 0 NOT NULL,
	"radar_readiness" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quality_issues" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"stable_key" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_namespace" text,
	"connection_id" text,
	"stream_key" text,
	"entity_type" text,
	"entity_id" text,
	"event_name" text,
	"sample_context" jsonb,
	"action_code" text,
	"details" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_issues_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quality_issues_ws_stable_key_uq" ON "quality_issues" USING btree ("workspace_id","stable_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_issues_ws_status_idx" ON "quality_issues" USING btree ("workspace_id","status");