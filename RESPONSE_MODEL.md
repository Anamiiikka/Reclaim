# Response model — the assumptions behind every simulated number

Read this before believing any recovery figure Reclaim reports.

## Why this document exists

Reclaim runs on synthetic data. That is fine for the decision layer — a policy engine either blocks an
opted-out customer or it doesn't, and we can verify that directly. It is **not** fine for recovery outcomes.

Whether a customer would have paid *anyway*, without being contacted, is a counterfactual. On real data you
recover it with a randomised holdout. On synthetic data there is no fact of the matter at all: the outcome is
whatever the generator writes. So a claim like "Reclaim recovered ₹1.42L" is not a measurement of Reclaim —
it is a measurement of the numbers in this file.

We therefore state those numbers openly, in one place, so that anyone reading our results can see exactly what
they rest on and adjust them.

## What is assumption and what is grounded

**Every probability below is an assumption.** None is derived from Razorpay data, and none should be read as
an industry benchmark. They were chosen to be *directionally plausible* and *internally consistent* — a
temporary network failure is more recoverable than a fraud-flagged attempt, contact sooner beats contact
later — not to be accurate in absolute terms.

Where a figure influences a headline result, we report a sensitivity range alongside it (see below).

## Baseline recovery — no intervention

The probability a customer completes payment on their own, with no contact. This is the control arm, and it
is the reason uplift is meaningful at all: **treatment minus control**, not treatment alone.

| Diagnosis | Baseline recovery | Reasoning |
|---|---|---|
| `TEMPORARY_BANK_OR_NETWORK_FAILURE` | 0.22 | Customer had intent; many simply retry unprompted |
| `INSUFFICIENT_FUNDS` | 0.12 | Some retry after payday without any nudge |
| `EXPIRED_PAYMENT_METHOD` | 0.08 | Requires effort to fix; most don't return |
| `USER_ABANDONMENT` | 0.05 | Low intent by definition |
| `DUPLICATE_OR_REPEAT_ATTEMPT` | 0.15 | Often already paying by another route |
| `SUSPICIOUS_ACTIVITY` | 0.02 | Frequently not a real customer |
| `MERCHANT_CONFIGURATION_ERROR` | 0.03 | Blocked by something the customer cannot fix |
| `UNKNOWN` | 0.10 | Mixed bag, mid-range |

## Treatment uplift — when contacted

Added to the baseline when a recovery action reaches the customer. Uplift **decays with delay**, which is
what makes timing decisions matter.

| Diagnosis | Uplift, contacted ≤1h | 1–6h | 6–24h | >24h |
|---|---|---|---|---|
| `TEMPORARY_BANK_OR_NETWORK_FAILURE` | +0.38 | +0.28 | +0.15 | +0.06 |
| `INSUFFICIENT_FUNDS` | +0.06 | +0.11 | +0.18 | +0.14 |
| `EXPIRED_PAYMENT_METHOD` | +0.24 | +0.22 | +0.16 | +0.08 |
| `USER_ABANDONMENT` | +0.18 | +0.14 | +0.09 | +0.04 |
| `DUPLICATE_OR_REPEAT_ATTEMPT` | +0.02 | +0.02 | +0.01 | +0.01 |
| `SUSPICIOUS_ACTIVITY` | 0.00 | 0.00 | 0.00 | 0.00 |
| `MERCHANT_CONFIGURATION_ERROR` | 0.00 | 0.00 | 0.00 | 0.00 |
| `UNKNOWN` | +0.12 | +0.09 | +0.05 | +0.02 |

Two deliberate shapes here:

- **`INSUFFICIENT_FUNDS` peaks late, not early.** Contacting someone within an hour of a low-balance decline
  does nothing; waiting improves the odds. A system that always contacts immediately gets this wrong, and the
  model is built so that mistake is visible in the numbers.
- **`SUSPICIOUS_ACTIVITY` and `MERCHANT_CONFIGURATION_ERROR` have zero uplift.** Contacting these customers
  cannot help. Any recovery credited to them would be an artifact, so the model refuses to grant one.

## Modifiers

Applied multiplicatively to the uplift, then the total is clamped to [0, 0.95].

| Condition | Multiplier | Reasoning |
|---|---|---|
| Customer has ≥1 prior successful payment | ×1.25 | Known-good customer, established trust |
| Customer has ≥3 prior failures | ×0.70 | Pattern of non-completion |
| Order value > ₹10,000 | ×0.80 | Larger purchases get more deliberation |
| Order value < ₹500 | ×1.10 | Low friction to just pay |
| Second reminder (rather than first) | ×0.45 | Sharply diminishing returns |

The second-reminder penalty is why the policy cap of two reminders per order (G2) is not merely a courtesy
rule — a third message would be close to worthless even on these generous assumptions.

## Sensitivity

Headline results are reported across three parameter sets, because a single point estimate would imply more
precision than we have:

- **Pessimistic** — all uplifts ×0.6
- **Central** — the table above
- **Optimistic** — all uplifts ×1.4

If a conclusion only holds under *optimistic*, we say so rather than quoting the central figure alone.

## What this model deliberately does not do

- It does not model channel (SMS vs email vs push). Delivery is out of scope, so channel effects would be
  invented detail on top of invented detail.
- It does not model competitor or cart-substitution effects.
- It does not vary by merchant category, city, or time of day. Those would add realism in appearance while
  adding nothing verifiable.

## The honest summary

Reclaim's decision layer is real and independently verifiable. Its **recovery numbers are a simulation whose
assumptions are written above**, and they should be read as "given this response model, the policy produces
this much uplift over an uncontacted control" — never as "this system recovers X rupees."

The parameters live in `data/generator/response_model.py`, which is the single source of truth; this document
and that file must agree, and a test asserts it.
