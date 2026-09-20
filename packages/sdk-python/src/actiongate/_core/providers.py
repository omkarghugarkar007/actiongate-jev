"""Decision providers.

The direct TypeSafe and OpenRouter adapters use only the standard library, so
the SDK still has no dependencies. `FakeDecisionProvider` is deterministic and
exists for tests and offline use — it proves plumbing, never semantic quality.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from numbers import Real
from typing import Any, Callable, Protocol


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

        if not isinstance(raw, dict):
            raise ProviderError("JEV_MALFORMED_RESPONSE", "response was not an object")
        answers = _validate_answers(raw.get("answers"), questions)
        resolved_model = _validate_model(raw.get("model"))
        return {
            "provider": raw.get("provider", "openrouter"),
            "requestedModel": self._model,
            "model": resolved_model,
            "answers": answers,
            "usage": raw.get("usage") or {},
        }


class TypeSafeJevProvider:
    """Direct TypeSafe System One adapter with bounded 429/529 retries."""

    def __init__(
        self,
        api_key: str,
        model: str = "jev-1.13.0",
        endpoint: str | None = None,
        max_retries: int = 2,
        retry_base_seconds: float = 0.25,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        if not api_key:
            raise ProviderError("JEV_AUTH_ERROR", "TypeSafe API key is required")
        if not isinstance(max_retries, int) or not 0 <= max_retries <= 5:
            raise ProviderError("JEV_CONFIG_ERROR", "TypeSafe max_retries must be an integer from 0 to 5")
        if retry_base_seconds < 0:
            raise ProviderError("JEV_CONFIG_ERROR", "TypeSafe retry_base_seconds must be non-negative")
        self._api_key = api_key
        self._model = model
        self._endpoint = endpoint or "https://api.typesafe.ai/v1/systemone"
        self._max_retries = max_retries
        self._retry_base_seconds = retry_base_seconds
        self._opener = opener or urllib.request.urlopen

    def evaluate(self, state: dict[str, Any], questions: dict[str, Any], timeout_ms: int = 10_000) -> dict[str, Any]:
        if timeout_ms <= 0:
            raise ProviderError("JEV_CONFIG_ERROR", "timeout_ms must be positive")
        deadline = time.monotonic() + (timeout_ms / 1000)
        body = json.dumps({"model": self._model, "state": state, "questions": questions}).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        for attempt in range(self._max_retries + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError("JEV_TIMEOUT", "request timed out")
            try:
                with self._opener(request, timeout=remaining) as response:  # noqa: S310
                    raw = json.loads(response.read())
                break
            except urllib.error.HTTPError as error:
                if error.code in (429, 529) and attempt < self._max_retries:
                    delay = _retry_delay(error.headers.get("retry-after") if error.headers else None, self._retry_base_seconds * (2 ** attempt))
                    if delay >= deadline - time.monotonic():
                        raise ProviderError("JEV_TIMEOUT", "request timed out") from error
                    time.sleep(delay)
                    continue
                code = {
                    401: "JEV_AUTH_ERROR",
                    402: "JEV_PAYMENT_REQUIRED",
                    422: "JEV_REQUEST_INVALID",
                    429: "JEV_RATE_LIMITED",
                    529: "JEV_PROVIDER_OVERLOADED",
                }.get(error.code, "JEV_PROVIDER_ERROR")
                raise ProviderError(code, f"TypeSafe returned HTTP {error.code}") from error
            except urllib.error.URLError as error:
                raise ProviderError("JEV_PROVIDER_ERROR", str(error.reason)) from error
            except TimeoutError as error:
                raise ProviderError("JEV_TIMEOUT", "request timed out") from error
            except json.JSONDecodeError as error:
                raise ProviderError("JEV_MALFORMED_RESPONSE", "response was not JSON") from error

        if not isinstance(raw, dict):
            raise ProviderError("JEV_MALFORMED_RESPONSE", "response was not an object")
        answers = _validate_answers(raw.get("answers"), questions)
        resolved_model = _validate_model(raw.get("model"))
        usage = raw.get("usage") or {}
        if not isinstance(usage, dict):
            raise ProviderError("JEV_MALFORMED_RESPONSE", "response usage was not an object")
        return {
            "provider": "typesafe",
            "requestedModel": self._model,
            "model": resolved_model,
            "answers": answers,
            "usage": {
                **({"inputTokens": usage["input_tokens"]} if "input_tokens" in usage else {}),
                **({"outputTokens": usage["output_tokens"]} if "output_tokens" in usage else {}),
            },
        }


def _retry_delay(value: str | None, fallback: float) -> float:
    if value is None:
        return fallback
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            from datetime import datetime, timezone
            return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return fallback


def _validate_answers(raw_answers: Any, questions: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw_answers, dict):
        raise ProviderError("JEV_MALFORMED_RESPONSE", "response had no answers object")
    for key, question in questions.items():
        answer = raw_answers.get(key)
        if not isinstance(answer, dict):
            raise ProviderError("JEV_MISSING_ANSWER", f"answer for {key} was missing or malformed")
        answer_type = answer.get("type")
        if answer_type != question.get("type"):
            raise ProviderError("JEV_MALFORMED_RESPONSE", f"answer for {key} had the wrong type")
        if answer_type == "noul":
            _require_probability(answer.get("noul"), f"{key}.noul")
        elif answer_type == "choice":
            criteria = question.get("criteria")
            probabilities = answer.get("probabilities")
            if not isinstance(criteria, dict) or answer.get("choice") not in criteria:
                raise ProviderError("JEV_MALFORMED_RESPONSE", f"answer for {key} chose an unknown option")
            if not isinstance(probabilities, dict) or set(probabilities) != set(criteria):
                raise ProviderError("JEV_MALFORMED_RESPONSE", f"answer for {key} had mismatched probability options")
            for option, probability in probabilities.items():
                _require_probability(probability, f"{key}.probabilities.{option}")
            _require_probability(answer.get("confidence"), f"{key}.confidence")
        elif answer_type == "score":
            if not _is_number(answer.get("score")) or not isinstance(answer.get("probabilities"), dict):
                raise ProviderError("JEV_MALFORMED_RESPONSE", f"answer for {key} had an invalid score")
            for bucket, probability in answer["probabilities"].items():
                _require_probability(probability, f"{key}.probabilities.{bucket}")
            _require_probability(answer.get("confidence"), f"{key}.confidence")
        else:
            raise ProviderError("JEV_MALFORMED_RESPONSE", f"answer for {key} had an unknown type")
    return raw_answers


def _validate_model(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ProviderError("JEV_MALFORMED_RESPONSE", "response had no model identifier")
    return value


def _require_probability(value: Any, path: str) -> None:
    if not _is_number(value) or not 0 <= value <= 1:
        raise ProviderError("JEV_MALFORMED_RESPONSE", f"{path} was not a probability")


def _is_number(value: Any) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


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
            "requestedModel": "fake/jev-test",
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
