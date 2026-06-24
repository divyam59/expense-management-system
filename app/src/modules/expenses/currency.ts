/**
 * Static FX rates to a notional base (INR) for the prototype. In production this
 * would come from a rates provider and be snapshotted on the expense at submit.
 */
const RATES_TO_INR: Record<string, number> = {
  INR: 1,
  USD: 83,
  EUR: 90,
  GBP: 105,
  AED: 22.6,
  SGD: 61
};

export function isSupportedCurrency(code: string): boolean {
  return code in RATES_TO_INR;
}

export function fxRate(from: string, to: string): number {
  const f = RATES_TO_INR[from];
  const t = RATES_TO_INR[to];
  if (f === undefined || t === undefined) {
    throw new Error(`Unsupported currency: ${from} or ${to}`);
  }
  return f / t;
}

export function convert(amount: number, from: string, to: string): number {
  return Math.round(amount * fxRate(from, to) * 100) / 100;
}
