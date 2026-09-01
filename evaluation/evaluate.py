"""Reclaim's evaluation harness.

Produces evaluation/report.json, the project's measured results.

The report is split into two tiers, and the split is the point:

  VERIFIED   Measured against ground truth we control honestly. Diagnosis accuracy,
             policy violations, suppression correctness. These are claims about
             Reclaim, and they hold regardless of what any customer would have done.

  SIMULATED  Depends entirely on RESPONSE_MODEL.md. Recovery rate, revenue, uplift.
             These are claims about "Reclaim under these documented assumptions", and
             they are reported with a control arm and sensitivity bounds, never as a
             bare number.

Anything that reads like "we recovered X rupees" belongs in the second tier and is
labelled as such. Blurring the two is the single easiest way to lose a panel's trust.

    python evaluation/evaluate.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "data" / "generated"
OUT = ROOT / "evaluation" / "report.json"

sys.path.insert(0, str(ROOT / "data" / "generator"))
from response_model import (  # noqa: E402
    SENSITIVITY,
    ResponseContext,
    recovery_probability,
)

CONTACT_ACTIONS = {"SEND_PAYMENT_LINK", "SUGGEST_ALTERNATE_METHOD", "DELAYED_RETRY_PROMPT"}

# Delay each recipe waits, mirroring src/decisions/plan.ts. Kept here rather than
# imported because the evaluation must describe the policy that actually ran.
RECIPE_DELAY_HOURS = {
    "TEMPORARY_BANK_OR_NETWORK_FAILURE": 0.5,
    "INSUFFICIENT_FUNDS": 12.0,
    "EXPIRED_PAYMENT_METHOD": 0.25,
    "USER_ABANDONMENT": 1.0,
    "UNKNOWN": 2.0,
}


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval.

    Used rather than the normal approximation because our control arm is small, and
    the normal interval is badly behaved at small n -- it can even extend below zero,
    which would be a nonsense confidence bound on a proportion.
    """
    if total == 0:
        return (0.0, 0.0)
    p = successes / total
    denominator = 1 + z**2 / total
    centre = (p + z**2 / (2 * total)) / denominator
    margin = z * math.sqrt(p * (1 - p) / total + z**2 / (4 * total**2)) / denominator
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def load() -> pd.DataFrame:
    attempts = pd.read_csv(GENERATED / "payment_attempts.csv")
    customers = pd.read_csv(GENERATED / "customers.csv")
    preferences = pd.read_csv(GENERATED / "customer_preferences.csv")
    truth = pd.read_csv(GENERATED / "ground_truth.csv")
    decisions = pd.read_csv(GENERATED / "decisions.csv")

    df = (
        attempts[attempts["status"] != "SUCCESS"]
        .merge(customers[["id", "prior_success_count", "prior_failure_count"]],
               left_on="customer_id", right_on="id", suffixes=("", "_cus"))
        .merge(preferences[["customer_id", "is_opted_out"]], on="customer_id")
        .merge(truth, left_on="id", right_on="attempt_id")
        .merge(decisions, left_on="id", right_on="attempt_id", suffixes=("", "_dec"))
    )
    return df


