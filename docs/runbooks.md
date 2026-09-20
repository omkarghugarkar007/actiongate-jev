# Runbooks

Operational procedures. Each says what to do, what to check afterwards, and what
it does *not* fix.

> ActionGate fails closed. Most dependency failures show up as denied or reviewed
> actions, not as actions waved through. Restoring service is urgent; it is not a
> safety emergency.

---

## Deployment

1. Apply migrations before starting the new version: `pnpm db:migrate`.
   Migrations are additive and defaulted, so a previous version keeps running
   against the migrated schema during a rolling deploy.
2. Confirm production configuration is complete. Startup refuses to boot without
   Redis, PostgreSQL, and explicit signing and evidence key rings, so a missing
   key is a crash at boot rather than a weaker boundary at runtime.
3. Roll instances one at a time. Grant state lives in Redis, so an in-flight
   grant issued by one instance is consumable by another.
4. Check `/ready` on each instance and `actiongate_decisions_total` for traffic.

**Does not cover:** the proxies and the fact-provider services, which deploy on
their own cadence. A proxy pointing at a drained API fails closed.

---

## Migration

1. Generate with `pnpm db:generate`, and read the SQL before committing it.
2. Every column added to an existing table needs a default or must be nullable.
   A migration that assumes an empty table will fail in production.
3. Apply with `pnpm db:migrate`. The command is idempotent; re-running is safe.
4. Verify: `pnpm test:postgres` against the migrated database.

**Rollback:** there is no down-migration. Recover by restoring a backup taken
before the deploy — see *Restore*. Write migrations that an older version can
tolerate so rollback means deploying the old code, not reversing the schema.

---

## Key rotation

Grant-signing and evidence-encryption keys rotate the same way. Both support an
overlap window so verification of existing material continues.

1. Generate: `openssl rand -base64 32`.
2. Add the new key to the ring, keeping the old one:
   `ACTIONGATE_GRANT_KEYS={"grant_2026_09":"…","grant_2026_12":"…"}`
3. Leave `ACTIONGATE_GRANT_ACTIVE_KID` on the old key and deploy. Every instance
   can now verify the new key before any instance issues with it.
4. Point `ACTIONGATE_GRANT_ACTIVE_KID` at the new key and deploy again.
5. Wait longer than `ACTIONGATE_GRANT_TTL_SECONDS` so grants signed with the old
   key have expired, then remove it.

Evidence keys differ in one way: **encrypted evidence does not expire.** Removing
an evidence key makes everything encrypted under it permanently unreadable.
Re-encrypt or accept the loss deliberately; do not drop the key to tidy up.

**Check afterwards:** issue and consume a grant, and read back an audit export.

---

## Retention

1. `DELETE /v1/audit/retention?before=<ISO timestamp>` with an `audit_exporter`
   or `policy_admin` key.
2. Idempotency tombstones are kept deliberately, so deleting evidence does not
   let a replayed request through as if it were new.
3. Export first if the evidence is needed: retention deletion is not reversible.

---

## Restore

1. Stop writers, or accept that anything after the backup is lost.
2. Restore PostgreSQL from the dump.
3. Redis holds short-lived runtime state and is **not** restored. Outstanding
   grants are lost, which means unconsumed permits become unusable. That is the
   safe direction: callers re-authorize.
4. Run `pnpm drill:dependency` against a staging copy of the backup first. It
   verifies row counts survive the round trip.
5. After restoring, rotate any credential that may have been exposed.

**Does not cover:** reversing business side effects that already happened.
ActionGate records execution outcomes; it cannot undo them.

---

## Incident: a tool is behaving unsafely

1. Disable it. `POST /v1/incidents/disable-tools {"tools":["refund_payment"]}`.
   Authorization for that tool now fails closed immediately.
2. Revoke outstanding permits.
   `POST /v1/incidents/revoke-grants {"tool":"refund_payment"}`. Already-consumed
   grants cannot be recalled; this stops the ones not yet spent.
3. Establish what actually executed: `GET /v1/executions?decisionId=…`. An
   authorized action is not a completed one.
4. Export the evidence: `GET /v1/audit/export`. When an evidence key ring is
   configured the export is hash-chained and signed, so it can be handed to
   someone who does not trust the exporter.
5. Record the case as a regression example **before** changing any threshold.
   Tuning a threshold without a calibration run showing the unsafe-allow rate
   did not move trades a visible failure for an invisible one.

---

## Incident: a key may be compromised

- **Tenant API key:** `POST /v1/api-keys/{id}/revoke`. Effective immediately;
  audit events keep the actor's key ID so the blast radius stays attributable.
- **Grant signing key:** remove it from the ring and deploy. Grants signed with
  it stop verifying at once, which denies in-flight legitimate work too. That
  trade is usually right for a compromised key.
- **Proxy token:** rotate the token and redeploy the proxy. The token is a bearer
  credential; anyone holding it acts as that agent until it changes.
- **Credential-broker key:** rotate on both sides at once. The downstream
  verifier and the broker share it, so a one-sided rotation rejects valid
  requests.

---

## Provider outage

Risk-aware fallback already applies: read-only actions go to review, financial
and destructive actions block. The symptom is review volume, not unsafe allows.

1. Check `actiongate_provider_errors_total` against `actiongate_decisions_total`.
2. Confirm `JEV_TIMEOUT_MS` is not simply too tight for current latency.
3. Do not enable `ACTIONGATE_FAIL_OPEN_READ_ONLY` to clear a queue unless the
   read-only path is genuinely safe to open in your deployment. It is a policy
   decision, not an outage workaround.

---

## Promoting a model or policy change

1. Run a calibration on the reviewed dataset:
   `pnpm eval:calibrate -- --dataset core-v2 --provider openrouter`.
2. Compare against the previous run: `pnpm eval:drift -- --baseline … --candidate …`.
3. Promotion is blocked by any increase in unsafe allows, overall or in any risk
   stratum, and by a changed dataset hash. Warnings about model, battery, or
   policy changes are for a human to weigh, not to wave through.
4. A run built from unreviewed labels cannot gate a promotion. See the
   [annotator guidance](annotation-guide.md).
