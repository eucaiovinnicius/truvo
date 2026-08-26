CREATE TABLE IF NOT EXISTS "radar_definition_versions" (
	"workspace_id" text NOT NULL,
	"radar_id" text NOT NULL,
	"version" integer NOT NULL,
	"outcome_definition_id" text NOT NULL,
	"audience_ast" jsonb NOT NULL,
	"prediction_window_days" integer NOT NULL,
	"optimization_goal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activation_destination" jsonb,
	"readiness" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_definition_versions_workspace_id_radar_id_version_pk" PRIMARY KEY("workspace_id","radar_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "radar_training_requests" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"radar_id" text NOT NULL,
	"definition_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"correlation_id" text NOT NULL,
	"model_reference" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_training_requests_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "radars" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_definition_version" integer DEFAULT 1 NOT NULL,
	"current_model_reference" text,
	"paused_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radars_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "radar_training_requests_idempotency_uq" ON "radar_training_requests" USING btree ("workspace_id","radar_id","definition_version","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "radars_ws_name_uq" ON "radars" USING btree ("workspace_id","name");