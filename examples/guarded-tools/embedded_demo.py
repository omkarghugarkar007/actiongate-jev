"""Zero infrastructure in Python: no server, no API key, no base URL.

Just an OPENROUTER_API_KEY and this file.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))

from actiongate import ActionBlockedError, ActionGate, Actor, UserIntent  # noqa: E402

# Both transactions exist, so the second case is refused on meaning rather than
# on a missing record — which is the point ActionGate is making.
payments = {
    "txn_5512": {"amountCents": 4900, "refunded": False},
    "txn_9981": {"amountCents": 4900, "refunded": False},
}


def ledger_facts(request, _tool):
    """Facts come from local state the agent does not control."""
    transaction_id = request["proposedAction"]["arguments"].get("transactionId")
    payment = payments.get(transaction_id)
    return {
        "authenticated": True,
        "authorizedByRbac": True,
        "duplicate": bool(payment and payment["refunded"]),
        "amountCents": payment["amountCents"] if payment else 0,
        "currency": "USD",
        "resourceExists": payment is not None,
    }


gate = ActionGate.embedded(fact_providers=[("local-ledger", ledger_facts)])


def _refund(arguments, runtime):
    payments[arguments["transactionId"]]["refunded"] = True
    return {"transactionId": arguments["transactionId"], "refunded": True}


refund = gate.wrap_tool(
    name="refund_payment",
    operation="refund",
    risk_class="FINANCIAL",
    execute=_refund,
    build_request=lambda arguments, runtime: {
        "tenant_id": "local",
        "environment": "development",
        "mode": "enforce",
        "actor": Actor(agent_id="embedded-agent"),
        "user_intent": UserIntent(text=runtime["said"]),
    },
)

said = "Refund the duplicate $49 charge on txn_5512."
print(f"\nProvider: {'OpenRouter (live Jev)' if os.environ.get('OPENROUTER_API_KEY') or os.environ.get('OPENROUTER_KEY') else 'fake (deterministic)'}\n")

for label, arguments in [
    ("what the user asked for", {"transactionId": "txn_5512", "amountCents": 4900}),
    ("a transaction never named", {"transactionId": "txn_9981", "amountCents": 4900}),
]:
    try:
        result = refund(arguments, {"said": said})
        print(f"  EXECUTED  {label} -> {result}")
    except ActionBlockedError as error:
        codes = ", ".join(reason["code"] for reason in error.reasons)
        print(f"  refused   {label} -> {error.decision} {codes}")

print("\nNo server, no API key, no base URL. Nothing left running.\n")
