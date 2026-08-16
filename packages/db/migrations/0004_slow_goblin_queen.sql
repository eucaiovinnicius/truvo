DO $$ BEGIN
 CREATE TYPE "public"."identity_conflict_status" AS ENUM('open', 'resolved', 'dismissed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."identity_merge_operation" AS ENUM('merge', 'unmerge');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_conflicts" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"existing_customer_id" text NOT NULL,
	"incoming_customer_id" text NOT NULL,
	"identifier_type" "customer_identifier_type" NOT NULL,
	"provider_namespace" text NOT NULL,
	"identifier_value" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"status" "identity_conflict_status" DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_conflicts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_merge_events" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"operation" "identity_merge_operation" NOT NULL,
	"source_customer_id" text NOT NULL,
	"target_customer_id" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"actor" jsonb NOT NULL,
	"reversed_by_event_id" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_merge_events_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_conflicts" ADD CONSTRAINT "identity_conflicts_existing_customer_fk" FOREIGN KEY ("workspace_id","existing_customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_events" ADD CONSTRAINT "identity_merge_events_source_customer_fk" FOREIGN KEY ("workspace_id","source_customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_merge_events" ADD CONSTRAINT "identity_merge_events_target_customer_fk" FOREIGN KEY ("workspace_id","target_customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_conflicts_ws_natural_open_uq" ON "identity_conflicts" USING btree ("workspace_id","existing_customer_id","incoming_customer_id","provider_namespace","identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_conflicts_ws_status_detected_idx" ON "identity_conflicts" USING btree ("workspace_id","status","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_merge_events_ws_target_at_idx" ON "identity_merge_events" USING btree ("workspace_id","target_customer_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_merge_events_ws_source_at_idx" ON "identity_merge_events" USING btree ("workspace_id","source_customer_id","at");