def verified_metrics(df: pd.DataFrame) -> dict:
    """Claims that do not depend on the response model at all."""
    heldout = df[df["split"] == "HELDOUT"]

    # Overall diagnosis accuracy is close to 100%, and that number is not a result.
    # The generator writes a gateway failure code and the diagnosis engine maps that
    # same code back through the same lookup table, so agreement is arithmetic, not
    # inference. Reporting it as an achievement would be presenting a tautology.
    #
    # The part that is actually a judgment call is the ambiguous subset: rows with an
    # unrecognised code or no code at all, where the engine has to fall back to
    # heuristics. That is scored separately below, and it is the only diagnosis number
    # worth defending.
    # ABANDONED rows are excluded: they carry no gateway code, but the engine reads the
    # status directly, which is a lookup and not a judgment. Including them inflated
    # this subset to 390 rows of which 350 were trivial.
    ambiguous = df[
        df["failure_code"].isin(["UNSPECIFIED_DECLINE", "DECLINED_BY_BANK"])
        & (df["status"] != "ABANDONED")
    ]
    ambiguous_correct = int((ambiguous["diagnosis"] == ambiguous["true_diagnosis"]).sum())
    contacted = df[df["action"].isin(CONTACT_ACTIONS) & ~df["requires_approval"]]

    diagnosed = df[df["true_diagnosis"] != ""]
    correct = (diagnosed["diagnosis"] == diagnosed["true_diagnosis"]).sum()

    per_diagnosis = {}
    for label in sorted(diagnosed["true_diagnosis"].unique()):
        subset = diagnosed[diagnosed["true_diagnosis"] == label]
        predicted = diagnosed[diagnosed["diagnosis"] == label]
        true_positive = int((subset["diagnosis"] == label).sum())
        per_diagnosis[label] = {
            "n": int(len(subset)),
            "recall": round(true_positive / len(subset), 4) if len(subset) else 0.0,
            "precision": round(true_positive / len(predicted), 4) if len(predicted) else 0.0,
        }

    return {
        "diagnosis": {
            "_caveat": (
                "Overall accuracy is near-tautological: the generator writes a gateway code "
                "and the engine maps that same code back. The meaningful number is "
                "ambiguous_subset below, where no code mapping exists."
            ),
            "n": int(len(diagnosed)),
            "accuracy": round(float(correct / len(diagnosed)), 4),
            "ambiguous_subset": {
                "_note": (
                    "Unrecognised gateway code, excluding ABANDONED rows whose status "
                    "alone determines the answer. These are the cases where the engine "
                    "genuinely has to guess, and the sample is small."
                ),
                "n": int(len(ambiguous)),
                "accuracy": (
                    round(float(ambiguous_correct / len(ambiguous)), 4) if len(ambiguous) else None
                ),
            },
            "heldout_accuracy": round(
                float(
                    (heldout["diagnosis"] == heldout["true_diagnosis"]).sum()
                    / max(len(heldout[heldout["true_diagnosis"] != ""]), 1)
                ),
                4,
            ),
            "per_diagnosis": per_diagnosis,
        },
        "policy_violations": {
            # Every one of these must be zero. They are the claims we make without
            # qualification, so they are counted over the full corpus, not a sample.
            "opted_out_contacted": int(contacted["is_opted_out"].sum()),
            "control_arm_contacted": int((contacted["arm"] == "CONTROL").sum()),
            "fraud_contacted": int((contacted["true_diagnosis"] == "SUSPICIOUS_ACTIVITY").sum()),
            "merchant_error_contacted": int(
                (contacted["true_diagnosis"] == "MERCHANT_CONFIGURATION_ERROR").sum()
            ),
            "duplicate_contacted": int(
                (contacted["true_diagnosis"] == "DUPLICATE_OR_REPEAT_ATTEMPT").sum()
            ),
            "over_threshold_auto_approved": int(
                (contacted["amount_paise"] > contacted["approval_threshold_paise"]).sum()
            ),
        },
        "coverage": {
            "cases": int(len(df)),
            "contacted": int(len(contacted)),
            "suppressed": int((df["action"] == "NO_ACTION").sum()),
            "escalated": int((df["action"] == "HUMAN_ESCALATION").sum()),
            "merchant_alerted": int((df["action"] == "MERCHANT_ALERT").sum()),
            "held_for_approval": int(df["requires_approval"].sum()),
            "contact_rate": round(float(len(contacted) / len(df)), 4),
        },
    }


