/**
 * Razorpay test-mode payment client.
 *
 * Talks to the Payment Links API over plain HTTP rather than through the SDK: one
 * fewer dependency, and the request/response contract stays visible in the code.
 *
 * Test mode only. A live key is rejected at construction — this project has no
 * business touching real money, and an accidental live key would move it.
 */

import { PaymentClientError } from './client.js';
import type { CreateLinkRequest, PaymentClient, PaymentLink } from './client.js';

const API_BASE = 'https://api.razorpay.com/v1';

/** Razorpay's error envelope. */
interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string };
}

interface PaymentLinkResponse {
  id: string;
  short_url: string;
  amount: number;
  expire_by?: number;
}

export interface RazorpayOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly linkValidityHours?: number;
  readonly timeoutMs?: number;
  /** Minimum gap between outgoing requests, to stay under the provider's rate limit. */
  readonly minIntervalMs?: number;
}

export class RazorpayPaymentClient implements PaymentClient {
  readonly name = 'razorpay';

  private readonly auth: string;
  private readonly linkValidityHours: number;
  private readonly timeoutMs: number;

  /**
   * Client-side throttle.
   *
   * Running the pipeline against the real test API returned 429 on 796 of 997 calls
   * even at concurrency 4. Razorpay does not publish a test-mode rate limit, so this
   * paces requests to a rate that empirically does not trip it. Backpressure is our
   * problem to manage, not the provider's: the alternative is escalating hundreds of
   * cases to humans because the API was busy, which is not a real failure.
   */
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(options: RazorpayOptions) {
    if (!options.keyId.startsWith('rzp_test_')) {
      // Deliberately fatal. Reclaim is a buildathon project with synthetic customers;
      // there is no scenario where it should hold a live key.
      throw new Error(
        `refusing to start with a non-test Razorpay key (got "${options.keyId.slice(0, 9)}..."). ` +
          'Reclaim only runs against test mode.',
      );
    }
    this.auth = Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64');
    this.linkValidityHours = options.linkValidityHours ?? 24;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.minIntervalMs = options.minIntervalMs ?? 120;
  }

  async createPaymentLink(request: CreateLinkRequest): Promise<PaymentLink> {
    const expireBy = Math.floor(Date.now() / 1000) + this.linkValidityHours * 3600;

    const body = {
      amount: request.amountPaise,
      currency: 'INR',
      description: request.description,
      // Razorpay requires expire_by to be at least 15 minutes out.
      expire_by: expireBy,
      reference_id: request.idempotencyKey,
      // Reclaim simulates delivery; we only need the link itself.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        reclaim_case_id: request.caseId,
        reclaim_order_id: request.orderId,
      },
    };

    const response = await this.post('/payment_links', body, request.idempotencyKey);
    return {
      id: response.id,
      url: response.short_url,
      amountPaise: response.amount,
      expiresAt: new Date((response.expire_by ?? expireBy) * 1000).toISOString(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Cheapest authenticated read: if credentials are wrong this returns 401.
      const response = await this.fetchWithTimeout(`${API_BASE}/payments?count=1`, {
        method: 'GET',
        headers: { Authorization: `Basic ${this.auth}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async post(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<PaymentLinkResponse> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.auth}`,
          'Content-Type': 'application/json',
          // Razorpay keys idempotency off reference_id for payment links; this header
          // is harmless and helps if that changes.
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // Network failure or timeout. Retryable, but the provider may already have
      // created the link, so a retry must reuse the same reference_id.
      throw new PaymentClientError(
        `request to ${path} failed: ${(cause as Error).message}`,
        'NETWORK_ERROR',
        true,
      );
    }

    if (response.ok) {
      return (await response.json()) as PaymentLinkResponse;
    }

    const payload = (await response.json().catch(() => ({}))) as RazorpayErrorBody;
    const description = payload.error?.description ?? response.statusText;
    // Prefer the HTTP status for the two cases callers branch on. Razorpay returns
    // code "BAD_REQUEST_ERROR" in the body even for a 429, so trusting the body alone
    // made rate limits indistinguishable from validation errors.
    const code =
      response.status === 429
        ? 'RATE_LIMITED'
        : response.status >= 500
          ? 'SERVER_ERROR'
          : (payload.error?.code ?? `HTTP_${response.status}`);

    // A duplicate reference_id means we already created this link. That is the
    // idempotency guarantee working, not a failure — but Razorpay reports it as a
    // 400, so it must not be retried.
    const isDuplicate = description.toLowerCase().includes('reference_id');

    throw new PaymentClientError(
      `Razorpay ${response.status}: ${description}`,
      code,
      // 5xx and 429 are worth retrying; 4xx generally is not.
      !isDuplicate && (response.status >= 500 || response.status === 429),
    );
  }

  /** Wait until this client's next permitted request slot. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    await this.throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
