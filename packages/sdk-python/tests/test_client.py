"""Tests for the ActionGate Python client.

The handler must never run unless a grant was issued and consumed, so most of
these assert that it was *not* called.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from actiongate import (  # noqa: E402
    ActionBlockedError,
    ActionGate,
    ActionGateApiError,
    ActionGrantMissingError,
    Actor,
    UserIntent,
)

GRANT_TOKEN = "grant-token-that-must-never-leak"


class FakeTransport:
    """Records every call and replies from a scripted queue."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": json.loads(body) if body else None,
            }
        )
        status, payload = self.responses.pop(0)
        return status, json.dumps(payload).encode("utf-8")


def allow_payload(with_grant=True):
    payload = {
        "decisionId": "11111111-1111-4111-8111-111111111111",
        "decision": "ALLOW",
        "mode": "enforce",
        "riskClass": "FINANCIAL",
        "reasons": [{"code": "POLICY_SATISFIED", "message": "ok", "source": "SYSTEM"}],
    }
    if with_grant:
        payload["grant"] = {
            "token": GRANT_TOKEN,
            "grantId": "22222222-2222-4222-8222-222222222222",
            "expiresAt": "2099-01-01T00:00:00.000Z",
        }
    return payload


def consumed_payload():
    return {
        "grantId": "22222222-2222-4222-8222-222222222222",
        "decisionId": "11111111-1111-4111-8111-111111111111",
        "status": "CONSUMED",
        "consumedAt": "2026-09-20T12:00:00.000Z",
    }


def build_gate(responses):
    transport = FakeTransport(responses)
    gate = ActionGate(api_key="agk_test", base_url="https://gate.example/", transport=transport)
    return gate, transport


def guarded(gate, calls, risk_class="FINANCIAL", mode="enforce"):
    def execute(arguments, runtime):
        calls.append(arguments)
        return {"refunded": True}

    return gate.wrap_tool(
        name="refund_payment",
        operation="refund",
        risk_class=risk_class,
        execute=execute,
        build_request=lambda arguments, runtime: {
            "tenant_id": "acme",
            "environment": "production",
            "mode": mode,
            "actor": Actor(agent_id="support-agent", user_id="u_1"),
            "user_intent": UserIntent(text="Refund my duplicate charge."),
        },
    )


def test_authorizes_consumes_then_executes_in_that_order():
    gate, transport = build_gate([(200, allow_payload()), (200, consumed_payload())])
    calls = []
    result = guarded(gate, calls)({"transactionId": "txn_1", "amountCents": 4900})

    assert result == {"refunded": True}
    assert [call["url"] for call in transport.calls] == [
        "https://gate.example/v1/authorize",
        "https://gate.example/v1/grants/consume",
    ]
    assert calls == [{"transactionId": "txn_1", "amountCents": 4900}]


def test_sends_bearer_key_and_idempotency_header():
    gate, transport = build_gate([(200, allow_payload()), (200, consumed_payload())])
    guarded(gate, [])({"transactionId": "txn_1", "amountCents": 4900})
    headers = transport.calls[0]["headers"]
    assert headers["Authorization"] == "Bearer agk_test"
    assert headers["Idempotency-Key"]
    assert headers["Idempotency-Key"] == transport.calls[0]["body"]["idempotencyKey"]


def test_authorizes_the_exact_arguments_it_executes():
    gate, transport = build_gate([(200, allow_payload()), (200, consumed_payload())])
    calls = []
    arguments = {"transactionId": "txn_1", "amountCents": 4900}
    guarded(gate, calls)(arguments)

    authorized = transport.calls[0]["body"]["proposedAction"]
    consumed = transport.calls[1]["body"]["proposedAction"]
    assert authorized["arguments"] == arguments == calls[0]
    assert authorized == consumed


def test_caller_cannot_substitute_tool_operation_or_risk():
    gate, transport = build_gate([(200, allow_payload()), (200, consumed_payload())])
    # A softer classification smuggled into the arguments is just an argument.
    guarded(gate, [])({"amountCents": 1, "riskClass": "READ_ONLY", "tool": "get_order"})
    proposed = transport.calls[0]["body"]["proposedAction"]
    assert proposed["tool"] == "refund_payment"
    assert proposed["riskClass"] == "FINANCIAL"
    assert proposed["operation"] == "refund"


@pytest.mark.parametrize("decision", ["BLOCK", "REVIEW"])
def test_does_not_execute_on_block_or_review(decision):
    payload = allow_payload(with_grant=False)
    payload["decision"] = decision
    payload["reasons"] = [{"code": "RBAC_DENIED", "message": "no", "source": "DETERMINISTIC"}]
    gate, transport = build_gate([(200, payload)])
    calls = []

    with pytest.raises(ActionBlockedError) as raised:
        guarded(gate, calls)({"transactionId": "txn_1", "amountCents": 4900})

    assert raised.value.decision == decision
    assert raised.value.reasons[0]["code"] == "RBAC_DENIED"
    assert calls == []
    assert len(transport.calls) == 1  # never reached consume


def test_does_not_execute_when_an_enforced_allow_has_no_grant():
    gate, transport = build_gate([(200, allow_payload(with_grant=False))])
    calls = []
    with pytest.raises(ActionGrantMissingError):
        guarded(gate, calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == []
    assert len(transport.calls) == 1


def test_does_not_execute_when_consumption_fails():
    gate, transport = build_gate(
        [(200, allow_payload()), (409, {"error": {"code": "GRANT_ALREADY_CONSUMED", "message": "spent"}})]
    )
    calls = []
    with pytest.raises(ActionGateApiError) as raised:
        guarded(gate, calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert raised.value.code == "GRANT_ALREADY_CONSUMED"
    assert calls == []
    assert len(transport.calls) == 2  # consume was attempted, handler was not


def test_does_not_execute_when_the_api_is_unreachable():
    gate, _ = build_gate([(503, {"error": {"code": "ACTIONGATE_UNAVAILABLE", "message": "down"}})])
    calls = []
    with pytest.raises(ActionGateApiError):
        guarded(gate, calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == []


def test_shadow_mode_executes_without_consuming_a_grant():
    gate, transport = build_gate([(200, {**allow_payload(with_grant=False), "mode": "shadow"})])
    calls = []
    guarded(gate, calls, mode="shadow")({"transactionId": "txn_1", "amountCents": 4900})
    # Shadow mode observes; there is no permit to spend.
    assert calls != []
    assert len(transport.calls) == 1


def test_never_returns_the_grant_token_to_the_caller():
    gate, _ = build_gate([(200, allow_payload()), (200, consumed_payload())])
    result = guarded(gate, [])({"transactionId": "txn_1", "amountCents": 4900})
    assert GRANT_TOKEN not in json.dumps(result)


def test_records_an_execution_outcome_separately():
    gate, transport = build_gate([(201, {"id": "exec-1", "status": "COMPLETED"})])
    gate.record_execution(decision_id="11111111-1111-4111-8111-111111111111", status="COMPLETED", external_ref="refund_8842")
    assert transport.calls[0]["url"].endswith("/v1/executions")
    assert transport.calls[0]["body"]["externalRef"] == "refund_8842"


def test_omits_optional_fields_rather_than_sending_nulls():
    gate, transport = build_gate([(200, allow_payload()), (200, consumed_payload())])
    guarded(gate, [])({"transactionId": "txn_1"})
    body = transport.calls[0]["body"]
    assert "deterministicFacts" not in body
    assert "context" not in body
    assert "sessionId" not in body["actor"]