def simulate_outcome(row: pd.Series, hours: float | None, scenario: str, rng: np.random.Generator) -> bool:
    """Draw one outcome under the response model."""
    diagnosis = row["true_diagnosis"] or "UNKNOWN"
    probability = recovery_probability(
        ResponseContext(
            diagnosis=diagnosis,
            hours_to_contact=hours,
            amount_paise=int(row["amount_paise"]),
            prior_success_count=int(row["prior_success_count"]),
            prior_failure_count=int(row["prior_failure_count"]),
        ),
        scenario,
    )
    return bool(rng.random() < probability)


def simulated_metrics(df: pd.DataFrame, scenario: str, seed: int = 20260831) -> dict:
    """Recovery outcomes under one sensitivity scenario.

    Both arms are drawn from the same response model with the same seed, so the
    difference between them reflects the policy rather than sampling noise between
    two independent draws.
    """
    rng = np.random.default_rng(seed)

    treatment = df[(df["arm"] == "TREATMENT") & df["action"].isin(CONTACT_ACTIONS) & ~df["requires_approval"]]
    control = df[df["arm"] == "CONTROL"]

    treatment_recovered = 0
    treatment_revenue = 0
    for _, row in treatment.iterrows():
        hours = RECIPE_DELAY_HOURS.get(row["true_diagnosis"] or "UNKNOWN", 2.0)
        if simulate_outcome(row, hours, scenario, rng):
            treatment_recovered += 1
            treatment_revenue += int(row["amount_paise"])

    control_recovered = 0
    control_revenue = 0
    for _, row in control.iterrows():
        # No contact, by construction. This is the counterfactual.
        if simulate_outcome(row, None, scenario, rng):
            control_recovered += 1
            control_revenue += int(row["amount_paise"])

    # Baseline policy: contact every eligible case immediately, the naive strategy
    # Reclaim is meant to beat.
    #
    # "Eligible" excludes only what no reasonable system would contact: opted-out
    # customers (a legal line, not a policy choice) and diagnoses where contact cannot
    # help. It deliberately INCLUDES the high-value cases Reclaim holds for merchant
    # approval, because that is the point of the comparison -- the baseline spends
    # money without asking, and Reclaim does not.
    #
    # That makes the revenue columns non-comparable: the baseline collects revenue
    # Reclaim withheld on purpose, pending a human decision. Reported as
    # like_for_like below, restricted to the cases both policies would actually act
    # on, so the difference reflects targeting rather than permission.
    eligible = df[
        (df["arm"] == "TREATMENT")
        & ~df["is_opted_out"]
        & ~df["true_diagnosis"].isin(["SUSPICIOUS_ACTIVITY", "MERCHANT_CONFIGURATION_ERROR"])
    ]
    baseline_recovered = 0
    baseline_revenue = 0
    for _, row in eligible.iterrows():
        if simulate_outcome(row, 0.5, scenario, rng):
            baseline_recovered += 1
            baseline_revenue += int(row["amount_paise"])

    treatment_rate = treatment_recovered / len(treatment) if len(treatment) else 0.0
    control_rate = control_recovered / len(control) if len(control) else 0.0
    treatment_ci = wilson_interval(treatment_recovered, len(treatment))
    control_ci = wilson_interval(control_recovered, len(control))

    # Like-for-like: only cases Reclaim was permitted to act on unaided. Both policies
    # face the same population here, so the comparison isolates targeting.
    comparable = eligible[~eligible["requires_approval"]]
    comparable_baseline_recovered = 0
    comparable_baseline_revenue = 0
    for _, row in comparable.iterrows():
        if simulate_outcome(row, 0.5, scenario, rng):
            comparable_baseline_recovered += 1
            comparable_baseline_revenue += int(row["amount_paise"])

    return {
        "treatment": {
            "n": int(len(treatment)),
            "recovered": treatment_recovered,
            "rate": round(treatment_rate, 4),
            "rate_ci95": [round(treatment_ci[0], 4), round(treatment_ci[1], 4)],
            "revenue_paise": treatment_revenue,
        },
        "control": {
            "n": int(len(control)),
            "recovered": control_recovered,
            "rate": round(control_rate, 4),
            "rate_ci95": [round(control_ci[0], 4), round(control_ci[1], 4)],
            "revenue_paise": control_revenue,
        },
        "uplift_pp": round((treatment_rate - control_rate) * 100, 2),
        # True when the arms' intervals overlap: the uplift is not distinguishable
        # from noise at this sample size, and saying so is the honest reading.
        "uplift_ci_overlaps": bool(treatment_ci[0] <= control_ci[1] and control_ci[0] <= treatment_ci[1]),
        "baseline_contact_everyone": {
            "n": int(len(eligible)),
            "recovered": baseline_recovered,
            "rate": round(baseline_recovered / len(eligible), 4) if len(eligible) else 0.0,
            "revenue_paise": baseline_revenue,
            "contacts_sent": int(len(eligible)),
        },
        "like_for_like": {
            "_note": (
                "Restricted to cases Reclaim may act on without merchant approval, so both "
                "policies face the same population. The unrestricted baseline above collects "
                "revenue Reclaim deliberately withholds pending a human decision, which makes "
                "its revenue column incomparable rather than better."
            ),
            "n": int(len(comparable)),
            "baseline_recovered": comparable_baseline_recovered,
            "baseline_revenue_paise": comparable_baseline_revenue,
            "baseline_contacts": int(len(comparable)),
            "reclaim_recovered": treatment_recovered,
            "reclaim_revenue_paise": treatment_revenue,
            "reclaim_contacts": int(len(treatment)),
        },
        "efficiency": {
            "reclaim_contacts": int(len(treatment)),
            "baseline_contacts": int(len(eligible)),
            "contacts_saved": int(len(eligible) - len(treatment)),
            "reclaim_contacts_per_recovery": (
                round(len(treatment) / treatment_recovered, 2) if treatment_recovered else None
            ),
            "baseline_contacts_per_recovery": (
                round(len(eligible) / baseline_recovered, 2) if baseline_recovered else None
            ),
        },
    }


