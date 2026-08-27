CREATE TABLE IF NOT EXISTS "action_execution_attempts" (
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"remote_id" text,
	"failure_category" text,
	"provider_operation_key" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_execution_attempts_workspace_id_execution_id_attempt_pk" PRIMARY KEY("workspace_id","execution_id","attempt"),
	CONSTRAINT "action_execution_attempts_execution_fk" FOREIGN KEY("workspace_id","execution_id") REFERENCES "action_executions"("workspace_id","id") ON DELETE restrict,
	CONSTRAINT "action_execution_attempts_attempt_check" CHECK("attempt">0),
	CONSTRAINT "action_execution_attempts_status_check" CHECK("status" IN ('queued','attempting','succeeded','partially_succeeded','failed','unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_reward_reconciliation_checkpoints" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"last_decision_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_executions" ADD COLUMN "provider_operation_key" text;--> statement-breakpoint
UPDATE "action_executions" SET "provider_operation_key"="idempotency_key" WHERE "provider_operation_key" IS NULL;--> statement-breakpoint
ALTER TABLE "action_executions" ALTER COLUMN "provider_operation_key" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_execution_attempts_operation_idx" ON "action_execution_attempts" USING btree ("workspace_id","provider_operation_key","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_executions_status_idx" ON "action_executions" USING btree ("workspace_id","status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exposure_observations_decision_idx" ON "exposure_observations" USING btree ("workspace_id","decision_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reward_observations_finality_idx" ON "reward_observations" USING btree ("workspace_id","final","decision_id","version");
