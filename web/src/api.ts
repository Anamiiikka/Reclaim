/** Shared fetch helper and formatting. */

export async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** Money is paise everywhere; format only at the edge. */
export function rupees(paise: number | string, compact = false): string {
  const value = Number(paise) / 100;
  if (compact && value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (compact && value >= 100_000) return `₹${(value / 100_000).toFixed(2)} L`;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Human-readable label for an enum-ish constant. */
export function humanise(value: string | null): string {
  if (!value) return '—';
  return value.toLowerCase().replace(/_/g, ' ');
}

export function actionTone(action: string | null): string {
  switch (action) {
    case 'SEND_PAYMENT_LINK':
    case 'SUGGEST_ALTERNATE_METHOD':
    case 'DELAYED_RETRY_PROMPT':
      return 'info';
    case 'HUMAN_ESCALATION':
      return 'warn';
    case 'MERCHANT_ALERT':
      return 'accent';
    default:
      return '';
  }
}
