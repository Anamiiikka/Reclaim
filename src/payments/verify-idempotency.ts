/**
 * Verify idempotency against the real Razorpay test-mode API.
 *
 *   npx tsx src/payments/verify-idempotency.ts
 *
 * Sends the same request twice with the same idempotency key and reports what the
 * provider does. Reclaim never depends on the provider deduplicating — the database
 * unique constraint is the real guarantee — but knowing the actual behaviour matters,
 * because the wrong assumption here is the difference between one message to a
 * customer and two.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PaymentClientError } from './client.js';
import { RazorpayPaymentClient } from './razorpay.js';

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  if (!keyId || !keySecret) {
    console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set in .env');
    process.exit(1);
  }

  const client = new RazorpayPaymentClient({ keyId, keySecret });
  const idempotencyKey = `idem_probe_${Date.now()}`;
  const request = {
    caseId: 'rcv_probe',
    orderId: 'ord_probe',
    customerId: 'cus_probe',
    amountPaise: 149_900,
    description: 'Reclaim idempotency probe',
    idempotencyKey,
  };

  const first = await client.createPaymentLink(request);
  console.log(`first call  : ${first.id}`);
  console.log(`              ${first.url}`);

  try {
    const second = await client.createPaymentLink(request);
    if (second.id === first.id) {
      console.log(`second call : ${second.id} — same link returned; provider deduplicated`);
    } else {
      console.log(`second call : ${second.id} — DIFFERENT link created`);
      console.log('\nThe provider does not deduplicate on reference_id. Reclaim still holds:');
      console.log('the database unique constraint on idempotency_key prevents a second action');
      console.log('from ever being scheduled, so this path is not reachable in the pipeline.');
    }
  } catch (error) {
    const paymentError = error instanceof PaymentClientError ? error : null;
    console.log('second call : rejected by the provider');
    console.log(`              code      ${paymentError?.code ?? 'unknown'}`);
    console.log(
      `              retryable ${paymentError?.retryable ?? 'unknown'}` +
        (paymentError?.retryable === false ? '  (correct — a retry must not create a duplicate)' : ''),
    );
    console.log(`              ${(error as Error).message.slice(0, 120)}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
