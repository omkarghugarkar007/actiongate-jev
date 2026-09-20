import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  ActionGrantConsumeRequestSchema,
  ActionGrantConsumeResponseSchema,
  AuthorizationRequestSchema,
  PolicySchema
} from "@actiongate/core";

/**
 * Generates the versioned API description from the same zod schemas the server
 * validates with, so the document cannot drift from the contract it describes.
 */
const API_VERSION = "0.1.0";

const schemas: Record<string, unknown> = {
  AuthorizationRequest: z.toJSONSchema(AuthorizationRequestSchema, { target: "draft-2020-12", io: "input" }),
  ActionGrantConsumeRequest: z.toJSONSchema(ActionGrantConsumeRequestSchema, { target: "draft-2020-12", io: "input" }),
  ActionGrantConsumeResponse: z.toJSONSchema(ActionGrantConsumeResponseSchema, { target: "draft-2020-12" }),
  Policy: z.toJSONSchema(PolicySchema, { target: "draft-2020-12", io: "input" }),
  Error: {
    type: "object",
    properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code"] } },
    required: ["error"]
  }
};

const bearer = [{ ActionGateKey: [] as string[] }];
const json = (schema: string) => ({ content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const errorResponse = (description: string) => ({ description, ...json("Error") });

interface OperationSpec {
  summary: string;
  roles: string[];
  requestBody?: string;
  responses: Record<string, { description: string; schema?: string }>;
  parameters?: { name: string; in: "path" | "query"; required?: boolean }[];
}

const operations: Record<string, Partial<Record<"get" | "post" | "put" | "delete", OperationSpec>>> = {
  "/health": { get: { summary: "Liveness probe", roles: [], responses: { "200": { description: "Service is up" } } } },
  "/ready": { get: { summary: "Readiness probe including dependencies", roles: [], responses: { "200": { description: "Ready" }, "503": { description: "A dependency is unavailable" } } } },
  "/metrics": { get: { summary: "Prometheus metrics with tenant identifiers hashed", roles: ["audit_exporter", "policy_admin"], responses: { "200": { description: "Prometheus text exposition" } } } },
  "/v1/authorize": { post: { summary: "Decide a proposed action and issue a grant for an enforced allow", roles: ["authorize"], requestBody: "AuthorizationRequest", responses: { "200": { description: "Decision, with a grant only for an enforced ALLOW" }, "400": { description: "Invalid request" }, "403": { description: "Tool disabled or metadata mismatch" }, "409": { description: "Idempotency conflict" }, "429": { description: "Tenant rate limit or provider-cost budget exhausted" } } } },
  "/v1/grants/consume": { post: { summary: "Consume a grant exactly once, immediately before the side effect", roles: ["consume"], requestBody: "ActionGrantConsumeRequest", responses: { "200": { description: "Consumed", schema: "ActionGrantConsumeResponse" }, "403": { description: "Binding mismatch or revoked" }, "409": { description: "Already consumed" }, "410": { description: "Expired" } } } },
  "/v1/grants/exchange": { post: { summary: "Consume a grant and return a short-lived downstream credential", roles: ["consume"], requestBody: "ActionGrantConsumeRequest", responses: { "200": { description: "Credential bound to the exact action" }, "501": { description: "No credential broker configured" } } } },
  "/v1/grants/{id}/revoke": { post: { summary: "Revoke one outstanding grant", roles: ["reviewer", "policy_admin"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Revoked" }, "404": { description: "Unknown grant" } } } },
  "/v1/decisions": { get: { summary: "List decisions for the authenticated tenant", roles: ["decision_reader"], responses: { "200": { description: "Decisions" } } } },
  "/v1/decisions/{id}": { get: { summary: "Read one decision audit record", roles: ["decision_reader"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Audit record" }, "404": { description: "Unknown decision" } } } },
  "/v1/decisions/{id}/override": { post: { summary: "Record a reviewer correction against a decision", roles: ["reviewer"], parameters: [{ name: "id", in: "path", required: true }], responses: { "201": { description: "Correction recorded" } } } },
  "/v1/policies": { get: { summary: "List policy versions", roles: ["policy_admin", "decision_reader"], responses: { "200": { description: "Policies" } } } },
  "/v1/policies/{id}": { get: { summary: "Read one policy version", roles: ["policy_admin", "decision_reader"], parameters: [{ name: "id", in: "path", required: true }, { name: "version", in: "query" }], responses: { "200": { description: "Policy", schema: "Policy" }, "404": { description: "Unknown policy" } } } },
  "/v1/policies/{id}/versions": { post: { summary: "Add an immutable policy version", roles: ["policy_admin"], parameters: [{ name: "id", in: "path", required: true }], requestBody: "Policy", responses: { "201": { description: "Version added" }, "409": { description: "Version already exists" } } } },
  "/v1/tools": { get: { summary: "List server-owned tool registrations", roles: ["authorize", "decision_reader", "policy_admin"], responses: { "200": { description: "Tool registry" } } } },
  "/v1/tools/{name}": { put: { summary: "Register or update a tool", roles: ["policy_admin"], parameters: [{ name: "name", in: "path", required: true }], responses: { "200": { description: "Registered" }, "409": { description: "Policy mismatch" } } } },
  "/v1/api-keys": { get: { summary: "List API keys", roles: ["key_admin"], responses: { "200": { description: "Keys, never including the secret" } } }, post: { summary: "Issue an API key, returning the secret once", roles: ["key_admin"], responses: { "201": { description: "Issued" } } } },
  "/v1/api-keys/{id}/revoke": { post: { summary: "Revoke an API key immediately", roles: ["key_admin"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Revoked" } } } },
  "/v1/reviews": { get: { summary: "List reviews", roles: ["reviewer"], parameters: [{ name: "status", in: "query" }], responses: { "200": { description: "Reviews" } } }, post: { summary: "Raise a review for a decision", roles: ["reviewer"], responses: { "201": { description: "Review created" } } } },
  "/v1/reviews/{id}/claim": { post: { summary: "Claim a pending review", roles: ["reviewer"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Claimed" }, "409": { description: "Already claimed or not pending" } } } },
  "/v1/reviews/{id}/escalate": { post: { summary: "Escalate a pending review", roles: ["reviewer"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Escalated" } } } },
  "/v1/reviews/{id}/resolve": { post: { summary: "Approve or deny; approval revalidates and mints a fresh grant", roles: ["reviewer"], parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "Resolved, with revalidation for an approval" }, "202": { description: "Approval recorded, more approvals required" }, "409": { description: "The same reviewer cannot approve twice" } } } },
  "/v1/executions": { get: { summary: "List execution outcomes", roles: ["decision_reader"], parameters: [{ name: "decisionId", in: "query" }], responses: { "200": { description: "Executions" } } }, post: { summary: "Record an execution outcome separately from authorization", roles: ["consume"], responses: { "201": { description: "Recorded" }, "404": { description: "Unknown decision" } } } },
  "/v1/incidents/disable-tools": { post: { summary: "Disable tools in bulk", roles: ["policy_admin"], responses: { "200": { description: "Disabled tool names" } } } },
  "/v1/incidents/revoke-grants": { post: { summary: "Revoke outstanding grants, optionally for one tool", roles: ["policy_admin"], responses: { "200": { description: "Revoked grant ids" }, "501": { description: "Store does not support enumeration" } } } },
  "/v1/incidents/dead-letters": { get: { summary: "List undelivered notifications", roles: ["policy_admin", "audit_exporter"], responses: { "200": { description: "Dead letters" } } } },
  "/v1/audit/export": { get: { summary: "Export tenant decisions and audit events", roles: ["audit_exporter"], responses: { "200": { description: "Export, never including grant tokens" } } } },
  "/v1/audit/retention": { delete: { summary: "Delete evidence older than a cutoff", roles: ["audit_exporter", "policy_admin"], parameters: [{ name: "before", in: "query", required: true }], responses: { "200": { description: "Deleted counts" } } } }
};

const paths: Record<string, Record<string, unknown>> = {};
for (const [path, methods] of Object.entries(operations)) {
  paths[path] = {};
  for (const [method, spec] of Object.entries(methods) as [string, OperationSpec][]) {
    paths[path]![method] = {
      summary: spec.summary,
      operationId: operationId(method, path),
      ...(spec.roles.length ? { description: `Requires role: ${spec.roles.join(" or ")}.`, security: bearer } : { security: [] }),
      ...(spec.parameters ? { parameters: spec.parameters.map((p) => ({ ...p, required: p.required ?? false, schema: { type: "string" } })) } : {}),
      ...(spec.requestBody ? { requestBody: { required: true, ...json(spec.requestBody) } } : {}),
      responses: Object.fromEntries(Object.entries(spec.responses).map(([status, response]) => [
        status,
        Number(status) >= 400
          ? errorResponse(response.description)
          : { description: response.description, ...(response.schema ? json(response.schema) : {}) }
      ]))
    };
  }
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "ActionGate API",
    version: API_VERSION,
    description: "Runtime authorization for AI-agent actions. Jev supplies evidence; ActionGate creates and enforces the permit.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" }
  },
  servers: [{ url: "http://localhost:8080", description: "Local development" }],
  security: bearer,
  components: {
    securitySchemes: { ActionGateKey: { type: "http", scheme: "bearer", description: "A tenant-scoped ActionGate API key." } },
    schemas
  },
  paths
};

await mkdir(new URL("../docs/api/", import.meta.url), { recursive: true });
await writeFile(new URL("../docs/api/openapi.json", import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, version: API_VERSION, paths: Object.keys(paths).length, schemas: Object.keys(schemas).length }, null, 2));

function operationId(method: string, path: string): string {
  const parts = path.replace(/^\//, "").split("/").filter((part) => part !== "v1");
  const name = parts.map((part) => part.startsWith("{") ? `By${capitalize(part.slice(1, -1))}` : capitalize(part)).join("");
  return `${method}${name}`;
}
function capitalize(value: string) {
  return value.replace(/[-_](\w)/g, (_, letter: string) => letter.toUpperCase()).replace(/^\w/, (letter) => letter.toUpperCase());
}
