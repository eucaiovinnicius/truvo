CREATE TABLE IF NOT EXISTS "crm_accounts" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_namespace" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"name" text,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_accounts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_associations" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_namespace" text NOT NULL,
	"from_object_type" text NOT NULL,
	"from_object_id" text NOT NULL,
	"to_object_type" text NOT NULL,
	"to_object_id" text NOT NULL,
	"association_type" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_associations_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_deals" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_namespace" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"name" text,
	"amount" numeric,
	"currency" text,
	"pipeline" text,
	"stage" text,
	"status" text,
	"deal_timestamp" timestamp with time zone NOT NULL,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_deals_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm_accounts" ADD CONSTRAINT "crm_accounts_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm_associations" ADD CONSTRAINT "crm_associations_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crm_accounts_ws_provider_object_uq" ON "crm_accounts" USING btree ("workspace_id","provider_namespace","provider_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crm_associations_ws_natural_uq" ON "crm_associations" USING btree ("workspace_id","from_object_type","from_object_id","to_object_type","to_object_id","association_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crm_associations_ws_to_idx" ON "crm_associations" USING btree ("workspace_id","to_object_type","to_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crm_deals_ws_provider_object_uq" ON "crm_deals" USING btree ("workspace_id","provider_namespace","provider_object_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crm_deals_ws_stage_idx" ON "crm_deals" USING btree ("workspace_id","stage");