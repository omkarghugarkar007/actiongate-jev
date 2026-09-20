"""The Python half of the cross-language conformance suite.

Two implementations of an authorization core drift unless something forces them
not to. These fixtures are that something, and `expected.json` holds values
recorded from the TypeScript reference, so Python must reproduce them exactly
rather than merely being self-consistent.

The fingerprint cases matter most: a mismatch would mean a grant issued by one
SDK does not verify in the other, silently and only for certain argument shapes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))

from actiongate._core.grants import action_binding_fingerprint, canonical_json  # noqa: E402
from actiongate._core.policy import DEFAULT_POLICY, THRESHOLD_PROFILES  # noqa: E402
from actiongate._core.rules import run_deterministic_rules  # noqa: E402

FIXTURES = json.loads((ROOT / "fixtures/conformance/cross-language.json").read_text())
EXPECTED = json.loads((ROOT / "fixtures/conformance/expected.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["canonicalJson"], ids=lambda case: case["name"])
def test_canonical_json_matches_the_fixture(case):
    assert canonical_json(case["value"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURES["canonicalJson"], ids=lambda case: case["name"])
def test_canonical_json_matches_typescript(case):
    assert canonical_json(case["value"]) == EXPECTED["canonicalJson"][case["name"]]


@pytest.mark.parametrize("case", FIXTURES["fingerprints"], ids=lambda case: case["name"])
def test_fingerprints_match_typescript(case):
    produced = action_binding_fingerprint(case["binding"], case["policyVersion"])
    assert produced == EXPECTED["fingerprints"][case["name"]], (
        "A fingerprint divergence means a grant issued by one SDK will not verify in the other"
    )


@pytest.mark.parametrize("case", FIXTURES["deterministicRules"], ids=lambda case: case["name"])
def test_deterministic_rules_match(case):
    result = run_deterministic_rules(
        case["proposedAction"], case["facts"], DEFAULT_POLICY.tools.get(case["tool"])
    )
    assert result.decision == case["expectedDecision"]
    assert [reason.code for reason in result.reasons] == case["expectedCodes"]


def test_threshold_profiles_match():
    expected = FIXTURES["thresholdProfiles"]
    assert sorted(THRESHOLD_PROFILES) == sorted(expected)
    for name, values in expected.items():
        profile = THRESHOLD_PROFILES[name]
        assert profile.alignment_min_confidence == values["alignmentMinConfidence"]
        assert profile.target_yes_min == values["targetYesMin"]
        assert profile.policy_violation_block_at == values["policyViolationBlockAt"]
        assert profile.sensitive_exposure_block_at == values["sensitiveExposureBlockAt"]
        assert profile.scope_expansion_block_at == values["scopeExpansionBlockAt"]
        assert profile.missing_intent_review_at == values["missingIntentReviewAt"]


def test_default_policy_tools_match_typescript():
    # Tool names, operations, and risk classes are part of the contract.
    assert sorted(DEFAULT_POLICY.tools) == ["delete_record", "get_order", "refund_payment", "send_email"]
    assert DEFAULT_POLICY.tools["refund_payment"].risk_class == "FINANCIAL"
    assert DEFAULT_POLICY.tools["delete_record"].enabled is False
    assert DEFAULT_POLICY.version == "1.0.0"
