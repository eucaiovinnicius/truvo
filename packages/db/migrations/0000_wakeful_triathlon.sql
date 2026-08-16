DO $$ BEGIN
 CREATE TYPE "public"."workspace_member_status" AS ENUM('active', 'invited');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member', 'viewer');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_status" AS ENUM('pending', 'active', 'inactive', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_type" AS ENUM('shopify', 'stripe', 'hotmart', 'kiwify', 'hubspot');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."webhook_log_status" AS ENUM('received', 'verified', 'processed', 'failed', 'rejected', 'retrying');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."identity_identifier_type" AS ENUM('click_id', 'anonymous_id', 'user_id', 'email_hash', 'phone_hash', 'order_id');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."funnel_status" AS ENUM('active', 'archived', 'draft');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."explorer_catalog_entry" AS ENUM('dimension', 'measure', 'property');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."insight_kind" AS ENUM('visual', 'sql');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."profile_access_action" AS ENUM('search', 'view_profile', 'view_timeline', 'view_identities', 'view_journey', 'export');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."profile_status" AS ENUM('anonymous', 'identified');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_out_log_status" AS ENUM('sent', 'failed', 'skipped_no_consent', 'skipped_no_match_keys', 'skipped_unmapped', 'skipped_duplicate', 'skipped_disabled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_out_platform" AS ENUM('meta_capi', 'google_enhanced', 'tiktok_events', 'hubspot');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."integration_out_status" AS ENUM('pending', 'active', 'inactive', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."creative_account_status" AS ENUM('active', 'inactive', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."creative_alert_status" AS ENUM('open', 'notified', 'resolved');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."creative_alert_type" AS ENUM('fatigue', 'discrepancy', 'top_performer', 'spend_no_conversion');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."creative_platform" AS ENUM('meta', 'google', 'tiktok');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" DEFAULT 'member' NOT NULL,
	"status" "workspace_member_status" DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(63) NOT NULL,
	"logo_url" text,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"currency" varchar(3) DEFAULT 'BRL' NOT NULL,
	"data_retention_days" integer DEFAULT 730 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracking_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"code" text NOT NULL,
	"destination_url" text NOT NULL,
	"label" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"click_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" "integration_type" NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"credentials_encrypted" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"integration_id" text,
	"provider" "integration_type" NOT NULL,
	"event_type" text,
	"status" "webhook_log_status" NOT NULL,
	"signature_valid" boolean,
	"http_status" integer,
	"payload_summary" jsonb,
	"retry_payload" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"identifier" text NOT NULL,
	"identifier_type" "identity_identifier_type" NOT NULL,
	"canonical_id" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"canonical_id" text NOT NULL,
	"merged_from" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_quality_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"reconciliation_gap_threshold" double precision DEFAULT 0.02 NOT NULL,
	"bot_filter_enabled" boolean DEFAULT true NOT NULL,
	"alerts_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"day" date NOT NULL,
	"gap" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"truvo_revenue" double precision DEFAULT 0 NOT NULL,
	"gateway_revenue" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funnels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "funnel_status" DEFAULT 'active' NOT NULL,
	"attribution_window_days" integer DEFAULT 7 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alert" jsonb DEFAULT '{"enabled":false,"min_overall_conversion_rate":0}'::jsonb NOT NULL,
	"sparkline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"layout" jsonb DEFAULT '{"widgets":[]}'::jsonb NOT NULL,
	"public_token" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kpi_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"formula" jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segment_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attribution_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"default_model" text DEFAULT 'last_click' NOT NULL,
	"default_window_days" integer DEFAULT 7 NOT NULL,
	"time_decay_half_life_days" real DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "explorer_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entry_type" "explorer_catalog_entry" NOT NULL,
	"key" text NOT NULL,
	"label" text,
	"data_type" text DEFAULT 'string' NOT NULL,
	"source" text DEFAULT 'events' NOT NULL,
	"is_pii" boolean DEFAULT false NOT NULL,
	"definition" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"insight_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"token" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"insight_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" "insight_kind" NOT NULL,
	"insight_type" text NOT NULL,
	"spec" jsonb,
	"sql_text" text,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insights" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" "insight_kind" DEFAULT 'visual' NOT NULL,
	"insight_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec" jsonb,
	"sql_text" text,
	"owner_id" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"canonical_id" text DEFAULT '' NOT NULL,
	"accessed_by" text NOT NULL,
	"accessed_by_email" text,
	"action" "profile_access_action" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_profiles" (
	"workspace_id" text NOT NULL,
	"canonical_id" text NOT NULL,
	"status" "profile_status" DEFAULT 'anonymous' NOT NULL,
	"email_hash" text,
	"phone_hash" text,
	"first_touch" jsonb,
	"last_touch" jsonb,
	"metrics" jsonb,
	"merged_anonymous_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"devices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"recomputed_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_workspace_id_canonical_id_pk" PRIMARY KEY("workspace_id","canonical_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_out_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" "integration_out_platform" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_required" boolean DEFAULT true NOT NULL,
	"status" "integration_out_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_forward_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_out_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" "integration_out_platform" NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text,
	"platform_event" text,
	"status" "integration_out_log_status" NOT NULL,
	"http_status" integer,
	"match_quality" real,
	"match_keys_count" integer DEFAULT 0 NOT NULL,
	"match_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" double precision,
	"currency" text,
	"error" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_ad_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" "creative_platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "creative_account_status" DEFAULT 'active' NOT NULL,
	"sync_cursor" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_alert_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" "creative_platform" NOT NULL,
	"ad_id" text NOT NULL,
	"type" "creative_alert_type" NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"status" "creative_alert_status" DEFAULT 'open' NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creatives" (
	"workspace_id" text NOT NULL,
	"platform" "creative_platform" NOT NULL,
	"ad_id" text NOT NULL,
	"ad_name" text DEFAULT '' NOT NULL,
	"campaign_id" text DEFAULT '' NOT NULL,
	"campaign_name" text DEFAULT '' NOT NULL,
	"adset_id" text DEFAULT '' NOT NULL,
	"adset_name" text DEFAULT '' NOT NULL,
	"creative_type" text DEFAULT 'unknown' NOT NULL,
	"phase" text DEFAULT 'unknown' NOT NULL,
	"thumbnail_url" text DEFAULT '' NOT NULL,
	"preview_url" text DEFAULT '' NOT NULL,
	"ad_status" text DEFAULT '' NOT NULL,
	"landing_url" text DEFAULT '' NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creatives_workspace_id_platform_ad_id_pk" PRIMARY KEY("workspace_id","platform","ad_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"category" text DEFAULT 'system' NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_window_minutes" integer DEFAULT 60 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_channels" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"slack_enabled" boolean DEFAULT false NOT NULL,
	"slack_webhook_url" text,
	"slack_channel" text,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"email_from" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"alert_type" text DEFAULT '*' NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"slack_enabled" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"category" text DEFAULT 'system' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link" text,
	"dedup_key" text NOT NULL,
	"group_count" integer DEFAULT 1 NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"stripe_usage_item_id" text,
	"events_limit" bigint,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period_month" text NOT NULL,
	"events_used" bigint DEFAULT 0 NOT NULL,
	"events_included" bigint,
	"overage" bigint DEFAULT 0 NOT NULL,
	"reported_to_stripe" boolean DEFAULT false NOT NULL,
	"stripe_usage_record_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"report_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"format" text DEFAULT 'web' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"period" text,
	"report_name" text,
	"snapshot" jsonb,
	"branding" jsonb,
	"deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public_token" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"template" text DEFAULT 'custom' NOT NULL,
	"period" text DEFAULT 'last_30_days' NOT NULL,
	"frequency" text DEFAULT 'manual' NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"public_token" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"metric" text,
	"channel" text,
	"evidence_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_journey_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"objective_id" text,
	"goal" text NOT NULL,
	"window_days" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"segment" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"llm_model" text,
	"llm_available" boolean DEFAULT false NOT NULL,
	"reconciliation_gap" real,
	"uncertain" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"narrative" text,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_objectives" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL,
	"segment" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_recommendations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"goal" text,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"action" text,
	"expected_impact" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"channel" text,
	"evidence_ref" jsonb,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_ws_user_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_workspace_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_unique" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tracking_links_code_unique" ON "tracking_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracking_links_workspace_idx" ON "tracking_links" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_workspace_idx" ON "integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_type_external_idx" ON "integrations" USING btree ("type","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_logs_workspace_idx" ON "webhook_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_logs_integration_idx" ON "webhook_logs" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_logs_retry_idx" ON "webhook_logs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_ws_identifier_uq" ON "identity_links" USING btree ("workspace_id","identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_ws_canonical_idx" ON "identity_links" USING btree ("workspace_id","canonical_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_merges_ws_canonical_idx" ON "identity_merges" USING btree ("workspace_id","canonical_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_merges_ws_at_idx" ON "identity_merges" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_alerts_workspace_idx" ON "reconciliation_alerts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_alerts_workspace_day_uq" ON "reconciliation_alerts" USING btree ("workspace_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_alerts_status_idx" ON "reconciliation_alerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funnels_workspace_idx" ON "funnels" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funnels_status_idx" ON "funnels" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboards_workspace_idx" ON "dashboards" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dashboards_public_token_uq" ON "dashboards" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kpi_definitions_workspace_idx" ON "kpi_definitions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "explorer_catalog_key_uq" ON "explorer_catalog" USING btree ("workspace_id","entry_type","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "explorer_catalog_workspace_idx" ON "explorer_catalog" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "insight_shares_token_uq" ON "insight_shares" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_shares_insight_idx" ON "insight_shares" USING btree ("insight_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_shares_workspace_idx" ON "insight_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "insight_versions_insight_version_uq" ON "insight_versions" USING btree ("insight_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_versions_workspace_idx" ON "insight_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insights_workspace_idx" ON "insights" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_access_log_ws_canonical_at_idx" ON "profile_access_log" USING btree ("workspace_id","canonical_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_access_log_ws_actor_at_idx" ON "profile_access_log" USING btree ("workspace_id","accessed_by","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_profiles_ws_email_idx" ON "user_profiles" USING btree ("workspace_id","email_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_profiles_ws_phone_idx" ON "user_profiles" USING btree ("workspace_id","phone_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_profiles_ws_last_seen_idx" ON "user_profiles" USING btree ("workspace_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_out_configs_ws_platform_uq" ON "integration_out_configs" USING btree ("workspace_id","platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_out_configs_workspace_idx" ON "integration_out_configs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_out_logs_dedup_idx" ON "integration_out_logs" USING btree ("workspace_id","platform","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_out_logs_monitor_idx" ON "integration_out_logs" USING btree ("workspace_id","platform","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_ad_accounts_workspace_idx" ON "creative_ad_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_ad_accounts_unique_idx" ON "creative_ad_accounts" USING btree ("workspace_id","platform","external_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_alert_log_workspace_idx" ON "creative_alert_log" USING btree ("workspace_id","triggered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_alert_log_dedup_idx" ON "creative_alert_log" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creatives_workspace_campaign_idx" ON "creatives" USING btree ("workspace_id","campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_workspace_idx" ON "alert_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_workspace_type_idx" ON "alert_rules" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_uq" ON "notification_preferences" USING btree ("workspace_id","user_id","alert_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx" ON "notification_preferences" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_recipient_idx" ON "notifications" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unread_idx" ON "notifications" USING btree ("workspace_id","user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedup_uq" ON "notifications" USING btree ("workspace_id","user_id","dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_uq" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_workspace_idx" ON "usage_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_workspace_month_uq" ON "usage_records" USING btree ("workspace_id","period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_runs_report_idx" ON "report_runs" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_runs_workspace_idx" ON "report_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_runs_public_token_uq" ON "report_runs" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_workspace_idx" ON "reports" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_due_idx" ON "reports" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_public_token_uq" ON "reports" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_conversations_workspace_idx" ON "ai_conversations" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_insights_workspace_idx" ON "ai_insights" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_journey_runs_workspace_idx" ON "ai_journey_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_objectives_workspace_idx" ON "ai_objectives" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_recommendations_workspace_idx" ON "ai_recommendations" USING btree ("workspace_id","run_id");