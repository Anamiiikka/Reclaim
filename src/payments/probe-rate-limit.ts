/**
 * Find the real test-mode rate limit, and confirm a 429 is classified correctly.
 *
 *   npx tsx src/payments/probe-rate-limit.ts
 *
 * Razorpay does not publish a test-mode limit, and guessing cost a full pipeline run:
 * 796 healthy cases were escalated to human review because the API was busy. This
 * measures the sustainable rate instead of assuming one.
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
    console.error('Razorpay keys are not set in .env');
    process.exit(1);
  }

  for (const intervalMs of [0, 120, 250, 500, 1000]) {
    const client = new RazorpayPaymentClient({ keyId, keySecret, minIntervalMs: intervalMs });
    let ok = 0;
    let rateLimited = 0;
    let other = 0;
    const started = Date.now();

    for (let i = 0; i < 10; i++) {
      try {
        await client.createPaymentLink({
          caseId: 'rcv_probe',
          orderId: 'ord_probe',
          customerId: 'cus_probe',
          amountPaise: 100,
          description: 'rate probe',
          idempotencyKey: `idem_rate_${intervalMs}_${i}_${Date.now()}`,
        });
        ok += 1;
      } catch (error) {
        if (error instanceof PaymentClientError && error.code === 'RATE_LIMITED') rateLimited += 1;
        else other += 1;
      }
    }

    const elapsed = (Date.now() - started) / 1000;
    const rate = (10 / elapsed).toFixed(1);
    console.log(
      `interval ${String(intervalMs).padStart(4)}ms  ->  ok ${ok}, 429 ${rateLimited}, other ${other}` +
        `  (${elapsed.toFixed(1)}s, ~${rate} req/s)`,
    );

    if (rateLimited === 0 && other === 0) {
      console.log(`\nsustainable at ${intervalMs}ms between requests.`);
      return;
    }
  }

  console.log('\nstill rate limited at 1000ms; the account may have a very low test-mode quota.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
