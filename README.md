# Reclaim

**Safe, explainable revenue recovery for failed payments.**

Razorpay AI Buildathon — Track 3: AI Revenue Recovery.

---

## What this is

When a payment fails, most systems do one of two things: retry blindly, or blast a reminder to everyone.
Both waste money and annoy customers.

Reclaim diagnoses *why* each payment failed, decides whether recovery is worth attempting, picks one bounded
action, and stops when continuing would harm the customer or the merchant. Every decision is logged with
enough state to be replayed and reproduced exactly.

## What we claim, and what we don't

This distinction is deliberate and load-bearing.

**Verified** — measured against ground truth we control honestly:

- Diagnosis accuracy against labelled failure causes
- Policy violations across the full case set (target: zero)
- Suppression correctness (opted-out, already-paid, duplicate, suspicious)
- Decision reproducibility under replay
- Escalation rate and decision latency

**Simulated** — depends on the documented assumptions in [`RESPONSE_MODEL.md`](./RESPONSE_MODEL.md):

- Recovery rate, revenue recovered, uplift over baseline

Recovery outcomes cannot be genuinely measured on synthetic data — whether a customer *would* have paid
without contact is a counterfactual our generator writes, not something our system discovers. So those
figures are labelled simulated wherever they appear, reported with sensitivity bounds, and compared against
a randomised control arm that receives no intervention.

We lead with the numbers we can defend.

## Status

Phase 0 — scaffolding. See the phase plan for what lands when.

## Setup

```bash
cp .env.example .env    # fill in your Razorpay TEST-mode keys and Neon URL
npm install
```

Razorpay test keys: dashboard.razorpay.com → **Test Mode** toggle → Account & Settings → API Keys.
Free, no KYC. A valid test key id starts with `rzp_test_`. Never put a live key in this project.

Reclaim runs against the **simulated** payment client by default (`PAYMENT_CLIENT=simulated`), so it works
with no keys at all. Set `PAYMENT_CLIENT=razorpay` to exercise real test-mode Orders and Payment Links.

## Licence

MIT
