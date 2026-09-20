import { z } from "zod";

/**
 * Every connector declares itself the same way, so the catalog stays
 * machine-readable and an adopter can see the boundary before installing.
 *
 * The rules encoded here are the ones that are easy to get wrong by omission:
 * `bypass` may not be empty, an `isolate` connector must say what it owns, and a
 * connector that needs configuration at Tier 0 must ship a preset instead.
 */
export const IntegrationLevelSchema = z.enum(["observe", "guard", "isolate", "govern"]);
export type IntegrationLevel = z.infer<typeof IntegrationLevelSchema>;

export const ConnectorToolSchema = z.object({
  name: z.string().min(1).max(128),
  operation: z.string().min(1).max(128)
}).strict();

export const ConnectorFactSchema = z.object({
  fact: z.enum(["authenticated", "authorizedByRbac", "duplicate", "amountCents", "currency", "destinationAllowlisted", "resourceExists"]),
  /** Where the value comes from. `caller` means the connector cannot make it trusted. */
  origin: z.enum(["caller", "trusted-provider"]),
  source: z.string().min(1).max(200)
}).strict();

export const ConnectorManifestSchema = z.object({
  name: z.string().regex(/^@?[a-z0-9][a-z0-9/._-]{1,100}$/, "Use a lowercase package-style identifier"),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "Use semantic versioning"),
  level: IntegrationLevelSchema,
  summary: z.string().min(10).max(300),
  /** The handler, endpoint, or credential kept behind the boundary. */
  protects: z.string().min(10).max(500),
  /**
   * Remaining unguarded paths, stated plainly. Never empty: "none known" is a
   * claim that must be backed by the connector's negative tests.
   */
  bypass: z.array(z.string().min(10).max(500)).min(1),
  requires: z.object({
    providerKey: z.boolean(),
    redis: z.boolean(),
    postgres: z.boolean(),
    /** The lowest adoption tier at which this connector does something useful. */
    minimumTier: z.number().int().min(0).max(3)
  }).strict(),
  tools: z.array(ConnectorToolSchema).max(200),
  facts: z.array(ConnectorFactSchema).max(50),
  setup: z.object({
    /** Steps an adopter performs, counted honestly. */
    steps: z.number().int().min(0).max(20),
    /** New settings required at the minimum tier. More than three needs a preset. */
    requiredSettings: z.number().int().min(0).max(50),
    presetName: z.string().min(1).max(100).optional()
  }).strict(),
  /** Tests backing the claims above. */
  negativeTests: z.array(z.string().min(5).max(300)).min(1)
}).strict();

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export interface ManifestIssue {
  path: string;
  message: string;
}

/**
 * Schema validation plus the cross-field rules the friction budget depends on.
 * Returns every issue at once so a contributor fixes them in one pass.
 */
export function validateConnectorManifest(value: unknown): { valid: true; manifest: ConnectorManifest } | { valid: false; issues: ManifestIssue[] } {
  const parsed = ConnectorManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })) };
  }
  const manifest = parsed.data;
  const issues: ManifestIssue[] = [];

  // Word boundaries matter here: without them "important" matches "port".
  if (manifest.level === "isolate" && !/\b(credentials?|network|endpoints?|sockets?|ports?)\b/i.test(manifest.protects)) {
    issues.push({ path: "protects", message: "An isolate connector must say which network path or credential it owns" });
  }
  if (manifest.level === "guard" && manifest.tools.length === 0) {
    issues.push({ path: "tools", message: "A guard connector must declare the tools it guards" });
  }
  if (manifest.requires.minimumTier === 0 && manifest.setup.requiredSettings > 0) {
    issues.push({ path: "setup.requiredSettings", message: "A Tier 0 connector must work with no required settings" });
  }
  if (manifest.setup.requiredSettings > 3 && !manifest.setup.presetName) {
    issues.push({ path: "setup.presetName", message: "More than three required settings needs a preset instead of more knobs" });
  }
  if (manifest.requires.minimumTier === 0 && (manifest.requires.providerKey || manifest.requires.redis || manifest.requires.postgres)) {
    issues.push({ path: "requires.minimumTier", message: "Tier 0 means no provider key, no Redis, and no PostgreSQL" });
  }
  // A connector cannot make its own facts trusted: it is a client of the API.
  for (const [index, fact] of manifest.facts.entries()) {
    if (fact.origin === "trusted-provider" && manifest.level !== "govern") {
      issues.push({ path: `facts.${index}.origin`, message: "Only a govern connector resolves trusted facts; adapter-supplied facts are caller provenance" });
    }
  }
  return issues.length ? { valid: false, issues } : { valid: true, manifest };
}
