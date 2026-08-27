CREATE TABLE IF NOT EXISTS "radar_score_batches" (
	"workspace_id" text NOT NULL,
	"radar_id" text NOT NULL,
	"definition_version" integer NOT NULL,
	"model_version_id" text NOT NULL,
	"scoring_cutoff" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scored_customer_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_score_batches_workspace_id_radar_id_model_version_id_scoring_cutoff_pk" PRIMARY KEY("workspace_id","radar_id","model_version_id","scoring_cutoff")
);
--> statement-breakpoint
DROP INDEX IF EXISTS "radar_training_requests_one_per_definition_uq";--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "target_outcome_definition_id" text;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "prediction_window_days" integer;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "artifact_provider" text DEFAULT 'supabase_storage' NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "artifact_bucket" text;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "artifact_object_key" text;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "serialization_format" text DEFAULT 'joblib-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "selection_reason" text;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "radar_model_versions" m SET
  "target_outcome_definition_id"=d."outcome_definition_id",
  "prediction_window_days"=d."prediction_window_days",
  "artifact_bucket"='legacy-unverified',
  "artifact_object_key"='legacy/' || m."id",
  "selection_reason"='legacy_pre_runtime_closure_not_promotion_eligible',
  "verified_at"=m."created_at",
  "status"='historical'
FROM "radar_definition_versions" d
WHERE d."workspace_id"=m."workspace_id" AND d."radar_id"=m."radar_id" AND d."version"=m."definition_version";--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "target_outcome_definition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "prediction_window_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "artifact_bucket" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "artifact_object_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "selection_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ALTER COLUMN "verified_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_propensity_scores" ADD COLUMN "definition_version" integer;--> statement-breakpoint
UPDATE "radar_propensity_scores" s SET "definition_version"=m."definition_version"
FROM "radar_model_versions" m WHERE m."workspace_id"=s."workspace_id" AND m."id"=s."model_version_id";--> statement-breakpoint
ALTER TABLE "radar_propensity_scores" ALTER COLUMN "definition_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "last_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "radar_training_requests" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_score_batches" ADD CONSTRAINT "radar_score_batches_workspace_id_model_version_id_radar_model_versions_workspace_id_id_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_score_batches" ADD CONSTRAINT "radar_score_batches_workspace_id_radar_id_definition_version_radar_definition_versions_workspace_id_radar_id_version_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "radar_score_batches_recoverable_idx" ON "radar_score_batches" USING btree ("status","lease_expires_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_propensity_scores" ADD CONSTRAINT "radar_propensity_scores_workspace_id_radar_id_definition_version_radar_definition_versions_workspace_id_radar_id_version_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_propensity_scores" ADD CONSTRAINT "radar_propensity_scores_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "radar_model_versions_ws_artifact_uq" ON "radar_model_versions" USING btree ("workspace_id","artifact_bucket","artifact_object_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "radar_training_requests_claimable_idx" ON "radar_training_requests" USING btree ("status","lease_expires_at");