def main() -> None:
    df = load()
    print(f"evaluating {len(df)} recovery cases\n")

    verified = verified_metrics(df)
    print("VERIFIED")
    ambiguous = verified["diagnosis"]["ambiguous_subset"]
    print(f"  diagnosis accuracy      {verified['diagnosis']['accuracy']:.1%}  (near-tautological, see caveat)")
    if ambiguous["accuracy"] is not None:
        print(f"  ambiguous-case accuracy {ambiguous['accuracy']:.1%}  (n={ambiguous['n']}, the real number)")
    violations = sum(verified["policy_violations"].values())
    print(f"  policy violations       {violations}")
    print(f"  contacted               {verified['coverage']['contacted']} of {verified['coverage']['cases']}")

    simulated = {scenario: simulated_metrics(df, scenario) for scenario in SENSITIVITY}

    print("\nSIMULATED (depends on RESPONSE_MODEL.md)")
    for scenario, result in simulated.items():
        flag = "  [overlapping CIs]" if result["uplift_ci_overlaps"] else ""
        print(
            f"  {scenario:12} treatment {result['treatment']['rate']:.1%}  "
            f"control {result['control']['rate']:.1%}  "
            f"uplift {result['uplift_pp']:+.1f}pp{flag}"
        )

    central = simulated["central"]
    report = {
        "_comment": (
            "Generated by evaluation/evaluate.py. VERIFIED metrics are measured against "
            "ground truth. SIMULATED metrics depend on the assumptions in RESPONSE_MODEL.md "
            "and must always be reported as simulated, with the control arm and bounds."
        ),
        "verified": verified,
        "simulated": {
            "response_model": "RESPONSE_MODEL.md",
            "scenarios": simulated,
            "caveats": [
                "Recovery outcomes are drawn from a documented response model, not observed.",
                f"The control arm holds {central['control']['n']} cases; at that size the "
                "confidence interval on its rate is wide.",
                "Uplift should be read as directional under stated assumptions, not as a "
                "revenue forecast.",
            ],
        },
    }
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
