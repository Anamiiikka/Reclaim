/**
 * Diagnosis engine tests.
 *
 * The mapping is deterministic, so these are mostly about the edges: fraud
 * overriding a benign-looking code, missing codes, and unrecognised ones.
 */

import { describe, expect, it } from 'vitest';

import { diagnose, knownFailureCodes } from '../src/decisions/diagnose.js';
import type { DiagnosisInput } from '../src/decisions/diagnose.js';

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    failureCode: 'GATEWAY_TIMEOUT',
    attemptStatus: 'FAILED',
    checkoutStage: 'payment',
    attemptNumber: 1,
    suspicionScore: 0.1,
    ...overrides,
  };
}

describe('known gateway codes map deterministically', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['GATEWAY_TIMEOUT', 'TEMPORARY_BANK_OR_NETWORK_FAILURE'],
    ['ISSUER_UNAVAILABLE', 'TEMPORARY_BANK_OR_NETWORK_FAILURE'],
    ['INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS'],
    ['CARD_EXPIRED', 'EXPIRED_PAYMENT_METHOD'],
    ['USER_DROPPED', 'USER_ABANDONMENT'],
    ['DUPLICATE_ATTEMPT', 'DUPLICATE_OR_REPEAT_ATTEMPT'],
    ['RISK_BLOCKED', 'SUSPICIOUS_ACTIVITY'],
    ['MERCHANT_KEY_INVALID', 'MERCHANT_CONFIGURATION_ERROR'],
  ];

  for (const [code, expected] of cases) {
    it(`${code} → ${expected}`, () => {
      const result = diagnose(input({ failureCode: code }));
      expect(result.diagnosis).toBe(expected);
      expect(result.source).toBe('CODE_MAP');
      expect(result.confidence).toBeGreaterThan(0.9);
    });
  }

  it('normalises case and whitespace', () => {
    // Gateways are not consistent about this.
    expect(diagnose(input({ failureCode: '  gateway_timeout  ' })).diagnosis)
      .toBe('TEMPORARY_BANK_OR_NETWORK_FAILURE');
  });

  it('every mapped code resolves to a real diagnosis', () => {
    for (const code of knownFailureCodes()) {
      expect(diagnose(input({ failureCode: code })).source).toBe('CODE_MAP');
    }
  });
});

describe('fraud signals override the gateway code', () => {
  it('treats a high suspicion score as fraud despite a benign code', () => {
    // A stolen card declining for "insufficient funds" is still fraud. Reading the
    // code alone here would mean sending a recovery link to an attacker.
    const result = diagnose(input({ failureCode: 'INSUFFICIENT_FUNDS', suspicionScore: 0.9 }));
    expect(result.diagnosis).toBe('SUSPICIOUS_ACTIVITY');
    expect(result.source).toBe('HEURISTIC');
  });

  it('leaves a low-suspicion case alone', () => {
    expect(diagnose(input({ failureCode: 'INSUFFICIENT_FUNDS', suspicionScore: 0.3 })).diagnosis)
      .toBe('INSUFFICIENT_FUNDS');
  });
});

describe('missing gateway code', () => {
  it('infers abandonment from an abandoned status', () => {
    const result = diagnose(input({ failureCode: null, attemptStatus: 'ABANDONED', checkoutStage: 'cart' }));
    expect(result.diagnosis).toBe('USER_ABANDONMENT');
    expect(result.source).toBe('STATUS_INFERENCE');
  });

  it('falls back to UNKNOWN with low confidence when there is nothing to go on', () => {
    const result = diagnose(input({ failureCode: null, checkoutStage: 'payment' }));
    expect(result.diagnosis).toBe('UNKNOWN');
    expect(result.confidence).toBeLessThan(0.6);
  });
});

describe('unrecognised gateway codes', () => {
  it('does not invent a confident diagnosis', () => {
    const result = diagnose(input({ failureCode: 'SOME_NEW_CODE_2027' }));
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('reads repeated attempts as a systemic block', () => {
    const result = diagnose(input({ failureCode: 'UNSPECIFIED_DECLINE', attemptNumber: 3 }));
    expect(result.diagnosis).toBe('DUPLICATE_OR_REPEAT_ATTEMPT');
    expect(result.source).toBe('HEURISTIC');
  });

  it('reads a pre-payment stage as abandonment', () => {
    const result = diagnose(input({ failureCode: 'UNSPECIFIED_DECLINE', checkoutStage: 'address' }));
    expect(result.diagnosis).toBe('USER_ABANDONMENT');
  });

  it('always explains itself', () => {
    for (const code of [null, '', 'WHO_KNOWS']) {
      expect(diagnose(input({ failureCode: code })).detail.length).toBeGreaterThan(0);
    }
  });
});

describe('determinism', () => {
  it('gives the same answer every time', () => {
    const probe = input({ failureCode: 'GATEWAY_TIMEOUT' });
    const first = JSON.stringify(diagnose(probe));
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(diagnose(probe))).toBe(first);
    }
  });
});
