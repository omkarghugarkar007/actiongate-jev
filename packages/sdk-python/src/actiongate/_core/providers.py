"""Decision providers.

`OpenRouterJevProvider` speaks the Decisions API over the standard library, so
the SDK still has no dependencies. `FakeDecisionProvider` is deterministic and
exists for tests and offline use — it proves plumbing, never semantic quality.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Protocol


class ProviderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}:{message}")
        self.code = code


class DecisionProvider(Protocol):
    def evaluate(self, state: dict[str, Any], questions: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
        ...


class OpenRouterJevProvider:
    def __init__(self, api_key: str, model: str = "typesafe/jev-1.13", endpoint: str | None = None, app_title: str = "ActionGate") -> None:
        if not api_key:
            raise ProviderError("JEV_AUTH_ERROR", "OpenRouter API key is required")
        self._api_key = api_key
        self._model = model
        self._endpoint = endpoint or "https://openrouter.ai/api/alpha/decisions"
        self._app_title = app_title

    def evaluate(self, state: dict[str, Any], questions: dict[str, Any], timeout_ms: int = 10_000) -> dict[str, Any]:
        body = json.dumps({"model": self._model, "state": state, "questions": questions}).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "X-OpenRouter-Title": self._app_title,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:  # noqa: S310
                raw = json.loads(response.read())
        except urllib.error.HTTPError as error:
            code = {401: "JEV_AUTH_ERROR", 402: "JEV_PAYMENT_REQUIRED", 429: "JEV_RATE_LIMITED"}.get(error.code, "JEV_PROVIDER_ERROR")
            raise ProviderError(code, f"OpenRouter returned HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise ProviderError("JEV_PROVIDER_ERROR", str(error.reason)) from error
        except TimeoutError as error:
            raise ProviderError("JEV_TIMEOUT", "request timed out") from error
        except json.JSONDecodeError as error:
            raise ProviderError("JEV_MALFORMED_RESPONSE", "response was not JSON") from error

        answers = raw.get("answers")
        if not isinstance(answers, dict):
            raise ProviderError("JEV_MALFORMED_RESPONSE", "response had no answers object")
        # Strict validation: a missing or wrongly typed answer must fail closed
        # rather than being treated as a permissive default.
        for key, question in questions.items():
            answer = answers.get(key)
            if not isinstance(answer, dict) or answer.get("type") != question["type"]:
                raise ProviderError("JEV_MISSING_ANSWER", f"answer for {key} was missing or malformed")
        return {
            "provider": raw.get("provider", "openrouter"),
            "model": raw.get("model", self._model),
            "answers": answers,
            "usage": raw.get("usage") or {},
        }


class FakeDecisionProvider:
    """Deterministic. Proves plumbing and cost paths; never semantic quality."""

    def __init__(self, scenario: str = "allow") -> None:
        self._scenario = scenario
        self.calls = 0

    def evaluate(self, state: dict[str, Any], questions: dict[str, Any], timeout_ms: int = 10_000) -> dict[str, Any]:
        self.calls += 1
        if self._scenario == "error":
            raise ProviderError("JEV_TIMEOUT", "simulated timeout")
        scope = 0.96 if self._scenario == "scope" else 0.02
        missing = 0.90 if self._scenario == "missing" else 0.02
        ambiguous = self._scenario == "missing"
        return {
            "provider": "fake",
            "model": "fake/jev-test",
            "answers": {
                "alignment": {
                    "type": "choice",
                    "choice": "ambiguous" if ambiguous else "exact",
                    "probabilities": {"exact": 0.08 if ambiguous else 0.97, "narrower": 0.01, "ambiguous": 0.88 if ambiguous else 0.01, "unrelated": 0.01, "conflicting": 0.0},
                    "confidence": 0.99,
                },
                "target_matches_intent": {"type": "noul", "noul": 0.98},
                "violates_semantic_policy": {"type": "noul", "noul": 0.01},
                "unnecessary_sensitive_exposure": {"type": "noul", "noul": 0.01},
                "materially_expands_scope": {"type": "noul", "noul": scope},
                "missing_required_intent": {"type": "noul", "noul": missing},
            },
            "usage": {"inputTokens": 100, "outputTokens": 10},
        }
