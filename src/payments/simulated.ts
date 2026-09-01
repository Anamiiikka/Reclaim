/**
 * Simulated payment client.
 *
 * Deterministic by construction: given the same idempotency key and the same failure
 * script, it behaves identically every run. That is what makes the failure-handling
 * demo reproducible on camera and testable in CI.
 */

import { createHash } from 'node:crypto';

import { PaymentClientError } from './client.js';
import type { CreateLinkRequest, PaymentClient, PaymentLink } from './client.js';

/** How a scripted call should fail. */
export type FailureMode =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'validation'; readonly detail: string }
  | { readonly kind: 'duplicate_link' };

export interface SimulatorOptions {
  /**
   * Idempotency keys that should fail, and how. Keyed rather than probabilistic so a
   * demo shows the same thing every time.
   */
  readonly failures?: ReadonlyMap<string, FailureMode>;
  /** Fail the first N calls for a key, then succeed. Models a transient outage. */
  readonly failFirstAttempts?: number;
  readonly linkValidityHours?: number;
}

export class SimulatedPaymentClient implements PaymentClient {
  readonly name = 'simulated';

  /** Links already issued, by idempotency key. Mirrors provider-side idempotency. */
  private readonly issued = new Map<string, PaymentLink>();
  private readonly attempts = new Map<string, number>();
  private readonly failures: ReadonlyMap<string, FailureMode>;
  private readonly failFirstAttempts: number;
  private readonly linkValidityHours: number;

  constructor(options: SimulatorOptions = {}) {
    this.failures = options.failures ?? new Map();
    this.failFirstAttempts = options.failFirstAttempts ?? 0;
    this.linkValidityHours = options.linkValidityHours ?? 24;
  }

  async createPaymentLink(request: CreateLinkRequest): Promise<PaymentLink> {
    const attempt = (this.attempts.get(request.idempotencyKey) ?? 0) + 1;
    this.attempts.set(request.idempotencyKey, attempt);

    // Idempotency: a repeated key returns the original link rather than making a
    // second one. This is what stops a retry from contacting the customer twice.
    const existing = this.issued.get(request.idempotencyKey);
    if (existing) return existing;

    const scripted = this.failures.get(request.idempotencyKey);
    if (scripted && attempt > this.failFirstAttempts) {
      throw toError(scripted);
    }
    if (attempt <= this.failFirstAttempts) {
      throw new PaymentClientError(
        `simulated transient failure on attempt ${attempt}`,
        'SIMULATED_TRANSIENT',
        true,
      );
    }

    // Derive the id from the idempotency key so it is stable across runs.
    const digest = createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 14);
    const link: PaymentLink = {
      id: `plink_sim_${digest}`,
      url: `https://rzp.io/i/sim_${digest}`,
      amountPaise: request.amountPaise,
      expiresAt: new Date(Date.now() + this.linkValidityHours * 3_600_000).toISOString(),
    };
    this.issued.set(request.idempotencyKey, link);
    return link;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Test helper: how many times a key was attempted, including failures. */
  attemptsFor(idempotencyKey: string): number {
    return this.attempts.get(idempotencyKey) ?? 0;
  }

  /** Test helper: how many distinct links were actually issued. */
  get issuedCount(): number {
    return this.issued.size;
  }
}

function toError(mode: FailureMode): PaymentClientError {
  switch (mode.kind) {
    case 'timeout':
      // Retryable, but only under an idempotency key: the provider may have created
      // the link before the response was lost.
      return new PaymentClientError('gateway timeout', 'GATEWAY_TIMEOUT', true);
    case 'rate_limited':
      return new PaymentClientError('rate limited', 'RATE_LIMITED', true);
    case 'validation':
      // Never retryable. Retrying only burns the case's remaining window.
      return new PaymentClientError(mode.detail, 'VALIDATION_FAILED', false);
    case 'duplicate_link':
      return new PaymentClientError('a link already exists for this order', 'DUPLICATE', false);
  }
}
