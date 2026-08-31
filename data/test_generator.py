"""Phase 1 tests: the dataset is reproducible and the response model is honest.

Run: pytest data/ -v
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

GENERATOR_DIR = Path(__file__).resolve().parent / "generator"
sys.path.insert(0, str(GENERATOR_DIR))

from generate import FAILURE_CODES, MIX, generate            # noqa: E402
from response_model import (                                  # noqa: E402
    BASELINE_RECOVERY,
    DIAGNOSES,
    MAX_PROBABILITY,
    TREATMENT_UPLIFT,
    ResponseContext,
    delay_bucket,
    recovery_probability,
)

SEED = 20260831


@pytest.fixture(scope="module")
def dataset():
    return generate(SEED)


# ----------------------------------------------------------------- determinism

def test_same_seed_produces_identical_data():
    """The whole evaluation story rests on this."""
    first = generate(SEED)
    second = generate(SEED)
    for a, b in zip(first, second):
        assert a == b


def test_different_seed_produces_different_data():
    a = generate(SEED)[4]
    b = generate(SEED + 1)[4]
    assert a != b, "different seeds must not collapse to the same dataset"


# ----------------------------------------------------------------- shape

def test_attempt_count_matches_declared_mix(dataset):
    _, _, _, _, attempts, _ = dataset
    assert len(attempts) == sum(count for _, _, count in MIX)


def test_every_failed_attempt_has_a_failure_code(dataset):
    """Mirrors the DB CHECK constraint; catches drift before a load fails."""
    _, _, _, _, attempts, _ = dataset
    for a in attempts:
        if a.status == "FAILED":
            assert a.failure_code, f"{a.id} is FAILED with no failure_code"


def test_failure_codes_map_to_declared_diagnosis(dataset):
    _, _, _, _, attempts, _ = dataset
    for a in attempts:
        if a.status == "FAILED" and a.failure_code:
            assert FAILURE_CODES[a.failure_code] == a.true_diagnosis


def test_successful_attempts_carry_no_diagnosis(dataset):
    _, _, _, _, attempts, _ = dataset
    for a in attempts:
        if a.status == "SUCCESS":
            assert a.true_diagnosis == ""
            assert a.failure_code == ""


def test_amounts_are_positive_integers(dataset):
    _, _, _, orders, attempts, _ = dataset
    for row in [*orders, *attempts]:
        assert isinstance(row.amount_paise, int) and row.amount_paise > 0


def test_foreign_keys_resolve(dataset):
    merchants, customers, preferences, orders, attempts, truths = dataset
    merchant_ids = {m.id for m in merchants}
    customer_ids = {c.id for c in customers}
    order_ids = {o.id for o in orders}
    attempt_ids = {a.id for a in attempts}

    assert {c.merchant_id for c in customers} <= merchant_ids
    assert {p.customer_id for p in preferences} == customer_ids
    assert {o.customer_id for o in orders} <= customer_ids
    assert {a.order_id for a in attempts} <= order_ids
    assert {t.attempt_id for t in truths} <= attempt_ids


# ----------------------------------------------------------------- splits

def test_split_proportions_are_close_to_target(dataset):
    _, _, _, _, attempts, _ = dataset
    counts = {"TRAIN": 0, "VALIDATION": 0, "HELDOUT": 0}
    for a in attempts:
        counts[a.split] += 1
    total = len(attempts)
    assert 0.18 <= counts["HELDOUT"] / total <= 0.22
    assert 0.13 <= counts["VALIDATION"] / total <= 0.17


def test_every_diagnosis_appears_in_heldout(dataset):
    """Stratification exists so no category has an undefined heldout score."""
    _, _, _, _, attempts, _ = dataset
    present = {a.true_diagnosis for a in attempts if a.true_diagnosis}
    in_heldout = {a.true_diagnosis for a in attempts if a.split == "HELDOUT" and a.true_diagnosis}
    assert present == in_heldout, f"missing from HELDOUT: {present - in_heldout}"


def test_splits_are_disjoint(dataset):
    _, _, _, _, attempts, _ = dataset
    assert len({a.id for a in attempts}) == len(attempts)


# ----------------------------------------------------------------- leakage

def test_ground_truth_is_stored_separately_from_attempts(dataset):
    """Outcomes must not be reachable from an attempt row.

    If a simulated outcome ever became a feature, every recovery number would be
    circular. Keeping the files apart makes that mistake visible in review.
    """
    _, _, _, _, attempts, _ = dataset
    forbidden = {"baseline_recovers", "recovered", "recovers_if_contacted_1h", "will_recover"}
    assert not (set(vars(attempts[0])) & forbidden)


def test_ground_truth_covers_every_recoverable_attempt(dataset):
    _, _, _, _, attempts, truths = dataset
    recoverable = {a.id for a in attempts if a.status != "SUCCESS"}
    assert {t.attempt_id for t in truths} == recoverable


# ----------------------------------------------------------------- response model

def test_documentation_matches_code():
    """RESPONSE_MODEL.md and response_model.py must not drift apart.

    The document is our honesty claim; if it disagreed with the code it would be
    worse than having no document.
    """
    doc = (Path(__file__).resolve().parents[1] / "RESPONSE_MODEL.md").read_text(encoding="utf-8")

    for diagnosis, expected in BASELINE_RECOVERY.items():
        row = re.search(rf"^\|\s*`{diagnosis}`\s*\|\s*([0-9.]+)\s*\|", doc, re.MULTILINE)
        assert row, f"{diagnosis} missing from the baseline table"
        assert float(row.group(1)) == expected, f"{diagnosis} baseline disagrees with code"

    for diagnosis, upl in TREATMENT_UPLIFT.items():
        row = re.search(rf"^\|\s*`{diagnosis}`\s*\|\s*([+0-9.]+)\s*\|\s*([+0-9.]+)\s*\|"
                        rf"\s*([+0-9.]+)\s*\|\s*([+0-9.]+)\s*\|", doc, re.MULTILINE)
        assert row, f"{diagnosis} missing from the uplift table"
        assert tuple(float(row.group(i)) for i in range(1, 5)) == upl, \
            f"{diagnosis} uplift disagrees with code"


def test_all_diagnoses_have_parameters():
    for d in DIAGNOSES:
        assert d in BASELINE_RECOVERY and d in TREATMENT_UPLIFT


def test_hopeless_categories_get_no_uplift():
    """Contacting these customers cannot help; crediting recovery would be an artifact."""
    for d in ("SUSPICIOUS_ACTIVITY", "MERCHANT_CONFIGURATION_ERROR"):
        assert TREATMENT_UPLIFT[d] == (0.0, 0.0, 0.0, 0.0)
        ctx = ResponseContext(d, hours_to_contact=0.5, amount_paise=100_000,
                              prior_success_count=5, prior_failure_count=0)
        assert recovery_probability(ctx) == BASELINE_RECOVERY[d]


def test_insufficient_funds_rewards_waiting():
    """Encodes the judgment that contacting immediately after a low-balance decline
    is worse than waiting. A system that always acts instantly should score worse."""
    immediate = recovery_probability(ResponseContext("INSUFFICIENT_FUNDS", 0.5, 100_000, 1, 0))
    later = recovery_probability(ResponseContext("INSUFFICIENT_FUNDS", 12.0, 100_000, 1, 0))
    assert later > immediate


def test_temporary_failure_rewards_acting_fast():
    fast = recovery_probability(ResponseContext("TEMPORARY_BANK_OR_NETWORK_FAILURE", 0.5, 100_000, 1, 0))
    slow = recovery_probability(ResponseContext("TEMPORARY_BANK_OR_NETWORK_FAILURE", 48.0, 100_000, 1, 0))
    assert fast > slow


def test_contact_never_reduces_probability_below_baseline():
    for d in DIAGNOSES:
        for hours in (0.5, 3.0, 12.0, 48.0):
            ctx = ResponseContext(d, hours, 100_000, 0, 0)
            assert recovery_probability(ctx) >= BASELINE_RECOVERY[d] - 1e-9


def test_probability_stays_in_range():
    for d in DIAGNOSES:
        for scenario in ("pessimistic", "central", "optimistic"):
            ctx = ResponseContext(d, 0.5, 10_000, 8, 0)
            p = recovery_probability(ctx, scenario)
            assert 0.0 <= p <= MAX_PROBABILITY


def test_second_reminder_is_worth_much_less():
    first = recovery_probability(ResponseContext("USER_ABANDONMENT", 0.5, 100_000, 1, 0, reminder_number=1))
    second = recovery_probability(ResponseContext("USER_ABANDONMENT", 0.5, 100_000, 1, 0, reminder_number=2))
    assert second < first


def test_sensitivity_scenarios_are_ordered():
    ctx = ResponseContext("TEMPORARY_BANK_OR_NETWORK_FAILURE", 0.5, 100_000, 1, 0)
    p = [recovery_probability(ctx, s) for s in ("pessimistic", "central", "optimistic")]
    assert p[0] < p[1] < p[2]


def test_delay_buckets_partition_time():
    assert delay_bucket(0.0) == delay_bucket(1.0) == "le_1h"
    assert delay_bucket(1.01) == delay_bucket(6.0) == "le_6h"
    assert delay_bucket(6.01) == delay_bucket(24.0) == "le_24h"
    assert delay_bucket(24.01) == delay_bucket(999.0) == "gt_24h"


def test_unknown_inputs_are_rejected():
    with pytest.raises(ValueError):
        recovery_probability(ResponseContext("NOT_A_DIAGNOSIS", 1.0, 100, 0, 0))
    with pytest.raises(ValueError):
        recovery_probability(ResponseContext("UNKNOWN", 1.0, 100, 0, 0), scenario="wishful")
