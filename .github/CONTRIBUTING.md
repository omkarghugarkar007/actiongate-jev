# Contributing to ActionGate

Thanks for helping make AI-agent actions safer. Contributions to code, tests, documentation, examples, threat modeling, and evaluation cases are welcome.

## Before you start

- Search [existing issues](https://github.com/omkarghugarkar007/actiongate-jev/issues) before opening a new one.
- Use a public issue for a bug or proposal. Use [private vulnerability reporting](https://github.com/omkarghugarkar007/actiongate-jev/security/advisories/new) for security findings.
- Discuss material authorization semantics, policy behavior, or public API changes before implementing them.
- Never commit credentials, customer data, or unsanitized provider responses.

## Local setup

```bash
git clone https://github.com/omkarghugarkar007/actiongate-jev.git
cd actiongate-jev
corepack enable
cp .env.example .env
pnpm install
pnpm test
```

The default fake decision provider is deterministic and does not require an OpenRouter key. Live Jev tests are optional and incur provider cost.

## Development workflow

1. Create a focused branch from `main`.
2. Make the smallest coherent change and add tests for changed behavior.
3. Update documentation when configuration, APIs, or security boundaries change.
4. Run the required checks.
5. Open a pull request using the repository template.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm e2e
pnpm audit --prod
```

## Authorization invariants

Changes must preserve these security properties:

- Deterministic failures take precedence over semantic scores.
- A provider outage cannot silently authorize a high-risk action.
- The agent cannot choose its own risk class or authorization mode.
- Generated prose is not used as an executable authorization reason.
- Audit payloads and fixtures remain credential-free and minimized.
- Provider changes retain the `DecisionProvider` boundary and never introduce an implicit fallback model.

Provider-contract or threshold changes should include adversarial cases and explain their expected effect on false-allow and review rates.

## Pull requests

Keep pull requests focused and explain:

- What changed and why
- How it was tested
- Any security, compatibility, cost, or calibration impact
- Whether documentation or migration steps are required

By contributing, you agree that your contribution is licensed under the repository's [Apache License 2.0](../LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
