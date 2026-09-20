CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"grant_id" uuid,
	"status" text NOT NULL,
	"payload_encrypted" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "escalated_to" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "approvals_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "required_approvals" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "executions_tenant_decision_idx" ON "executions" USING btree ("tenant_id","decision_id");