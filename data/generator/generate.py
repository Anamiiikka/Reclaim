"""Generate Reclaim's synthetic dataset.

Deterministic: the same seed always produces byte-identical output. That property is
tested, and it is what makes every downstream evaluation reproducible.

Writes CSVs to data/generated/. Load them with load.py.
"""

from __future__ import annotations

import argparse
import csv
import random
from dataclasses import dataclass, asdict, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

from response_model import ResponseContext, recovery_probability

OUT_DIR = Path(__file__).resolve().parents[1] / "generated"

CITIES = ["Bengaluru", "Mumbai", "Delhi", "Hyderabad", "Chennai", "Pune", "Kolkata", "Jaipur"]
CATEGORIES = ["fashion", "electronics", "grocery", "services", "education", "travel"]
METHODS = ["upi", "card", "netbanking", "wallet"]

# Gateway failure codes, and the diagnosis each one deterministically implies.
# The decision engine reads only the code; true_diagnosis exists solely so the
# evaluation harness can score the mapping.
FAILURE_CODES = {
    "GATEWAY_TIMEOUT":        "TEMPORARY_BANK_OR_NETWORK_FAILURE",
    "ISSUER_UNAVAILABLE":     "TEMPORARY_BANK_OR_NETWORK_FAILURE",
    "NETWORK_ERROR":          "TEMPORARY_BANK_OR_NETWORK_FAILURE",
    "INSUFFICIENT_FUNDS":     "INSUFFICIENT_FUNDS",
    "CARD_EXPIRED":           "EXPIRED_PAYMENT_METHOD",
    "INVALID_CARD":           "EXPIRED_PAYMENT_METHOD",
    "USER_DROPPED":           "USER_ABANDONMENT",
    "DUPLICATE_ATTEMPT":      "DUPLICATE_OR_REPEAT_ATTEMPT",
    "RISK_BLOCKED":           "SUSPICIOUS_ACTIVITY",
    "VELOCITY_EXCEEDED":      "SUSPICIOUS_ACTIVITY",
    "MERCHANT_KEY_INVALID":   "MERCHANT_CONFIGURATION_ERROR",
    "CURRENCY_UNSUPPORTED":   "MERCHANT_CONFIGURATION_ERROR",
    # Deliberately unrecognised codes: exercise the UNKNOWN fallback path.
    # These are real strings, not empty — a FAILED attempt always carries some
    # code (the DB enforces it); the point is that we cannot map it to a cause.
    "UNSPECIFIED_DECLINE":    "UNKNOWN",
    "DECLINED_BY_BANK":       "UNKNOWN",
}

# Target composition. Roughly 70% succeed; the rest is the recovery problem.
MIX = [
    ("SUCCESS", None, 3500),
    ("FAILED", "TEMPORARY_BANK_OR_NETWORK_FAILURE", 450),
    ("FAILED", "INSUFFICIENT_FUNDS", 250),
    ("ABANDONED", "USER_ABANDONMENT", 350),
    ("FAILED", "EXPIRED_PAYMENT_METHOD", 150),
    ("FAILED", "MERCHANT_CONFIGURATION_ERROR", 100),
    ("FAILED", "SUSPICIOUS_ACTIVITY", 60),
    ("FAILED", "DUPLICATE_OR_REPEAT_ATTEMPT", 100),
    ("FAILED", "UNKNOWN", 40),
]

CODES_BY_DIAGNOSIS: dict[str, list[str]] = {}
for _code, _diag in FAILURE_CODES.items():
    CODES_BY_DIAGNOSIS.setdefault(_diag, []).append(_code)


@dataclass
class Merchant:
    id: str
    name: str
    category: str
    approval_threshold_paise: int


@dataclass
class Customer:
    id: str
    merchant_id: str
    city: str
    prior_success_count: int
    prior_failure_count: int


@dataclass
class Preference:
    customer_id: str
    is_opted_out: bool
    preferred_method: str
    opted_out_at: str


@dataclass
class Order:
    id: str
    merchant_id: str
    customer_id: str
    amount_paise: int
    currency: str
    created_at: str


@dataclass
class Attempt:
    id: str
    order_id: str
    customer_id: str
    merchant_id: str
    amount_paise: int
    payment_method: str
    attempt_number: int
    status: str
    failure_code: str
    failure_message: str
    checkout_stage: str
    attempted_at: str
    true_diagnosis: str
    split: str


@dataclass
class GroundTruth:
    """Simulated outcomes, kept in a separate file from the data itself.

    The decision path must never read this. Keeping it out of attempts.csv makes
    accidental leakage into a feature obvious in review.
    """
    attempt_id: str
    baseline_recovers: bool          # would pay with no contact (control outcome)
    recovers_if_contacted_1h: bool
    recovers_if_contacted_6h: bool
    recovers_if_contacted_24h: bool
    recovers_if_contacted_late: bool


def amount_for(rng: random.Random) -> int:
    """Long-tailed order values in paise: mostly small, occasionally large."""
    r = rng.random()
    if r < 0.55:
        return rng.randrange(10_000, 200_000, 100)        # Rs 100 - 2,000
    if r < 0.85:
        return rng.randrange(200_000, 1_000_000, 100)     # Rs 2,000 - 10,000
    if r < 0.97:
        return rng.randrange(1_000_000, 5_000_000, 100)   # Rs 10,000 - 50,000
    return rng.randrange(5_000_000, 10_000_000, 100)      # Rs 50,000 - 1,00,000


