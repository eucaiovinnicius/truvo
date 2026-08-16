DO $$ BEGIN
 CREATE TYPE "public"."connector_credential_status" AS ENUM('unset', 'valid', 'invalid', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_destination_write_status" AS ENUM('sent', 'failed', 'skipped_duplicate');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_failure_kind" AS ENUM('transient', 'permanent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_lifecycle_state" AS ENUM('draft', 'authorizing', 'connected', 'syncing', 'healthy', 'degraded', 'error', 'disconnected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_role" AS ENUM('source', 'destination', 'bidirectional');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_sync_run_kind" AS ENUM('backfill', 'incremental', 'webhook_ingest');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_sync_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'rate_limited');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_connections" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"provider" text NOT NULL,
	"role" "connector_role" NOT NULL,
	"display_name" text NOT NULL,
	"lifecycle_state" "connector_lifecycle_state" DEFAULT 'draft' NOT NULL,
	"credential_status" "connector_credential_status" DEFAULT 'unset' NOT NULL,
	"credentials_encrypted" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"last_credential_check_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_connections_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_destination_writes" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "connector_destination_write_status" NOT NULL,
	"external_result_id" text,
	"retryable" boolean,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_destination_writes_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_sync_checkpoints" (
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"stream_key" text NOT NULL,
	"cursor" text,
	"status" "customer_context_backfill_status" DEFAULT 'pending' NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_sync_checkpoints_pk" PRIMARY KEY("workspace_id","connection_id","stream_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_sync_runs" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" "connector_sync_run_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "connector_sync_run_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"records_read" integer DEFAULT 0 NOT NULL,
	"records_written" integer DEFAULT 0 NOT NULL,
	"error_kind" "connector_failure_kind",
	"error_reason" text,
	"next_retry_at" timestamp with time zone,
	"checkpoint_before" text,
	"checkpoint_after" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_sync_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_destination_writes" ADD CONSTRAINT "connector_destination_writes_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_sync_checkpoints" ADD CONSTRAINT "connector_sync_checkpoints_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_connections_ws_provider_idx" ON "connector_connections" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_connections_ws_lifecycle_idx" ON "connector_connections" USING btree ("workspace_id","lifecycle_state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_destination_writes_ws_connection_idempotency_uq" ON "connector_destination_writes" USING btree ("workspace_id","connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_destination_writes_ws_connection_created_idx" ON "connector_destination_writes" USING btree ("workspace_id","connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_sync_runs_ws_connection_idempotency_uq" ON "connector_sync_runs" USING btree ("workspace_id","connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_sync_runs_ws_status_retry_idx" ON "connector_sync_runs" USING btree ("workspace_id","status","next_retry_at");