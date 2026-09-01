# Five-minute pitch — shot list

Everything below is on screen in the repo or the dashboard. No slide claims a number the
evaluation report does not contain.

---

## 0:00–0:35 · The problem

> "When a payment fails, most recovery systems do one of two things: retry blindly, or send a
> reminder to everyone. Both waste money and annoy customers. And nobody can tell you afterwards
> why any particular customer was contacted."

**On screen:** the Overview, top row. ₹1.13 Cr at risk across 1,500 failed payments.

---

## 0:35–1:15 · What Reclaim does

> "Reclaim diagnoses why each payment failed, decides whether recovery is worth attempting, picks
> one bounded action, and stops when continuing would harm the customer or the merchant."

**On screen:** the revenue-at-risk chart. Point at the grey bars.

> "The grey bars are causes Reclaim never contacts a customer about — fraud signals, and
> merchant-side misconfiguration the customer cannot fix. Not contacting is a decision too."

---

## 1:15–2:20 · One case, end to end

**On screen:** `#/case/rcv_00002` — a real ₹565 expired-card failure.

> "Gateway code `INVALID_CARD`. Diagnosed as an expired payment method, confidence 0.99 — that is
> a deterministic lookup, not a guess. The model estimates a 29% chance of recovery if we contact."

Scroll to the policy panel.

> "All ten policy checks ran, and all ten are shown. The engine never stops at the first block,
> because a merchant asking 'why wasn't this customer contacted?' deserves the whole picture, not
> whichever rule happened to fire first."

Scroll to the timeline.

> "The action was to suggest an alternate method after fifteen minutes — the stored card cannot
> succeed, so re-presenting it would fail again. Every step is recorded with the inputs that
> produced it."

---

## 2:20–3:05 · When the payment API fails

**On screen:** `#/case/rcv_00366`. Run `npm run fail-demo` beforehand.

> "This is what happens when Razorpay's API fails. Gateway timeout. Reclaim retried exactly once,
> under the same idempotency key — so if the first call had actually succeeded, the provider would
> have returned the existing link rather than making a second one. It failed again, so the case
> escalated to a human."

Point at the actions row.

> "Two attempts, no payment link, and the audit trail says it explicitly: no customer was
> contacted. That is the property this system is built to guarantee — an API failure must never
> mean a customer gets two messages."

Optional, if pacing allows: `npm run verify-replay`.

> "And every one of the 1,500 decisions replays byte-identically from its stored inputs."

---

## 3:05–4:10 · Measured results

**On screen:** the Evaluation tab.

> "Two tiers, and the split is the point."

> "Verified: zero policy violations across 1,500 cases and six rules. Every decision reproducible.
> These hold regardless of what any customer would have done."

Point at the diagnosis caveat.

> "Overall diagnosis accuracy is 99.8%, and I want to be clear that this is not a result. My
> generator writes a gateway code and my engine maps that same code back through the same table.
> That is arithmetic, not inference. The number worth defending is 92.5% on the forty cases where
> the code is unrecognised and the engine actually has to guess. Small sample, and I say so."

Scroll to simulated.

> "Recovery outcomes cannot be measured on synthetic data — whether a customer would have paid
> anyway is a counterfactual my generator writes. So there is a randomised control arm that
> receives no contact, and three sensitivity scenarios. Uplift is between 17 and 41 points, and
> the confidence intervals do not overlap in any of them."

Scroll to the baseline.

> "And here is the number that does not flatter us. Contacting everyone recovers 13% more revenue
> than Reclaim, by sending 19% more messages. That is a trade-off, not a defeat — and the floor
> that produces it is one configurable threshold. What Reclaim gives a merchant is the ability to
> make that choice deliberately and see what it costs."

---

## 4:10–4:45 · Architecture

**On screen:** the README architecture diagram.

> "Python trains the model and runs the evaluation. TypeScript makes every decision. The policy
> engine is pure — no database, no clock, no network — which is what makes replay possible."

> "No Redis: a Postgres table with a `run_after` column gives durable delayed jobs in fifty lines.
> No Python service in the request path: a logistic regression is a dot product, so the
> coefficients are exported as JSON and scored in TypeScript, with a parity test asserting it
> matches scikit-learn to six decimals. And no LLM anywhere in the money path."

---

## 4:45–5:00 · Close

> "Reclaim does not just find lost revenue. It decides what is safe to do about it, proves it did
> not cross a line, and is honest about which of its numbers are measurements and which are
> simulations."

**On screen:** the Overview, back on the zero-violations card.

---

## Before recording

```bash
npm test && pytest data/ evaluation/     # 149 green
npm run detect                            # fresh decisions
npm run fail-demo                         # so rcv_00366 shows the failure path
npm run eval                              # report matches what is on screen
npx tsx src/api/server.ts                 # :3000
cd web && npm run dev                     # :5173
```

Have `#/case/rcv_00002` and `#/case/rcv_00366` open in tabs. Both are deep-linkable.
