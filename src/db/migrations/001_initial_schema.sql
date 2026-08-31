-- Reclaim — initial schema
-- Money is stored in paise (integer) throughout. Never floats: ₹1,499.00 is 149900.
-- Every table that participates in a decision carries enough state to replay it.

-- ---------------------------------------------------------------- enums

CREATE TYPE failure_diagnosis AS ENUM (
  'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  'INSUFFICIENT_FUNDS',
  'EXPIRED_PAYMENT_METHOD',
  'USER_ABANDONMENT',
  'DUPLICATE_OR_REPEAT_ATTEMPT',
  'SUSPICIOUS_ACTIVITY',
  'MERCHANT_CONFIGURATION_ERROR',
  'UNKNOWN'
);

CREATE TYPE attempt_status AS ENUM ('SUCCESS', 'FAILED', 'ABANDONED', 'PENDING');

CREATE TYPE case_status AS ENUM (
  'DETECTED',        -- found by detection, not yet decided
  'DECIDED',         -- action planned
  'ACTION_PENDING',  -- action scheduled, not yet executed
  'ACTION_SENT',     -- action executed
  'RECOVERED',       -- customer paid
  'EXPIRED',         -- 72h window closed without recovery
  'SUPPRESSED',      -- policy blocked all action
  'ESCALATED'        -- handed to a human
);

CREATE TYPE action_type AS ENUM (
  'SEND_PAYMENT_LINK',
  'SUGGEST_ALTERNATE_METHOD',
  'DELAYED_RETRY_PROMPT',
  'MERCHANT_ALERT',
  'HUMAN_ESCALATION',
  'NO_ACTION'
);

CREATE TYPE action_status AS ENUM (
  'SCHEDULED',
  'EXECUTING',
  'SENT',
  'PENDING_RETRY',   -- payment API failed; exactly one retry permitted
  'FAILED',
  'CANCELLED'        -- stop rule fired before execution
);

-- Which experimental arm a case belongs to. TREATMENT receives intervention;
-- CONTROL is deliberately withheld so recovery uplift is a difference between
-- arms rather than an unfalsifiable absolute claim.
CREATE TYPE experiment_arm AS ENUM ('TREATMENT', 'CONTROL');

CREATE TYPE data_split AS ENUM ('TRAIN', 'VALIDATION', 'HELDOUT');

-- ---------------------------------------------------------------- core entities

CREATE TABLE merchants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  -- Merchant-configurable ceiling above which actions need human approval (G5).
  approval_threshold_paise BIGINT NOT NULL DEFAULT 1000000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  city            TEXT NOT NULL,
  -- Denormalised history, as it would be available at decision time.
  prior_success_count INT NOT NULL DEFAULT 0,
  prior_failure_count INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Separate from customers because consent is a distinct concern with its own
