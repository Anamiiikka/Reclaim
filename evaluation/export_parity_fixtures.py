"""Export scored rows so TypeScript can prove it reproduces scikit-learn exactly.

If score.ts drifts from the trained model, every evaluation number describes a model
that is not the one making decisions. The fixture makes that impossible to miss.

    python evaluation/export_parity_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression

from train_model import FEATURES, build_frame

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "evaluation" / "parity-fixtures.json"


def main() -> None:
    df = build_frame()
    train = df[df["split"] == "TRAIN"]
    validation = df[df["split"] == "VALIDATION"]

    x_train = train[FEATURES].to_numpy()
    mean, std = x_train.mean(axis=0), x_train.std(axis=0)
    std[std == 0] = 1.0

    model = LogisticRegression(max_iter=2000, C=1.0)
    model.fit((x_train - mean) / std, train["label"].to_numpy())
    calibrated = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
    calibrated.fit((validation[FEATURES].to_numpy() - mean) / std, validation["label"].to_numpy())

    # A spread of real heldout rows, not hand-picked ones.
    sample = df[df["split"] == "HELDOUT"].head(40)
    probabilities = calibrated.predict_proba((sample[FEATURES].to_numpy() - mean) / std)[:, 1]

    cases = [
        {
            "input": {
                "amountPaise": int(row.amount_paise),
                "priorSuccessCount": int(row.prior_success_count),
                "priorFailureCount": int(row.prior_failure_count),
                "diagnosis": row.true_diagnosis,
                "attemptNumber": int(row.attempt_number),
                "paymentMethod": row.payment_method,
            },
            "expected": float(probability),
        }
        for row, probability in zip(sample.itertuples(), probabilities)
    ]

    OUT.write_text(json.dumps({"cases": cases}, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} parity fixtures to {OUT.relative_to(ROOT)}")
    print(f"probability range: {probabilities.min():.4f} - {probabilities.max():.4f}")


if __name__ == "__main__":
    main()
