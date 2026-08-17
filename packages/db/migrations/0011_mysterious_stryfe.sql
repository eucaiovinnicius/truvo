DO $$ BEGIN
 CREATE TYPE "public"."engagement_kind" AS ENUM('received', 'delivery', 'opened', 'clicked', 'bounced', 'unsubscribed', 'marked_spam', 'other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "engagement_events" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"metric_name" text NOT NULL,
	"engagement_kind" "engagement_kind" NOT NULL,
	"campaign_id" text,
	"flow_id" text,
	"correlation_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_events_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_events_ws_namespace_event_uq" ON "engagement_events" USING btree ("workspace_id","provider_namespace","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_events_ws_customer_occurred_idx" ON "engagement_events" USING btree ("workspace_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_events_ws_correlation_idx" ON "engagement_events" USING btree ("workspace_id","correlation_id");