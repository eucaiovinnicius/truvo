DO $$ BEGIN
 ALTER TABLE "radar_definition_versions" ADD CONSTRAINT "radar_definition_versions_radar_fk" FOREIGN KEY ("workspace_id","radar_id") REFERENCES "public"."radars"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "radar_training_requests" ADD CONSTRAINT "radar_training_requests_definition_fk" FOREIGN KEY ("workspace_id","radar_id","definition_version") REFERENCES "public"."radar_definition_versions"("workspace_id","radar_id","version") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
