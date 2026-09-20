# actiongate (Python)

Python client for [ActionGate](https://github.com/omkarghugarkar007/actiongate-jev).
Authorize an action, consume a single-use grant, then call a private handler.

> **Guard level.** It protects the wrapper, not the callee. Keep the handler
> private to the module that wraps it, or another caller reaches it without a grant.

Standard library only — adding it pulls in no dependency tree.

`ActionGate.embedded()` runs the whole decision path in your process. Swap it for
`ActionGate(api_key=..., base_url=...)` to use a server; the guarantees and the
`wrap_tool` code are identical. Embedded keeps grants in memory, so they do not
survive a restart or coordinate across replicas, and the policy sits in the
agent's own process.

Set `TYPESAFE_API_KEY` to use Jev through TypeSafe's direct System One API, or
`OPENROUTER_API_KEY` to use OpenRouter. When both are present, embedded mode
prefers the direct TypeSafe route. With neither key it keeps the zero-config
deterministic fake provider.

```python
from actiongate import ActionGate, Actor, UserIntent

gate = ActionGate.embedded()      # no server, no API key, no base URL

def _refund(arguments, runtime):          # keep private
    return payments.refund(arguments["transactionId"], arguments["amountCents"])

guarded_refund = gate.wrap_tool(
    name="refund_payment",
    operation="refund",
    risk_class="FINANCIAL",
    execute=_refund,
    build_request=lambda arguments, runtime: {
        "tenant_id": "acme",
        "environment": "production",
        "mode": "enforce",
        "actor": Actor(agent_id="support-agent", user_id=runtime["user_id"]),
        "user_intent": UserIntent(text=runtime["user_message"]),
    },
)

guarded_refund({"transactionId": "txn_8923", "amountCents": 4900}, {"user_id": "u_1", "user_message": "Refund my duplicate charge."})
```

`ActionBlockedError`, `ActionGrantMissingError`, and `ActionGateApiError` all mean
the handler was **not** called.

Facts for hard rules such as RBAC belong to a server-side fact provider on the
API, not to this call: a client cannot make its own facts trusted.

## Status

Early public release. Not production-ready: no external security review yet.

## License

Apache-2.0
