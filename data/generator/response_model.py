"""Simulated customer response model.

This module is the single source of truth for every recovery probability in Reclaim.
RESPONSE_MODEL.md documents these same numbers for a human reader; test_response_model.py
asserts the two agree, so the documentation cannot silently drift from the code.

Nothing here is measured from real data. See RESPONSE_MODEL.md for what that means
for how our results should be read.
"""

from __future__ import annotations

from dataclasses import dataclass

DIAGNOSES = (
    "TEMPORARY_BANK_OR_NETWORK_FAILURE",
    "INSUFFICIENT_FUNDS",
    "EXPIRED_PAYMENT_METHOD",
    "USER_ABANDONMENT",
    "DUPLICATE_OR_REPEAT_ATTEMPT",
    "SUSPICIOUS_ACTIVITY",
    "MERCHANT_CONFIGURATION_ERROR",
    "UNKNOWN",
)

# Probability the customer pays with no contact at all. This is the control arm.
BASELINE_RECOVERY = {
    "TEMPORARY_BANK_OR_NETWORK_FAILURE": 0.22,
    "INSUFFICIENT_FUNDS": 0.12,
    "EXPIRED_PAYMENT_METHOD": 0.08,
    "USER_ABANDONMENT": 0.05,
    "DUPLICATE_OR_REPEAT_ATTEMPT": 0.15,
    "SUSPICIOUS_ACTIVITY": 0.02,
    "MERCHANT_CONFIGURATION_ERROR": 0.03,
    "UNKNOWN": 0.10,
}

# Uplift added when a recovery action reaches the customer, bucketed by how long
# after the failure contact happened. Buckets: <=1h, <=6h, <=24h, >24h.
DELAY_BUCKETS = ("le_1h", "le_6h", "le_24h", "gt_24h")

TREATMENT_UPLIFT = {
    "TEMPORARY_BANK_OR_NETWORK_FAILURE": (0.38, 0.28, 0.15, 0.06),
    # Peaks late on purpose: contacting someone one minute after a low-balance
    # decline does nothing. A system that always acts immediately should score
    # worse here, and that has to be visible in the numbers.
    "INSUFFICIENT_FUNDS": (0.06, 0.11, 0.18, 0.14),
    "EXPIRED_PAYMENT_METHOD": (0.24, 0.22, 0.16, 0.08),
    "USER_ABANDONMENT": (0.18, 0.14, 0.09, 0.04),
    "DUPLICATE_OR_REPEAT_ATTEMPT": (0.02, 0.02, 0.01, 0.01),
    # Zero throughout: contacting these customers cannot help, so the model
    # refuses to credit any recovery to it.
    "SUSPICIOUS_ACTIVITY": (0.0, 0.0, 0.0, 0.0),
    "MERCHANT_CONFIGURATION_ERROR": (0.0, 0.0, 0.0, 0.0),
    "UNKNOWN": (0.12, 0.09, 0.05, 0.02),
}

MODIFIERS = {
    "has_prior_success": 1.25,
    "many_prior_failures": 0.70,   # >= 3
    "high_value": 0.80,            # > Rs 10,000
    "low_value": 1.10,             # < Rs 500
    "second_reminder": 0.45,
}

MANY_FAILURES_THRESHOLD = 3
HIGH_VALUE_PAISE = 1_000_000   # Rs 10,000
LOW_VALUE_PAISE = 50_000       # Rs 500

MAX_PROBABILITY = 0.95

SENSITIVITY = {"pessimistic": 0.6, "central": 1.0, "optimistic": 1.4}


def delay_bucket(hours: float) -> str:
    """Map hours-since-failure to an uplift bucket."""
    if hours <= 1:
        return "le_1h"
    if hours <= 6:
        return "le_6h"
    if hours <= 24:
        return "le_24h"
    return "gt_24h"


@dataclass(frozen=True)
class ResponseContext:
    diagnosis: str
    hours_to_contact: float | None   # None => no contact (control arm)
    amount_paise: int
    prior_success_count: int
    prior_failure_count: int
    reminder_number: int = 1


def recovery_probability(ctx: ResponseContext, scenario: str = "central") -> float:
    """Probability this customer completes payment.

    With hours_to_contact=None returns the untreated baseline, which is what the
    CONTROL arm receives. Uplift is what treatment adds on top of that.
    """
    if ctx.diagnosis not in BASELINE_RECOVERY:
        raise ValueError(f"unknown diagnosis: {ctx.diagnosis}")
    if scenario not in SENSITIVITY:
        raise ValueError(f"unknown scenario: {scenario}")

    baseline = BASELINE_RECOVERY[ctx.diagnosis]
    if ctx.hours_to_contact is None:
        return baseline

    bucket_index = DELAY_BUCKETS.index(delay_bucket(ctx.hours_to_contact))
    uplift = TREATMENT_UPLIFT[ctx.diagnosis][bucket_index] * SENSITIVITY[scenario]

    if ctx.prior_success_count >= 1:
        uplift *= MODIFIERS["has_prior_success"]
    if ctx.prior_failure_count >= MANY_FAILURES_THRESHOLD:
        uplift *= MODIFIERS["many_prior_failures"]
    if ctx.amount_paise > HIGH_VALUE_PAISE:
        uplift *= MODIFIERS["high_value"]
    elif ctx.amount_paise < LOW_VALUE_PAISE:
        uplift *= MODIFIERS["low_value"]
    if ctx.reminder_number >= 2:
        uplift *= MODIFIERS["second_reminder"]

    return min(baseline + uplift, MAX_PROBABILITY)
