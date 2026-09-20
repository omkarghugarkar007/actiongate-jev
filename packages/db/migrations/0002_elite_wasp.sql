CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"object_id" text NOT NULL,
	"actor_key_id" text NOT NULL,
	"payload_encrypted" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"payload_encrypted" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"status" text NOT NULL,
	"payload_encrypted" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"operation" text NOT NULL,
	"risk_class" text NOT NULL,
	"argument_schema" jsonb NOT NULL,
	"owner" text NOT NULL,
	"data_sensitivity" text NOT NULL,
	"policy_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "api_keys_prefix_idx";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "roles" jsonb;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "api_keys" SET "name" = 'migrated-' || left("id"::text, 8), "roles" = '["authorize","consume","decision_reader","policy_admin","reviewer","key_admin","audit_exporter"]'::jsonb WHERE "name" IS NULL OR "roles" IS NULL;--> statement-breakpoint
UPDATE "tenants" SET "slug" = "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "roles" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_corrections" ADD CONSTRAINT "decision_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_registry" ADD CONSTRAINT "tool_registry_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_tenant_type_object_unique" ON "audit_events" USING btree ("tenant_id","event_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_corrections_tenant_created_idx" ON "decision_corrections" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_tenant_status_idx" ON "reviews" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_registry_tenant_name_unique" ON "tool_registry" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_unique" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_tenant_name_unique" ON "policies" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug");
