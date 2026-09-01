"""Tests for the evaluation harness.

The harness produces the project's headline numbers, so its own correctness matters
as much as the pipeline's. These check the statistics, the reproducibility, and --
most importantly -- that the two-tier split is actually maintained.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "data" / "generator"))

from evaluate import CONTACT_ACTIONS, RECIPE_DELAY_HOURS, wilson_interval  # noqa: E402


@pytest.fixture(scope="module")
def report() -> dict:
    path = ROOT / "evaluation" / "report.json"
    if not path.exists():
        pytest.skip("run evaluation/evaluate.py first")
    return json.loads(path.read_text(encoding="utf-8"))


# ----------------------------------------------------------------- statistics

def test_wilson_interval_brackets_the_estimate():
    low, high = wilson_interval(30, 100)
    assert low < 0.30 < high


def test_wilson_interval_stays_within_zero_and_one():
    """The reason we use Wilson rather than the normal approximation.

    At small n with an extreme proportion, the normal interval runs past 0 or 1, which
    is a nonsense confidence bound. Our control arm is small enough for this to matter.
    """
    for successes, total in [(0, 10), (10, 10), (1, 5), (0, 3)]:
        low, high = wilson_interval(successes, total)
        assert 0.0 <= low <= high <= 1.0


def test_wilson_interval_narrows_as_evidence_grows():
    small = wilson_interval(3, 10)
    large = wilson_interval(300, 1000)
    assert (large[1] - large[0]) < (small[1] - small[0])


def test_wilson_interval_handles_empty_input():
    assert wilson_interval(0, 0) == (0.0, 0.0)


# ----------------------------------------------------------------- policy alignment

def test_recipe_delays_match_the_planner():
    """The evaluation must describe the policy that actually ran.

    If plan.ts changes a delay and this table does not, the report silently measures a
    policy Reclaim does not implement.
    """
    plan = (ROOT / "src" / "decisions" / "plan.ts").read_text(encoding="utf-8")
    for diagnosis, hours in RECIPE_DELAY_HOURS.items():
        minutes = int(hours * 60)
        expected = f"delayMinutes: {minutes}" if minutes < 60 else None
        if expected:
            assert expected in plan, f"{diagnosis}: plan.ts has no delayMinutes of {minutes}"


def test_contact_actions_match_the_policy_engine():
    rules = (ROOT / "src" / "policy" / "rules.ts").read_text(encoding="utf-8")
    plan = (ROOT / "src" / "decisions" / "plan.ts").read_text(encoding="utf-8")
    for action in CONTACT_ACTIONS:
        assert action in plan or action in rules, f"{action} appears in neither plan.ts nor rules.ts"


# ----------------------------------------------------------------- the two tiers

def test_verified_and_simulated_stay_separate(report: dict):
    """The split is the project's central honesty claim.

    A recovery figure that drifted into the verified tier would be presenting a
    simulation as a measurement.
    """
    assert set(report.keys()) >= {"verified", "simulated"}
    verified_text = json.dumps(report["verified"]).lower()
    for forbidden in ["recovery_rate", "revenue_paise", "uplift"]:
        assert forbidden not in verified_text, f"'{forbidden}' must not appear in the verified tier"


def test_simulated_tier_names_its_assumptions(report: dict):
    simulated = report["simulated"]
    assert simulated["response_model"] == "RESPONSE_MODEL.md"
    assert len(simulated["caveats"]) >= 3


def test_every_scenario_reports_a_control_arm(report: dict):
    """Uplift without a control arm is an unfalsifiable claim."""
    for name, scenario in report["simulated"]["scenarios"].items():
        assert scenario["control"]["n"] > 0, f"{name} has no control arm"
        assert "rate_ci95" in scenario["control"]
        assert "uplift_ci_overlaps" in scenario


def test_sensitivity_scenarios_are_ordered(report: dict):
    scenarios = report["simulated"]["scenarios"]
    assert (
        scenarios["pessimistic"]["treatment"]["rate"]
        < scenarios["central"]["treatment"]["rate"]
        < scenarios["optimistic"]["treatment"]["rate"]
    )


def test_control_arm_is_identical_across_scenarios(report: dict):
    """Sensitivity varies treatment uplift, so the untreated baseline must not move."""
    rates = {s["control"]["rate"] for s in report["simulated"]["scenarios"].values()}
    assert len(rates) == 1, f"control rate varies across scenarios: {rates}"


# ----------------------------------------------------------------- verified claims

def test_zero_policy_violations(report: dict):
    """The claim Reclaim makes without qualification."""
    violations = report["verified"]["policy_violations"]
    for rule, count in violations.items():
        assert count == 0, f"{rule}: {count} violations"


def test_diagnosis_accuracy_carries_its_caveat(report: dict):
    """Overall accuracy is near-tautological and must say so.

    The generator writes a gateway code and the engine maps it back through the same
    table. Reporting 99.8% as an achievement would be presenting arithmetic as
    inference.
    """
    diagnosis = report["verified"]["diagnosis"]
    assert "_caveat" in diagnosis
    assert "tautological" in diagnosis["_caveat"].lower()
    assert "ambiguous_subset" in diagnosis


def test_ambiguous_subset_is_actually_ambiguous(report: dict):
    """The meaningful accuracy number, over cases that need a real judgment.

    It must be small: if this subset grew large, it would mean trivial cases had crept
    back in, as ABANDONED rows once did.
    """
    subset = report["verified"]["diagnosis"]["ambiguous_subset"]
    assert subset["n"] > 0
    assert subset["n"] < 100, "ambiguous subset looks too large; trivial cases may have crept in"
    assert subset["accuracy"] < 1.0, "perfect accuracy here would suggest the cases are not ambiguous"


def test_coverage_numbers_are_consistent(report: dict):
    coverage = report["verified"]["coverage"]
    assert coverage["contacted"] + coverage["suppressed"] <= coverage["cases"]
    assert 0 < coverage["contact_rate"] < 1
