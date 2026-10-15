CREATE TABLE IF NOT EXISTS "truvo_product_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "truvo_product_events_name_check" CHECK ("event_name" IN ('workspace_created','integration_connected','integration_failed','first_event_received','context_ready','radar_created','radar_ready','radar_failed','opportunities_generated','opportunity_viewed','audience_exported','activation_requested','activation_completed','activation_failed','first_outcome_observed')),
	CONSTRAINT "truvo_product_events_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truvo_product_events" ADD CONSTRAINT "truvo_product_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truvo_product_events_workspace_idempotency_uq" ON "truvo_product_events" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truvo_product_events_workspace_event_time_idx" ON "truvo_product_events" USING btree ("workspace_id","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truvo_product_events_event_time_idx" ON "truvo_product_events" USING btree ("event_name","occurred_at");
