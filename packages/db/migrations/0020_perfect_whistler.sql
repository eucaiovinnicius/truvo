CREATE TABLE IF NOT EXISTS "opportunity_batches" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"radar_id" text NOT NULL,
	"definition_version" integer NOT NULL,
	"model_version_id" text NOT NULL,
	"score_cutoff" timestamp with time zone NOT NULL,
	"policy_version" text DEFAULT 'opportunity-v1' NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"is_current" integer DEFAULT 0 NOT NULL,
	"trigger_reason" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"eligible_count" integer DEFAULT 0 NOT NULL,
	"monetary_row_count" integer DEFAULT 0 NOT NULL,
	"aggregate_expected_revenue" numeric,
	"aggregate_currency" text,
	"materialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_batches_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opportunity_rows" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"batch_id" text NOT NULL,
	"radar_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"model_version_id" text NOT NULL,
	"probability" numeric NOT NULL,
	"score_band" text NOT NULL,
	"scored_at" timestamp with time zone NOT NULL,
	"prediction_window_end" timestamp with time zone NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility_state" text NOT NULL,
	"expected_outcome_value" numeric,
	"expected_revenue" numeric,
	"currency" text,
	"value_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_rows_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_batches_one_current_uq" ON "opportunity_batches" USING btree ("workspace_id","radar_id") WHERE is_current=1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_batches_logical_uq" ON "opportunity_batches" USING btree ("workspace_id","radar_id","model_version_id","score_cutoff","policy_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_batches_radar_current_idx" ON "opportunity_batches" USING btree ("workspace_id","radar_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_rows_batch_customer_uq" ON "opportunity_rows" USING btree ("workspace_id","batch_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_rows_batch_rank_idx" ON "opportunity_rows" USING btree ("workspace_id","batch_id","eligibility_state","probability","id");