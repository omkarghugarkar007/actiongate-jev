# Reference deployment: the guarded path is the only path

This topology exists to make one claim testable: **an agent cannot reach the side
effect except through authorization and grant consumption.**

```
        ┌──────────── edge ────────────┐        ┌─────────── internal ────────────┐
                                                 (docker internal: no host route)
  agent ──► http-proxy :8090  ────────────────►  actiongate ──► postgres, redis
                    │                                  ▲
                    └──────────────────────────────►  upstream-tool :9000
```

- `internal` is declared `internal: true`, so Docker gives it no route out and
  nothing on it can publish a port.
- `actiongate`, `postgres`, `redis`, and `upstream-tool` live only on `internal`.
  None of them publish a port.
- `http-proxy` is the only service on both networks and the only published port.
- The upstream credential (`UPSTREAM_TOKEN`) is given to `upstream-tool` and to
  `http-proxy`, and to nothing else. The agent never holds it.

An agent on `edge` cannot resolve `upstream-tool`, cannot reach `actiongate`
directly to mint itself a grant, and cannot reach the database. The proxy
authorizes the exact action and consumes the grant before forwarding.

## Run it

```bash
export UPSTREAM_TOKEN=$(openssl rand -base64 32)
export ACTIONGATE_PROXY_TOKEN=$(openssl rand -base64 32)
export ACTIONGATE_GRANT_KEYS="{\"grant_1\":\"$(openssl rand -base64 32)\"}"
export ACTIONGATE_GRANT_ACTIVE_KID=grant_1
export ACTIONGATE_EVIDENCE_KEYS="{\"evidence_1\":\"$(openssl rand -base64 32)\"}"
export ACTIONGATE_EVIDENCE_ACTIVE_KID=evidence_1

docker compose -f infra/reference/docker-compose.yml up --build -d postgres redis migrate seed
# The seed prints a bootstrap API key once. Export it, then start the rest.
export ACTIONGATE_API_KEY=agk_...
docker compose -f infra/reference/docker-compose.yml up -d
```

Then call the guarded route, not the tool:

```bash
curl -s -X POST http://localhost:8090/refunds \
  -H "Authorization: Bearer $ACTIONGATE_PROXY_TOKEN" \
  -H "X-ActionGate-Intent: Refund my duplicate \$49 charge." \
  -H 'Content-Type: application/json' \
  -d '{"transactionId":"txn_1","amountCents":4900}'
```

`refund_payment` carries hard rules, so without a configured fact provider this
returns `403 ACTION_DENIED` with `RBAC_FACT_MISSING`. That is the system working:
see [trusted facts](../../docs/integrations.md#trusted-facts) for how to resolve
those facts server-side rather than letting the caller assert them.

## What this does not protect against

State it plainly rather than implying the boundary is total:

- **Anyone with shell access to the internal network or to a container** can call
  `upstream-tool` directly. Isolation is a network property, not a cryptographic one.
- **The proxy token is a bearer token.** Whoever holds it can act as that agent
  until it is rotated. Use TLS and short rotation.
- **A compromised proxy** holds both credentials. It is the trusted component here.
- **Relayed intent is agent-supplied.** It is semantic evidence and can never
  override a hard rule, but a lying agent can influence the semantic signal.
- **Single-node compose is not a production deployment.** There is no TLS, no
  secret manager, no backup, and no failover. Those are P2.

For a cryptographic boundary that survives an agent reaching the tool directly,
use the [credential broker](../../docs/integrations.md): the tool verifies a
signed request and refuses anything that did not come through an exchange.
