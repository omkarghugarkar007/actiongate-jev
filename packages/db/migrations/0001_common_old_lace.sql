CREATE TABLE "action_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"decision_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"action_fingerprint" text NOT NULL,
	"claims_json" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_grants" ADD CONSTRAINT "action_grants_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_grants" ADD CONSTRAINT "action_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_grants_decision_unique" ON "action_grants" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_grants_token_hash_unique" ON "action_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "action_grants_tenant_expires_idx" ON "action_grants" USING btree ("tenant_id","expires_at");