CREATE TABLE IF NOT EXISTS "customer_outcomes" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"outcome_definition_id" text NOT NULL,
	"outcome_namespace" text NOT NULL,
	"outcome_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_id" text NOT NULL,
	"value" numeric,
	"currency" text,
	"source_namespace" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_outcomes_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_outcomes" ADD CONSTRAINT "customer_outcomes_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_outcomes" ADD CONSTRAINT "customer_outcomes_definition_fk" FOREIGN KEY ("workspace_id","outcome_definition_id") REFERENCES "public"."outcome_definitions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_outcomes_ws_namespace_key_dedupe_uq" ON "customer_outcomes" USING btree ("workspace_id","outcome_namespace","outcome_key","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_outcomes_ws_customer_observed_idx" ON "customer_outcomes" USING btree ("workspace_id","customer_id","observed_at");