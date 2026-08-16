CREATE TABLE IF NOT EXISTS "identity_suppressions" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"provider_namespace" text NOT NULL,
	"identifier_type" "customer_identifier_type" NOT NULL,
	"identifier_value" text NOT NULL,
	"reason" text NOT NULL,
	"source_request_id" text,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reactivated_at" timestamp with time zone,
	"reactivated_by" text,
	"reactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_lifecycle_store_results" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"request_id" text NOT NULL,
	"store" text NOT NULL,
	"status" "customer_context_backfill_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"checkpoint" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_lifecycle_store_results_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_retention_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"tombstone_purge_after_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_links" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_lifecycle_store_results" ADD CONSTRAINT "data_lifecycle_store_results_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_lifecycle_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_suppressions_ws_natural_uq" ON "identity_suppressions" USING btree ("workspace_id","provider_namespace","identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_suppressions_ws_active_idx" ON "identity_suppressions" USING btree ("workspace_id","reactivated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_lifecycle_store_results_ws_request_store_uq" ON "data_lifecycle_store_results" USING btree ("workspace_id","request_id","store");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_lifecycle_store_results_ws_status_idx" ON "data_lifecycle_store_results" USING btree ("workspace_id","status");