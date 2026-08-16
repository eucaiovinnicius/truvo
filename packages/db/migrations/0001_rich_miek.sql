DO $$ BEGIN
 CREATE TYPE "public"."customer_context_backfill_status" AS ENUM('pending', 'running', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."customer_identifier_type" AS ENUM('click_id', 'anonymous_id', 'user_id', 'email_hash', 'phone_hash', 'order_id', 'external_id');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."customer_status" AS ENUM('anonymous', 'identified', 'merged');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."customer_trait_value_type" AS ENUM('string', 'number', 'boolean', 'datetime', 'json');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."outcome_definition_kind" AS ENUM('event', 'trait');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_context_backfill_checkpoints" (
	"workspace_id" text NOT NULL,
	"backfill_key" text NOT NULL,
	"status" "customer_context_backfill_status" DEFAULT 'pending' NOT NULL,
	"cursor" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_context_backfill_checkpoint_pk" PRIMARY KEY("workspace_id","backfill_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_identifiers" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"identifier_type" "customer_identifier_type" NOT NULL,
	"provider_namespace" text NOT NULL,
	"identifier_value" text NOT NULL,
	"source_namespace" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_identifiers_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_relationships" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"from_customer_id" text NOT NULL,
	"to_customer_id" text NOT NULL,
	"relationship_namespace" text NOT NULL,
	"relationship_type" text NOT NULL,
	"source_namespace" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_relationships_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_traits" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"trait_namespace" text NOT NULL,
	"trait_key" text NOT NULL,
	"value_type" "customer_trait_value_type" NOT NULL,
	"value" jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_traits_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"legacy_canonical_id" text,
	"status" "customer_status" DEFAULT 'anonymous' NOT NULL,
	"merged_into_customer_id" text,
	"source_namespace" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outcome_definitions" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"outcome_namespace" text NOT NULL,
	"outcome_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "outcome_definition_kind" NOT NULL,
	"definition" jsonb NOT NULL,
	"source_namespace" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_definitions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_identifiers" ADD CONSTRAINT "customer_identifiers_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_relationships" ADD CONSTRAINT "customer_relationships_from_customer_fk" FOREIGN KEY ("workspace_id","from_customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_relationships" ADD CONSTRAINT "customer_relationships_to_customer_fk" FOREIGN KEY ("workspace_id","to_customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_traits" ADD CONSTRAINT "customer_traits_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_context_backfill_status_idx" ON "customer_context_backfill_checkpoints" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_identifiers_ws_provider_type_value_uq" ON "customer_identifiers" USING btree ("workspace_id","provider_namespace","identifier_type","identifier_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_identifiers_ws_customer_idx" ON "customer_identifiers" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_relationships_ws_natural_uq" ON "customer_relationships" USING btree ("workspace_id","from_customer_id","to_customer_id","relationship_namespace","relationship_type","source_namespace");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_relationships_ws_to_idx" ON "customer_relationships" USING btree ("workspace_id","to_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_traits_ws_customer_namespace_key_uq" ON "customer_traits" USING btree ("workspace_id","customer_id","trait_namespace","trait_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_traits_ws_customer_observed_idx" ON "customer_traits" USING btree ("workspace_id","customer_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_ws_legacy_canonical_uq" ON "customers" USING btree ("workspace_id","legacy_canonical_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_ws_status_last_seen_idx" ON "customers" USING btree ("workspace_id","status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outcome_definitions_ws_namespace_key_uq" ON "outcome_definitions" USING btree ("workspace_id","outcome_namespace","outcome_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_definitions_ws_active_idx" ON "outcome_definitions" USING btree ("workspace_id","is_active");