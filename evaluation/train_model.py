"""Train the recovery-propensity model.

Predicts: given that we contact this customer, will they complete payment?

Deliberately a logistic regression. The features are few and the relationships are
close to monotone, so a gradient-boosted anything would buy a fraction of a point of
AUC at the cost of being unable to say why it made a call. Reclaim has to explain
every decision to a merchant, and coefficients are an explanation.

The model is trained here and exported as JSON coefficients that TypeScript scores
directly -- no Python service in the request path.

    python evaluation/train_model.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "data" / "generated"
OUT = ROOT / "evaluation" / "model.json"

sys.path.insert(0, str(ROOT / "data" / "generator"))

# Diagnoses the planner will never contact a customer about, so there is nothing to
# predict for them. Training on rows we would never act on teaches the model about a
# population it will never see.
NEVER_CONTACTED = {"SUSPICIOUS_ACTIVITY", "MERCHANT_CONFIGURATION_ERROR", "DUPLICATE_OR_REPEAT_ATTEMPT"}

# The raw counts and their threshold indicators (has_prior_success,
# many_prior_failures) are collinear: including both split each effect and produced a
# NEGATIVE coefficient on has_prior_success alongside a positive one on prior_success,
# which contradicts RESPONSE_MODEL.md. Keeping only the counts leaves coefficients that
# can be read aloud to a merchant without apology.
FEATURES = [
    "log_amount",
    "prior_success",
    "prior_failure",
    "is_temporary_failure",
    "is_insufficient_funds",
    "is_expired_method",
    "is_abandonment",
    "attempt_number",
    "is_upi",
    "is_card",
]


def build_frame() -> pd.DataFrame:
    attempts = pd.read_csv(GENERATED / "payment_attempts.csv")
    customers = pd.read_csv(GENERATED / "customers.csv")
    truth = pd.read_csv(GENERATED / "ground_truth.csv")

    df = attempts[attempts["status"] != "SUCCESS"].merge(
        customers[["id", "prior_success_count", "prior_failure_count"]],
        left_on="customer_id", right_on="id", suffixes=("", "_cus"),
    ).merge(truth, left_on="id", right_on="attempt_id")

    df = df[~df["true_diagnosis"].isin(NEVER_CONTACTED)].copy()

    # The label is the outcome under the treatment the planner would actually choose.
    # Using "recovers_if_contacted_1h" for every row would train the model on a policy
    # we do not run -- the planner waits 12h after a low-balance decline, precisely
    # because contacting immediately does not work.
    label_column = np.where(
        df["true_diagnosis"] == "INSUFFICIENT_FUNDS",
        df["recovers_if_contacted_24h"],
        df["recovers_if_contacted_6h"],
    )
    df["label"] = label_column.astype(int)

    df["log_amount"] = np.log10(df["amount_paise"].clip(lower=1))
    df["prior_success"] = df["prior_success_count"]
    df["prior_failure"] = df["prior_failure_count"]
    df["has_prior_success"] = (df["prior_success_count"] >= 1).astype(int)
    df["many_prior_failures"] = (df["prior_failure_count"] >= 3).astype(int)
    df["is_temporary_failure"] = (df["true_diagnosis"] == "TEMPORARY_BANK_OR_NETWORK_FAILURE").astype(int)
    df["is_insufficient_funds"] = (df["true_diagnosis"] == "INSUFFICIENT_FUNDS").astype(int)
    df["is_expired_method"] = (df["true_diagnosis"] == "EXPIRED_PAYMENT_METHOD").astype(int)
    df["is_abandonment"] = (df["true_diagnosis"] == "USER_ABANDONMENT").astype(int)
    df["is_upi"] = (df["payment_method"] == "upi").astype(int)
    df["is_card"] = (df["payment_method"] == "card").astype(int)

    return df


def main() -> None:
    df = build_frame()

    train = df[df["split"] == "TRAIN"]
    validation = df[df["split"] == "VALIDATION"]
    heldout = df[df["split"] == "HELDOUT"]

    print(f"train {len(train)}  validation {len(validation)}  heldout {len(heldout)}")
    print(f"base rate: train {train['label'].mean():.3f}  heldout {heldout['label'].mean():.3f}")

    x_train, y_train = train[FEATURES].to_numpy(), train["label"].to_numpy()
    x_val, y_val = validation[FEATURES].to_numpy(), validation["label"].to_numpy()

    # Standardise so coefficients are comparable to each other, and so the exported
    # scaling can be applied identically in TypeScript.
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std[std == 0] = 1.0

    model = LogisticRegression(max_iter=2000, C=1.0)
    model.fit((x_train - mean) / std, y_train)

    # Calibrate on validation: the planner compares the score against a probability
    # floor, so a well-ordered but poorly-scaled score would silently move that
    # threshold. Calibration is what makes "15%" mean fifteen percent.
    calibrated = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calibrated.fit((x_val - mean) / std, y_val)

    def report(name: str, frame: pd.DataFrame) -> dict[str, float]:
        x = (frame[FEATURES].to_numpy() - mean) / std
        y = frame["label"].to_numpy()
        raw = model.predict_proba(x)[:, 1]
        cal = calibrated.predict_proba(x)[:, 1]
        metrics = {
            "n": int(len(frame)),
            "base_rate": float(y.mean()),
            "auc": float(roc_auc_score(y, raw)),
            "brier_raw": float(brier_score_loss(y, raw)),
            "brier_calibrated": float(brier_score_loss(y, cal)),
        }
        print(
            f"{name:11} n={metrics['n']:5}  AUC {metrics['auc']:.3f}  "
            f"Brier {metrics['brier_raw']:.4f} -> {metrics['brier_calibrated']:.4f} (calibrated)"
        )
        return metrics

    print()
    metrics = {
        "train": report("train", train),
        "validation": report("validation", validation),
        # Touched once, at the very end, and never used to choose anything.
        "heldout": report("heldout", heldout),
    }

    # Export the calibrated pipeline as plain numbers: standardisation, the linear
    # model, and the sigmoid calibrator. TypeScript reproduces this exactly.
    calibrator = calibrated.calibrated_classifiers_[0].calibrators[0]
    payload = {
        "_comment": (
            "Generated by evaluation/train_model.py. Scored in TypeScript by "
            "src/decisions/score.ts. Do not edit by hand."
        ),
        "features": FEATURES,
        "standardisation": {"mean": mean.tolist(), "std": std.tolist()},
        "coefficients": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "calibration": {"a": float(calibrator.a_), "b": float(calibrator.b_)},
        "metrics": metrics,
        "trained_on": {
            "rows": int(len(train)),
            "excluded_diagnoses": sorted(NEVER_CONTACTED),
            "label": "recovers_if_contacted, at the delay the planner would actually choose",
        },
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}")

    ordered = sorted(zip(FEATURES, model.coef_[0]), key=lambda pair: abs(pair[1]), reverse=True)
    print("\ncoefficients (standardised, largest effect first):")
    for name, weight in ordered:
        print(f"  {name:24} {weight:+.3f}")


if __name__ == "__main__":
    main()
