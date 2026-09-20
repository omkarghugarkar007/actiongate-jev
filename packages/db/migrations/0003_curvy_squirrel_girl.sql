ALTER TABLE "tool_registry" ADD COLUMN "policy_version" text;--> statement-breakpoint
UPDATE "tool_registry" tr
SET "policy_version" = (
	SELECT pv."version"
	FROM "policies" p
	JOIN "policy_versions" pv ON pv."policy_id" = p."id"
	WHERE p."tenant_id" = tr."tenant_id" AND p."name" = tr."policy_name"
	ORDER BY pv."created_at" DESC
	LIMIT 1
);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "tool_registry" WHERE "policy_version" IS NULL) THEN
		RAISE EXCEPTION 'tool_registry contains a policy without a persisted version';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "tool_registry" ALTER COLUMN "policy_version" SET NOT NULL;
