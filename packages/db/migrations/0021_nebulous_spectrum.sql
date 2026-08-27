ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_state_check" CHECK (
  "status" IN ('building', 'completed', 'failed')
  AND "is_current" IN (0, 1)
  AND ("is_current" = 0 OR ("status" = 'completed' AND "materialized_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_count_check" CHECK (
  "row_count" >= 0 AND "eligible_count" >= 0 AND "monetary_row_count" >= 0
  AND "eligible_count" <= "row_count" AND "monetary_row_count" <= "eligible_count"
);
--> statement-breakpoint
ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_probability_check" CHECK ("probability" >= 0 AND "probability" <= 1);
--> statement-breakpoint
ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_band_check" CHECK ("score_band" IN ('high', 'medium', 'low'));
--> statement-breakpoint
ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_value_check" CHECK (
  ("expected_outcome_value" IS NULL AND "expected_revenue" IS NULL AND "currency" IS NULL)
  OR ("expected_outcome_value" >= 0 AND "expected_revenue" >= 0 AND length(trim("currency")) = 3)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_radar_fk" FOREIGN KEY ("workspace_id","radar_id") REFERENCES "public"."radars"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_definition_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_model_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_batches" ADD CONSTRAINT "opportunity_batches_score_batch_fk" FOREIGN KEY ("workspace_id","radar_id","model_version_id","score_cutoff") REFERENCES "public"."radar_score_batches"("workspace_id","radar_id","model_version_id","scoring_cutoff") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."opportunity_batches"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_radar_fk" FOREIGN KEY ("workspace_id","radar_id") REFERENCES "public"."radars"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_rows" ADD CONSTRAINT "opportunity_rows_model_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "opportunity_rows_batch_rank_idx";
--> statement-breakpoint
CREATE INDEX "opportunity_rows_probability_rank_idx" ON "opportunity_rows" ("workspace_id","batch_id","eligibility_state","probability","id");
--> statement-breakpoint
CREATE INDEX "opportunity_rows_revenue_rank_idx" ON "opportunity_rows" ("workspace_id","batch_id","eligibility_state","currency","expected_revenue","probability","id");
--> statement-breakpoint
CREATE INDEX "opportunity_rows_customer_idx" ON "opportunity_rows" ("workspace_id","customer_id","created_at");
--> statement-breakpoint
CREATE TABLE "opportunity_exports" (
  "workspace_id" text NOT NULL,
  "id" text NOT NULL,
  "radar_id" text NOT NULL,
  "batch_id" text NOT NULL,
  "model_version_id" text NOT NULL,
  "actor_user_id" text,
  "correlation_id" text NOT NULL,
  "selection" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "opportunity_exports_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
  CONSTRAINT "opportunity_exports_status_check" CHECK ("status" IN ('pending','completed','failed') AND "row_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_exports_correlation_uq" ON "opportunity_exports" ("workspace_id","correlation_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_exports" ADD CONSTRAINT "opportunity_exports_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."opportunity_batches"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_exports" ADD CONSTRAINT "opportunity_exports_model_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE "opportunity_activations" (
  "workspace_id" text NOT NULL,
  "id" text NOT NULL,
  "radar_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "model_version_id" text NOT NULL,
  "batch_id" text NOT NULL,
  "connection_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "selection" jsonb NOT NULL,
  "counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "remote_audience_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "opportunity_activations_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
  CONSTRAINT "opportunity_activations_status_check" CHECK ("status" IN ('pending','success','partial','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_activations_idempotency_uq" ON "opportunity_activations" ("workspace_id","idempotency_key");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_activations" ADD CONSTRAINT "opportunity_activations_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."opportunity_batches"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_activations" ADD CONSTRAINT "opportunity_activations_definition_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_activations" ADD CONSTRAINT "opportunity_activations_model_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunity_activations" ADD CONSTRAINT "opportunity_activations_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
