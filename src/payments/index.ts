/**
 * Payment client selection.
 *
 * PAYMENT_CLIENT=simulated (default) or razorpay. The default is deliberate: the
 * project must run for a reviewer who has no keys, and the test suite must never
 * depend on a network call.
 */

import { RazorpayPaymentClient } from './razorpay.js';
import { SimulatedPaymentClient } from './simulated.js';
import type { PaymentClient } from './client.js';

export * from './client.js';
export { SimulatedPaymentClient } from './simulated.js';
export { RazorpayPaymentClient } from './razorpay.js';

export function createPaymentClient(env: NodeJS.ProcessEnv = process.env): PaymentClient {
  const selected = (env['PAYMENT_CLIENT'] ?? 'simulated').toLowerCase();

  if (selected === 'razorpay') {
    const keyId = env['RAZORPAY_KEY_ID'];
    const keySecret = env['RAZORPAY_KEY_SECRET'];
    if (!keyId || !keySecret) {
      throw new Error(
        'PAYMENT_CLIENT=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. ' +
          'Add them to .env, or unset PAYMENT_CLIENT to use the simulator.',
      );
    }
    return new RazorpayPaymentClient({ keyId, keySecret });
  }

  if (selected !== 'simulated') {
    throw new Error(`unknown PAYMENT_CLIENT "${selected}" (expected "simulated" or "razorpay")`);
  }

  return new SimulatedPaymentClient();
}
