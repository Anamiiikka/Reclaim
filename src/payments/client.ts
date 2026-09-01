/**
 * Payment client interface.
 *
 * Two implementations satisfy this: a simulator and the real Razorpay test-mode API.
 * The split exists for two reasons, and only one of them is about missing keys.
 *
 * The durable reason: a recorded demo has to show what happens when the payment API
 * fails — timeout, then one retry under an idempotency key, then escalation, with no
 * duplicate customer contact. You cannot ask a real API to fail on cue. The simulator
 * can, deterministically, which makes that failure path testable and demonstrable.
 */

/** A payment link the customer can use to complete a failed payment. */
export interface PaymentLink {
  readonly id: string;
  readonly url: string;
  readonly amountPaise: number;
  readonly expiresAt: string;
}

export interface CreateLinkRequest {
  readonly caseId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountPaise: number;
  readonly description: string;
  /**
   * Passed to the provider so a retried request cannot create a second link.
   * The database unique constraint is the real enforcement; this is defence in depth
   * for the case where our write succeeded but the response never reached us.
   */
  readonly idempotencyKey: string;
}

/**
 * Why a payment-API call failed.
 *
 * The distinction that matters is `retryable`. A timeout may have succeeded on the
 * provider's side, so retrying without an idempotency key risks a duplicate link —
 * and the customer receiving two messages. A validation error will never succeed, so
 * retrying only wastes the case's remaining window.
 */
export class PaymentClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentClientError';
  }
}

export interface PaymentClient {
  readonly name: string;
  createPaymentLink(request: CreateLinkRequest): Promise<PaymentLink>;
  /** Whether the provider is reachable. Used at startup so a demo fails loudly, not mid-run. */
  healthCheck(): Promise<boolean>;
}
