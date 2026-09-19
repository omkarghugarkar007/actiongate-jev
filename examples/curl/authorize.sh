#!/usr/bin/env bash
set -euo pipefail

actiongate_url="${ACTIONGATE_URL:-http://localhost:8080}"
actiongate_api_key="${ACTIONGATE_API_KEY:-ag_test_local}"
request_id="curl-$(date +%s)"

curl --fail-with-body --silent --show-error \
  --request POST \
  --url "${actiongate_url}/v1/authorize" \
  --header "authorization: Bearer ${actiongate_api_key}" \
  --header "content-type: application/json" \
  --header "idempotency-key: ${request_id}" \
  --data "{
    \"requestId\": \"${request_id}\",
    \"idempotencyKey\": \"${request_id}\",
    \"tenantId\": \"demo\",
    \"environment\": \"development\",
    \"mode\": \"shadow\",
    \"actor\": { \"agentId\": \"curl-example\" },
    \"userIntent\": {
      \"text\": \"Refund the duplicate 49 dollar charge\",
      \"source\": \"user_message\"
    },
    \"proposedAction\": {
      \"tool\": \"refund_payment\",
      \"operation\": \"refund\",
      \"arguments\": { \"transactionId\": \"txn_demo\", \"amountCents\": 4900 },
      \"riskClass\": \"FINANCIAL\"
    },
    \"deterministicFacts\": {
      \"authenticated\": true,
      \"authorizedByRbac\": true,
      \"amountCents\": 4900,
      \"currency\": \"USD\"
    }
  }"

printf '\n'
