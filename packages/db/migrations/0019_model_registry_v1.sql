CREATE TABLE IF NOT EXISTS "radar_model_monitoring_snapshots" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"radar_id" text NOT NULL,
	"model_version_id" text NOT NULL,
	"snapshot_type" text NOT NULL,
	"health_status" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_model_monitoring_snapshots_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "model_role" text DEFAULT 'propensity' NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "radar_model_versions" ADD COLUMN "validation" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "radar_model_versions" SET "status"='retired',"validation"=jsonb_build_object('legacy',true,'promotionEligible',false)
WHERE "status"='active' AND ("artifact_bucket"='legacy-unverified' OR "artifact_object_key" like 'legacy/%');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "radar_model_versions_one_active_role_uq" ON "radar_model_versions" USING btree ("workspace_id","radar_id","model_role") WHERE "status"='active';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_model_monitoring_snapshots" ADD CONSTRAINT "radar_model_monitoring_snapshots_workspace_id_model_version_id_radar_model_versions_workspace_id_id_fk" FOREIGN KEY ("workspace_id","model_version_id") REFERENCES "public"."radar_model_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "radar_model_monitoring_model_observed_idx" ON "radar_model_monitoring_snapshots" USING btree ("workspace_id","model_version_id","observed_at");
