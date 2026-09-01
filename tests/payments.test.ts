/**
 * Payment client tests.
 *
 * The idempotency behaviour is the point: a retried call must return the original
 * link rather than creating a second one, because a second link means a second
 * message to the customer.
 */

import { describe, expect, it } from 'vitest';

import { PaymentClientError, SimulatedPaymentClient, createPaymentClient } from '../src/payments/index.js';
import { RazorpayPaymentClient } from '../src/payments/razorpay.js';
import { idempotencyKeyFor } from '../src/actions/execute.js';

function request(idempotencyKey = 'idem_test_001') {
  return {
    caseId: 'rcv_0001',
    orderId: 'ord_0001',
    customerId: 'cus_0001',
    amountPaise: 149_900,
    description: 'Complete your payment',
    idempotencyKey,
  };
}

describe('idempotency keys', () => {
  it('are stable for the same logical action', () => {
    // A crash mid-run must not produce a different key on restart, or the unique
    // constraint would not recognise the repeat.
    expect(idempotencyKeyFor('rcv_1', 'SEND_PAYMENT_LINK', 1))
      .toBe(idempotencyKeyFor('rcv_1', 'SEND_PAYMENT_LINK', 1));
  });

  it('differ across cases, actions and sequence numbers', () => {
    const keys = new Set([
      idempotencyKeyFor('rcv_1', 'SEND_PAYMENT_LINK', 1),
      idempotencyKeyFor('rcv_2', 'SEND_PAYMENT_LINK', 1),
      idempotencyKeyFor('rcv_1', 'SUGGEST_ALTERNATE_METHOD', 1),
      idempotencyKeyFor('rcv_1', 'SEND_PAYMENT_LINK', 2),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('simulated client', () => {
  it('issues a link', async () => {
    const link = await new SimulatedPaymentClient().createPaymentLink(request());
    expect(link.id).toMatch(/^plink_sim_/);
    expect(link.amountPaise).toBe(149_900);
  });

  it('returns the same link for a repeated key instead of making a second one', async () => {
    // The whole point: a retry must not mean a second message to the customer.
    const client = new SimulatedPaymentClient();
    const first = await client.createPaymentLink(request());
    const second = await client.createPaymentLink(request());
    expect(second.id).toBe(first.id);
    expect(client.issuedCount).toBe(1);
  });

  it('produces the same link id across separate client instances', async () => {
    // Ids derive from the idempotency key, so a restart is not a new link.
    const a = await new SimulatedPaymentClient().createPaymentLink(request('idem_stable'));
    const b = await new SimulatedPaymentClient().createPaymentLink(request('idem_stable'));
    expect(a.id).toBe(b.id);
  });

  it('fails on cue for scripted keys', async () => {
    const client = new SimulatedPaymentClient({
      failures: new Map([['idem_boom', { kind: 'timeout' }]]),
    });
    await expect(client.createPaymentLink(request('idem_boom'))).rejects.toThrow(PaymentClientError);
    // Unscripted keys still succeed, so one failure does not poison the batch.
    await expect(client.createPaymentLink(request('idem_fine'))).resolves.toBeDefined();
  });

  it('marks timeouts retryable and validation errors not', async () => {
    // This distinction drives whether the executor retries or escalates.
    const timeoutClient = new SimulatedPaymentClient({
      failures: new Map([['k', { kind: 'timeout' }]]),
    });
    await timeoutClient.createPaymentLink(request('k')).catch((e: PaymentClientError) => {
      expect(e.retryable).toBe(true);
    });

    const validationClient = new SimulatedPaymentClient({
      failures: new Map([['k', { kind: 'validation', detail: 'amount too small' }]]),
    });
    await validationClient.createPaymentLink(request('k')).catch((e: PaymentClientError) => {
      expect(e.retryable).toBe(false);
    });
  });

  it('recovers after a transient outage', async () => {
    const client = new SimulatedPaymentClient({ failFirstAttempts: 1 });
    await expect(client.createPaymentLink(request('idem_flaky'))).rejects.toThrow();
    await expect(client.createPaymentLink(request('idem_flaky'))).resolves.toBeDefined();
    expect(client.attemptsFor('idem_flaky')).toBe(2);
  });
});

describe('Razorpay client refuses anything but test mode', () => {
  it('rejects a live key', () => {
    // There is no scenario where this project should hold a live key.
    expect(() => new RazorpayPaymentClient({ keyId: 'rzp_live_abc123', keySecret: 's' }))
      .toThrow(/only runs against test mode/);
  });

  it('rejects a malformed key', () => {
    expect(() => new RazorpayPaymentClient({ keyId: 'not_a_key', keySecret: 's' }))
      .toThrow(/non-test Razorpay key/);
  });

  it('accepts a test key', () => {
    expect(() => new RazorpayPaymentClient({ keyId: 'rzp_test_abc123', keySecret: 's' })).not.toThrow();
  });
});

describe('client selection', () => {
  it('defaults to the simulator so the project runs with no keys', () => {
    expect(createPaymentClient({}).name).toBe('simulated');
  });

  it('selects Razorpay when asked and configured', () => {
    const client = createPaymentClient({
      PAYMENT_CLIENT: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_abc123',
      RAZORPAY_KEY_SECRET: 'secret',
    });
    expect(client.name).toBe('razorpay');
  });

  it('explains what is missing rather than failing obscurely', () => {
    expect(() => createPaymentClient({ PAYMENT_CLIENT: 'razorpay' }))
      .toThrow(/requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);
  });

  it('rejects an unknown client name', () => {
    expect(() => createPaymentClient({ PAYMENT_CLIENT: 'stripe' })).toThrow(/unknown PAYMENT_CLIENT/);
  });
});

describe('rate limits are backpressure, not failure', () => {
  // Found by running the pipeline against the real API: 796 of 997 calls returned 429,
  // and because Razorpay puts "BAD_REQUEST_ERROR" in the body even for a 429, they were
  // classified as validation errors and escalated. 796 healthy cases went to a human
  // review queue because the sandbox was busy.
  it('classifies a 429 as RATE_LIMITED regardless of the body code', async () => {
    const client = new RazorpayPaymentClient({ keyId: 'rzp_test_probe', keySecret: 's' });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } }), {
        status: 429,
      })) as typeof fetch;
    try {
      await client.createPaymentLink({
        caseId: 'c', orderId: 'o', customerId: 'cu',
        amountPaise: 1000, description: 'd', idempotencyKey: 'k',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as PaymentClientError;
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.retryable).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('classifies a duplicate reference_id as non-retryable', async () => {
    // Confirmed against the real API: a repeated reference_id returns 400. Retrying
    // that would burn the recovery window on a link that already exists.
    const client = new RazorpayPaymentClient({ keyId: 'rzp_test_probe', keySecret: 's' });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'BAD_REQUEST_ERROR', description: 'payment link with given reference_id already exists' },
        }),
        { status: 400 },
      )) as typeof fetch;
    try {
      await client.createPaymentLink({
        caseId: 'c', orderId: 'o', customerId: 'cu',
        amountPaise: 1000, description: 'd', idempotencyKey: 'k',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as PaymentClientError).retryable).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('classifies a 5xx as a retryable server error', async () => {
    const client = new RazorpayPaymentClient({ keyId: 'rzp_test_probe', keySecret: 's' });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    try {
      await client.createPaymentLink({
        caseId: 'c', orderId: 'o', customerId: 'cu',
        amountPaise: 1000, description: 'd', idempotencyKey: 'k',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as PaymentClientError;
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.retryable).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