-- lifecycle, and G1 checks it on every single decision.
CREATE TABLE customer_preferences (
  customer_id     TEXT PRIMARY KEY REFERENCES customers(id),
  is_opted_out    BOOLEAN NOT NULL DEFAULT false,
  preferred_method TEXT,
  opted_out_at    TIMESTAMPTZ
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
  currency        TEXT NOT NULL DEFAULT 'INR',
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE payment_attempts (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
  payment_method  TEXT NOT NULL,
  attempt_number  INT NOT NULL DEFAULT 1,
  status          attempt_status NOT NULL,
  -- Raw gateway code; the diagnosis engine maps this deterministically.
  failure_code    TEXT,
  failure_message TEXT,
  checkout_stage  TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL,

  -- Ground truth, written by the generator. GROUND TRUTH IS NEVER READ BY THE
  -- DECISION PATH — only by the evaluation harness. See RESPONSE_MODEL.md.
  true_diagnosis  failure_diagnosis,
  split           data_split NOT NULL DEFAULT 'TRAIN',

  CONSTRAINT failed_attempts_have_a_code
    CHECK (status <> 'FAILED' OR failure_code IS NOT NULL)
);

CREATE INDEX idx_attempts_status ON payment_attempts(status);
CREATE INDEX idx_attempts_customer ON payment_attempts(customer_id);
CREATE INDEX idx_attempts_order ON payment_attempts(order_id);
CREATE INDEX idx_attempts_split ON payment_attempts(split);

CREATE TABLE checkout_sessions (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  last_stage      TEXT NOT NULL,
  abandoned_at    TIMESTAMPTZ,
  completed       BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------- recovery

CREATE TABLE recovery_cases (
  id              TEXT PRIMARY KEY,
  payment_attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  amount_at_risk_paise BIGINT NOT NULL,

  status          case_status NOT NULL DEFAULT 'DETECTED',
  diagnosis       failure_diagnosis,
  diagnosis_confidence NUMERIC(4,3),
  recovery_probability NUMERIC(4,3),

  arm             experiment_arm NOT NULL DEFAULT 'TREATMENT',
  split           data_split NOT NULL DEFAULT 'TRAIN',

  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- G8: no recovery activity permitted after this instant.
  expires_at      TIMESTAMPTZ NOT NULL,
  resolved_at     TIMESTAMPTZ,

  recovered_amount_paise BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT one_case_per_attempt UNIQUE (payment_attempt_id),
  CONSTRAINT recovered_within_risk CHECK (recovered_amount_paise <= amount_at_risk_paise)
);

CREATE INDEX idx_cases_status ON recovery_cases(status);
CREATE INDEX idx_cases_customer ON recovery_cases(customer_id);
CREATE INDEX idx_cases_split_arm ON recovery_cases(split, arm);

CREATE TABLE recovery_actions (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES recovery_cases(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  action          action_type NOT NULL,
  status          action_status NOT NULL DEFAULT 'SCHEDULED',

  -- G7: the uniqueness constraint below is the actual enforcement mechanism for
  -- idempotency. Replaying an event cannot create a second action.
  idempotency_key TEXT NOT NULL,

  attempt_count   INT NOT NULL DEFAULT 0,
  payment_link_id TEXT,
  payment_link_url TEXT,

  scheduled_for   TIMESTAMPTZ NOT NULL,
  executed_at     TIMESTAMPTZ,
  last_error      TEXT,

  CONSTRAINT unique_idempotency_key UNIQUE (idempotency_key),
  -- One retry maximum after an API failure; beyond that we escalate.
  CONSTRAINT at_most_two_attempts CHECK (attempt_count <= 2)
);

CREATE INDEX idx_actions_case ON recovery_actions(case_id);
CREATE INDEX idx_actions_customer ON recovery_actions(customer_id);

-- Durable delayed-job queue. A Postgres table with run_after replaces Redis/BullMQ:
-- fewer moving parts, and scheduling state is visible in the same DB the dashboard reads.
CREATE TABLE scheduled_actions (
  id              BIGSERIAL PRIMARY KEY,
  action_id       TEXT NOT NULL REFERENCES recovery_actions(id),
  run_after       TIMESTAMPTZ NOT NULL,
  -- Set while a worker holds the row, so a second worker cannot double-execute.
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  completed_at    TIMESTAMPTZ,
  CONSTRAINT one_job_per_action UNIQUE (action_id)
);

CREATE INDEX idx_scheduled_runnable
  ON scheduled_actions(run_after)
  WHERE completed_at IS NULL;

CREATE TABLE action_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  action_id       TEXT NOT NULL REFERENCES recovery_actions(id),
  case_id         TEXT NOT NULL REFERENCES recovery_cases(id),
  customer_paid   BOOLEAN NOT NULL,
  paid_at         TIMESTAMPTZ,
  amount_paise    BIGINT NOT NULL DEFAULT 0,
  -- TRUE when this outcome came from the simulated response model rather than a
  -- real observed payment. Surfaced in the UI so no figure is silently synthetic.
  is_simulated    BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_outcomes_case ON action_outcomes(case_id);

-- ---------------------------------------------------------------- audit

-- Append-only. Captures enough input state that replaying a decision must produce
-- byte-identical output (FR8). Designed once, now, because retrofitting is expensive.
CREATE TABLE audit_events (
  id              BIGSERIAL PRIMARY KEY,
  case_id         TEXT REFERENCES recovery_cases(id),
  action_id       TEXT REFERENCES recovery_actions(id),
  event_type      TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The exact decision inputs, serialised. Replay reads this, not live tables,
  -- so a replay is unaffected by later state changes.
  decision_input  JSONB,
  decision_output JSONB,
  -- Ordered list of every policy check with its verdict.
  policy_checks   JSONB,
  -- Human-readable, assembled from structured data above — never free-form.
  explanation     TEXT,
  actor           TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX idx_audit_case ON audit_events(case_id, occurred_at);
CREATE INDEX idx_audit_type ON audit_events(event_type);
