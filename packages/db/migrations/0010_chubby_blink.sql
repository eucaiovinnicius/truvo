CREATE TABLE IF NOT EXISTS "billing_context_adjustments" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_adjustment_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_payment_id" text,
	"provider_invoice_id" text,
	"status" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "billing_context_adjustments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_context_invoices" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"amount_due" numeric,
	"amount_paid" numeric,
	"amount_remaining" numeric,
	"invoice_created_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"uncollectible_at" timestamp with time zone,
	CONSTRAINT "billing_context_invoices_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_context_payments" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_payment_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"provider_invoice_id" text,
	"status" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "billing_context_payments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_context_subscriptions" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_customer_id" text,
	"status" text NOT NULL,
	"product_reference" text,
	"price_reference" text,
	"quantity" integer,
	"started_at" timestamp with time zone,
	"trial_start_at" timestamp with time zone,
	"trial_end_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"collection_method" text,
	"payment_behavior" text,
	CONSTRAINT "billing_context_subscriptions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_adjustments" ADD CONSTRAINT "billing_context_adjustments_workspace_id_connection_id_connector_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_adjustments" ADD CONSTRAINT "billing_context_adjustments_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_invoices" ADD CONSTRAINT "billing_context_invoices_workspace_id_connection_id_connector_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_invoices" ADD CONSTRAINT "billing_context_invoices_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_payments" ADD CONSTRAINT "billing_context_payments_workspace_id_connection_id_connector_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_payments" ADD CONSTRAINT "billing_context_payments_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_subscriptions" ADD CONSTRAINT "billing_context_subscriptions_workspace_id_connection_id_connector_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_context_subscriptions" ADD CONSTRAINT "billing_context_subscriptions_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_context_adjustments_ws_provider_uq" ON "billing_context_adjustments" USING btree ("workspace_id","provider_namespace","provider_adjustment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_context_adjustments_ws_customer_idx" ON "billing_context_adjustments" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_context_invoices_ws_provider_uq" ON "billing_context_invoices" USING btree ("workspace_id","provider_namespace","provider_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_context_invoices_ws_customer_idx" ON "billing_context_invoices" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_context_payments_ws_provider_uq" ON "billing_context_payments" USING btree ("workspace_id","provider_namespace","provider_payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_context_payments_ws_customer_idx" ON "billing_context_payments" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_context_subscriptions_ws_provider_uq" ON "billing_context_subscriptions" USING btree ("workspace_id","provider_namespace","provider_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_context_subscriptions_ws_customer_idx" ON "billing_context_subscriptions" USING btree ("workspace_id","customer_id");