def generate(seed: int, n_merchants: int = 30, n_customers: int = 5000):
    rng = random.Random(seed)
    base_time = datetime(2026, 8, 1, tzinfo=timezone.utc)

    merchants = [
        Merchant(
            id=f"mer_{i:04d}",
            name=f"Merchant {i}",
            category=rng.choice(CATEGORIES),
            # Most merchants take the Rs 10,000 default; some are stricter.
            approval_threshold_paise=rng.choice([1_000_000, 1_000_000, 1_000_000, 500_000, 2_000_000]),
        )
        for i in range(n_merchants)
    ]

    customers, preferences = [], []
    for i in range(n_customers):
        merchant = rng.choice(merchants)
        successes = rng.choices([0, 1, 2, 3, 5, 8], weights=[30, 25, 18, 12, 9, 6])[0]
        failures = rng.choices([0, 1, 2, 3, 4], weights=[45, 25, 15, 10, 5])[0]
        customers.append(Customer(f"cus_{i:05d}", merchant.id, rng.choice(CITIES), successes, failures))
        # ~7% opted out. G1 must never contact these, and the evaluation checks it.
        opted_out = rng.random() < 0.07
        preferences.append(Preference(
            customer_id=f"cus_{i:05d}",
            is_opted_out=opted_out,
            preferred_method=rng.choice(METHODS),
            opted_out_at=(base_time - timedelta(days=rng.randint(1, 200))).isoformat() if opted_out else "",
        ))

    # Build the attempt plan, then shuffle so ids don't correlate with diagnosis.
    plan: list[tuple[str, str | None]] = []
    for status, diagnosis, count in MIX:
        plan.extend([(status, diagnosis)] * count)
    rng.shuffle(plan)

    orders, attempts, truths = [], [], []
    by_id = {c.id: c for c in customers}

    for i, (status, diagnosis) in enumerate(plan):
        customer = rng.choice(customers)
        merchant_id = customer.merchant_id
        amount = amount_for(rng)
        created = base_time + timedelta(minutes=rng.randint(0, 43_200))  # ~30 days

        order_id = f"ord_{i:05d}"
        orders.append(Order(order_id, merchant_id, customer.id, amount, "INR", created.isoformat()))

        if status == "SUCCESS":
            code, message, stage, attempt_no = "", "", "completed", 1
            true_diag = ""
        else:
            code = rng.choice(CODES_BY_DIAGNOSIS[diagnosis])
            message = code.replace("_", " ").lower()
            stage = "payment" if status == "FAILED" else rng.choice(["cart", "address", "payment"])
            attempt_no = rng.choices([1, 2, 3], weights=[75, 18, 7])[0]
            true_diag = diagnosis
            # ABANDONED rows carry no gateway code; the schema only requires one
            # for FAILED, and abandonment is inferred from the stalled session.
            if status == "ABANDONED":
                code, message = "", ""

        attempt_id = f"pay_{i:05d}"
        attempts.append(Attempt(
            id=attempt_id, order_id=order_id, customer_id=customer.id, merchant_id=merchant_id,
            amount_paise=amount, payment_method=rng.choice(METHODS), attempt_number=attempt_no,
            status=status, failure_code=code, failure_message=message, checkout_stage=stage,
            attempted_at=created.isoformat(), true_diagnosis=true_diag, split="TRAIN",
        ))

        if status != "SUCCESS":
            c = by_id[customer.id]
            def outcome(hours: float | None) -> bool:
                p = recovery_probability(ResponseContext(
                    diagnosis=diagnosis, hours_to_contact=hours, amount_paise=amount,
                    prior_success_count=c.prior_success_count,
                    prior_failure_count=c.prior_failure_count,
                ))
                return rng.random() < p
            truths.append(GroundTruth(
                attempt_id=attempt_id,
                baseline_recovers=outcome(None),
                recovers_if_contacted_1h=outcome(0.5),
                recovers_if_contacted_6h=outcome(3.0),
                recovers_if_contacted_24h=outcome(12.0),
                recovers_if_contacted_late=outcome(48.0),
            ))

    # Stratified split, so every diagnosis is represented in HELDOUT. Splitting on a
    # shuffled-by-diagnosis basis rather than globally avoids a rare category landing
    # entirely in TRAIN and making its heldout score undefined.
    by_diagnosis: dict[str, list[Attempt]] = {}
    for a in attempts:
        by_diagnosis.setdefault(a.true_diagnosis or "SUCCESS", []).append(a)
    for group in by_diagnosis.values():
        rng.shuffle(group)
        n = len(group)
        n_heldout, n_val = int(n * 0.20), int(n * 0.15)
        for a in group[:n_heldout]:
            a.split = "HELDOUT"
        for a in group[n_heldout:n_heldout + n_val]:
            a.split = "VALIDATION"

    return merchants, customers, preferences, orders, attempts, truths


def write_csv(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    names = [f.name for f in fields(rows[0])]
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=names)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Reclaim's synthetic dataset")
    parser.add_argument("--seed", type=int, default=20260831)
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    merchants, customers, preferences, orders, attempts, truths = generate(args.seed)

    write_csv(args.out / "merchants.csv", merchants)
    write_csv(args.out / "customers.csv", customers)
    write_csv(args.out / "customer_preferences.csv", preferences)
    write_csv(args.out / "orders.csv", orders)
    write_csv(args.out / "payment_attempts.csv", attempts)
    write_csv(args.out / "ground_truth.csv", truths)

    splits: dict[str, int] = {}
    for a in attempts:
        splits[a.split] = splits.get(a.split, 0) + 1
    recoverable = sum(1 for a in attempts if a.status != "SUCCESS")

    print(f"seed={args.seed}  ->  {args.out}")
    print(f"  merchants  {len(merchants):>6}")
    print(f"  customers  {len(customers):>6}")
    print(f"  orders     {len(orders):>6}")
    print(f"  attempts   {len(attempts):>6}   ({recoverable} recovery-eligible)")
    print(f"  splits     {dict(sorted(splits.items()))}")


if __name__ == "__main__":
    main()
