/**
 * Verify Razorpay test-mode credentials end to end.
 *
 *   npx tsx src/payments/check-connection.ts
 *
 * Creates one real payment link in test mode and prints its URL. No money moves; the
 * link is real and openable, which is the point — it proves the integration works
 * rather than that the credentials merely parse.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set in .env.');
    console.error('dashboard.razorpay.com -> Test Mode -> Account & Settings -> API Keys');
    process.exit(1);
  }

  // Only ever print a prefix. The full key never belongs in a terminal transcript.
  console.log(`key id: ${keyId.slice(0, 12)}...`);

  const client = new RazorpayPaymentClient({ keyId, keySecret });

  process.stdout.write('authenticating... ');
  const healthy = await client.healthCheck();
  if (!healthy) {
    console.log('failed');
    console.error('\nRazorpay rejected these credentials. Check the secret was copied in full.');
    process.exit(1);
  }
  console.log('ok');

  process.stdout.write('creating a test payment link... ');
  const link = await client.createPaymentLink({
    caseId: 'rcv_connection_check',
    orderId: 'ord_connection_check',
    customerId: 'cus_connection_check',
    amountPaise: 100, // ₹1, the smallest amount Razorpay accepts
    description: 'Reclaim connection check',
    idempotencyKey: `idem_check_${Date.now()}`,
  });
  console.log('ok');

  console.log(`\n  link id   ${link.id}`);
  console.log(`  url       ${link.url}`);
  console.log(`  amount    ₹${(link.amountPaise / 100).toFixed(2)}`);
  console.log(`  expires   ${link.expiresAt}`);
  console.log('\nOpen that URL to see a real test-mode checkout. Test cards: razorpay.com/docs/payments/payments/test-card-details');
  console.log('\nTo run the pipeline against Razorpay: set PAYMENT_CLIENT=razorpay in .env');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
