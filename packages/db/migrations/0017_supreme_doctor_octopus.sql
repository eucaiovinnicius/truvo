CREATE TABLE IF NOT EXISTS "radar_model_versions" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"radar_id" text NOT NULL,
	"definition_version" integer NOT NULL,
	"training_request_id" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"estimator_type" text NOT NULL,
	"feature_schema_version" text NOT NULL,
	"artifact_reference" text NOT NULL,
	"artifact_checksum" text NOT NULL,
	"cutoff_ranges" jsonb NOT NULL,
	"data_counts" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"calibration" jsonb NOT NULL,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_model_versions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "radar_propensity_scores" (
	"workspace_id" text NOT NULL,
	"radar_id" text NOT NULL,
	"model_version_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"scoring_cutoff" timestamp with time zone NOT NULL,
	"probability" numeric NOT NULL,
	"feature_schema_version" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_propensity_scores_workspace_id_radar_id_model_version_id_customer_id_scoring_cutoff_pk" PRIMARY KEY("workspace_id","radar_id","model_version_id","customer_id","scoring_cutoff")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_model_versions" ADD CONSTRAINT "radar_model_versions_workspace_id_radar_id_definition_version_radar_definition_versions_workspace_id_radar_id_version_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_model_versions" ADD CONSTRAINT "radar_model_versions_workspace_id_training_request_id_radar_training_requests_workspace_id_id_fk" FOREIGN KEY ("workspace_id","training_request_id") REFERENCES "public"."radar_training_requests"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_propensity_scores" ADD CONSTRAINT "radar_propensity_scores_workspace_id_model_version_id_radar_model_versions_workspace_id_id_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "radar_model_versions_ws_request_uq" ON "radar_model_versions" USING btree ("workspace_id","training_request_id");