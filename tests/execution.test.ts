/**
 * Execution and failure-handling tests.
 *
 * These drive the executor's decision logic through the simulated client. The
 * property under test throughout: a payment-API failure must never produce a second
 * message to the customer.
 */

import { describe, expect, it } from 'vitest';

import { PaymentClientError, SimulatedPaymentClient } from '../src/payments/index.js';
import type { FailureMode } from '../src/payments/simulated.js';
import { idempotencyKeyFor } from '../src/actions/execute.js';

describe('retry semantics', () => {
  it('a retry reuses the key, so the provider returns the original link', async () => {
    // This is the mechanism that makes retrying safe. Without it, a timeout on a call
    // that actually succeeded would create a second link and a second message.
    const client = new SimulatedPaymentClient({ failFirstAttempts: 1 });
    const key = idempotencyKeyFor('rcv_1', 'SEND_PAYMENT_LINK', 1);
    const request = {
      caseId: 'rcv_1',
      orderId: 'ord_1',
      customerId: 'cus_1',
      amountPaise: 100_000,
      description: 'test',
      idempotencyKey: key,
    };

    await expect(client.createPaymentLink(request)).rejects.toThrow();
    const link = await client.createPaymentLink(request);
    const again = await client.createPaymentLink(request);

    expect(again.id).toBe(link.id);
    expect(client.issuedCount).toBe(1);
  });

  it('a lost response does not produce a second link', async () => {
    // Models the dangerous case: the provider created the link but we never saw the
    // response. Retrying under the same key must return the existing link.
    const client = new SimulatedPaymentClient();
    const key = idempotencyKeyFor('rcv_2', 'SEND_PAYMENT_LINK', 1);
    const request = {
      caseId: 'rcv_2',
      orderId: 'ord_2',
      customerId: 'cus_2',
      amountPaise: 50_000,
      description: 'test',
      idempotencyKey: key,
    };

    const first = await client.createPaymentLink(request);
    const retried = await client.createPaymentLink(request);

    expect(retried.id).toBe(first.id);
    expect(client.issuedCount).toBe(1);
  });
});

describe('retryable vs permanent failures', () => {
  const request = (key: string) => ({
    caseId: 'rcv_x',
    orderId: 'ord_x',
    customerId: 'cus_x',
    amountPaise: 100_000,
    description: 'test',
    idempotencyKey: key,
  });

  it('classifies transient failures as retryable', async () => {
    const modes: Array<[string, FailureMode]> = [
      ['k1', { kind: 'timeout' }],
      ['k2', { kind: 'rate_limited' }],
    ];
    for (const [key, mode] of modes) {
      const client = new SimulatedPaymentClient({ failures: new Map([[key, mode]]) });
      await client.createPaymentLink(request(key)).catch((error: PaymentClientError) => {
        expect(error.retryable).toBe(true);
      });
    }
  });

  it('classifies permanent failures as not retryable', async () => {
    // Retrying these only burns the recovery window.
    const modes: Array<[string, FailureMode]> = [
      ['k3', { kind: 'validation', detail: 'amount below minimum' }],
      ['k4', { kind: 'duplicate_link' }],
    ];
    for (const [key, mode] of modes) {
      const client = new SimulatedPaymentClient({ failures: new Map([[key, mode]]) });
      await client.createPaymentLink(request(key)).catch((error: PaymentClientError) => {
        expect(error.retryable).toBe(false);
      });
    }
  });

  it('never issues a link for a failed call', async () => {
    const client = new SimulatedPaymentClient({
      failures: new Map<string, FailureMode>([['k5', { kind: 'timeout' }]]),
    });
    await expect(client.createPaymentLink(request('k5'))).rejects.toThrow();
    expect(client.issuedCount).toBe(0);
  });
});

describe('one failure does not poison a batch', () => {
  it('leaves other cases unaffected', async () => {
    // A transient provider problem on one case says nothing about the others.
    const client = new SimulatedPaymentClient({
      failures: new Map<string, FailureMode>([['bad', { kind: 'timeout' }]]),
    });
    const make = (key: string) => ({
      caseId: `rcv_${key}`,
      orderId: 'o',
      customerId: 'c',
      amountPaise: 1000,
      description: 'd',
      idempotencyKey: key,
    });

    const results = await Promise.allSettled([
      client.createPaymentLink(make('good1')),
      client.createPaymentLink(make('bad')),
      client.createPaymentLink(make('good2')),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(client.issuedCount).toBe(2);
  });
});
