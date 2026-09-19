import http from "k6/http";
import { check } from "k6";
import { randomString } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
export const options = { scenarios: { mocked_provider: { executor: "constant-vus", vus: 50, duration: "5m" } }, thresholds: { http_req_failed: ["rate<0.005"], http_req_duration: ["p(95)<800"] } };
export default function () {
  const id = randomString(16);
  const body = JSON.stringify({ requestId: id, idempotencyKey: `k6-${id}`, tenantId: "tenant-1", environment: "development", mode: "shadow", actor: { agentId: "k6" }, userIntent: { text: "Read order 123", source: "operator" }, proposedAction: { tool: "get_order", operation: "read", arguments: { orderId: "123" }, riskClass: "READ_ONLY" } });
  const res = http.post(`${__ENV.API_URL || "http://localhost:8080"}/v1/authorize`, body, { headers: { Authorization: `Bearer ${__ENV.ACTIONGATE_API_KEY || "ag_test_local"}`, "Content-Type": "application/json" } });
  check(res, { authorized: (r) => r.status === 200 });
}

