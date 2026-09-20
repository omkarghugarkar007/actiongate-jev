"""Provider wire-contract tests; no external requests or credentials."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))

from actiongate._core.providers import ProviderError, TypeSafeJevProvider  # noqa: E402


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def test_direct_typesafe_wire_contract_and_normalization():
    captured = {}

    def opener(request, timeout):
        captured["url"] = request.full_url
        captured["authorization"] = request.get_header("Authorization")
        captured["body"] = json.loads(request.data)
        captured["timeout"] = timeout
        return Response({
            "model": "jev-1.13.0",
            "answers": {"aligned": {"type": "noul", "noul": 0.98}},
            "usage": {"input_tokens": 12, "output_tokens": 2},
        })

    provider = TypeSafeJevProvider("ts_test", opener=opener)
    result = provider.evaluate({"text": "hello"}, {"aligned": {"type": "noul", "instructions": "Aligned?"}}, 2_000)

    assert captured == {
        "url": "https://api.typesafe.ai/v1/systemone",
        "authorization": "Bearer ts_test",
        "body": {
            "model": "jev-1.13.0",
            "state": {"text": "hello"},
            "questions": {"aligned": {"type": "noul", "instructions": "Aligned?"}},
        },
        "timeout": pytest.approx(2.0, abs=0.1),
    }
    assert result["provider"] == "typesafe"
    assert result["requestedModel"] == "jev-1.13.0"
    assert result["model"] == "jev-1.13.0"
    assert result["usage"] == {"inputTokens": 12, "outputTokens": 2}


def test_direct_typesafe_requires_a_key():
    with pytest.raises(ProviderError) as raised:
        TypeSafeJevProvider("")
    assert raised.value.code == "JEV_AUTH_ERROR"


def test_direct_typesafe_rejects_malformed_evidence():
    def opener(_request, timeout):
        del timeout
        return Response({
            "model": "jev-1.13.0",
            "answers": {"aligned": {"type": "noul", "noul": 2}},
            "usage": {},
        })

    provider = TypeSafeJevProvider("ts_test", opener=opener)
    with pytest.raises(ProviderError) as raised:
        provider.evaluate({}, {"aligned": {"type": "noul", "instructions": "Aligned?"}})
    assert raised.value.code == "JEV_MALFORMED_RESPONSE"
