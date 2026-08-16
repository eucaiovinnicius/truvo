CREATE TABLE IF NOT EXISTS "commerce_order_line_items" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"provider_line_item_id" text NOT NULL,
	"provider_product_id" text,
	"provider_variant_id" text,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_line_items_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_orders" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"customer_id" text,
	"provider_namespace" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"financial_status" text NOT NULL,
	"currency" text NOT NULL,
	"total_amount" numeric NOT NULL,
	"order_timestamp" timestamp with time zone NOT NULL,
	"source_namespace" text NOT NULL,
	"provenance" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_orders_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_refunds" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"provider_namespace" text NOT NULL,
	"provider_refund_id" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"refunded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_refunds_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_order_line_items" ADD CONSTRAINT "commerce_order_line_items_order_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "public"."commerce_orders"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connector_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_customer_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_order_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "public"."commerce_orders"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_order_line_items_ws_order_item_uq" ON "commerce_order_line_items" USING btree ("workspace_id","order_id","provider_line_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_order_line_items_ws_product_idx" ON "commerce_order_line_items" USING btree ("workspace_id","provider_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_orders_ws_provider_order_uq" ON "commerce_orders" USING btree ("workspace_id","provider_namespace","provider_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_orders_ws_customer_idx" ON "commerce_orders" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_refunds_ws_provider_refund_uq" ON "commerce_refunds" USING btree ("workspace_id","provider_namespace","provider_refund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_refunds_ws_order_idx" ON "commerce_refunds" USING btree ("workspace_id","order_id");