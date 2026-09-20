"""Zero infrastructure in Python: no server, no API key, no base URL.

Three cases, chosen so the demo is honest whether or not you have a model key:
one that should run, one refused by deterministic policy alone, and one that can
only be judged by meaning.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))

from actiongate import ActionBlockedError, ActionGate, Actor, UserIntent  # noqa: E402

DIRECT = bool(os.environ.get("TYPESAFE_API_KEY"))
LIVE = DIRECT or bool(os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY"))

# Both named transactions exist, so the semantic case is refused on meaning
# rather than on a missing record.
payments = {
    "txn_5512": {"amountCents": 4900, "refunded": False},
    "txn_9981": {"amountCents": 4900, "refunded": False},
    # Genuinely above the policy's $100 limit, so the rules refuse it whatever
    # the model thinks.
    "txn_bulk": {"amountCents": 490_000, "refunded": False},
}


def ledger_facts(request, _tool):
    """Facts come from local state the agent does not control."""
    arguments = request["proposedAction"]["arguments"]
    payment = payments.get(arguments.get("transactionId"))
    return {
        "authenticated": True,
        "authorizedByRbac": True,
        "duplicate": bool(payment and payment["refunded"]),
        # The ledger's amount, not the caller's: an agent must not be able to
        # understate an amount to slip under a policy limit.
        "amountCents": payment["amountCents"] if payment else int(arguments.get("amountCents") or 0),
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

SAID = "Refund the duplicate $49 charge on txn_5512."
CASES = [
    ("what the user asked for", {"transactionId": "txn_5512", "amountCents": 4900}, "either"),
    ("above the policy limit", {"transactionId": "txn_bulk", "amountCents": 490_000}, "rules"),
    ("a transaction never named", {"transactionId": "txn_9981", "amountCents": 4900}, "meaning"),
]

print(f"\nProvider: {'TypeSafe (direct live Jev)' if DIRECT else 'OpenRouter (live Jev)' if LIVE else 'deterministic fake — no provider key set'}\n")

for label, arguments, judged in CASES:
    # The fake provider cannot judge meaning, so say so rather than letting the
    # result imply the guard does not work.
    if not LIVE and judged == "meaning":
        print(f"  skipped   {label} — needs a model; the fake provider answers every semantic question the same way")
        continue
    said = "Refund the $4,900 charge on txn_bulk." if arguments["transactionId"] == "txn_bulk" else SAID
    try:
        result = refund(arguments, {"said": said})
        print(f"  EXECUTED  {label} -> {result}")
    except ActionBlockedError as error:
        codes = ", ".join(reason["code"] for reason in error.reasons)
        print(f"  refused   {label} -> {error.decision} {codes}")

print("\nNo server, no API key, no base URL. Nothing left running.")
if not LIVE:
    print(
        "\nSet TYPESAFE_API_KEY (direct) or OPENROUTER_API_KEY to judge the third case. Deterministic rules work\n"
        "without a model, but only a decision model can tell that a refund for a\n"
        "transaction the user never named is the wrong action.\n"
    )
else:
    print("")
