import { convert, fxRate, isSupportedCurrency } from '../../src/modules/expenses/currency';

describe('currency', () => {
  it('recognizes supported currencies', () => {
    expect(isSupportedCurrency('INR')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('XYZ')).toBe(false);
  });

  it('returns 1 for same-currency rate', () => {
    expect(fxRate('INR', 'INR')).toBe(1);
  });

  it('converts USD to INR', () => {
    expect(convert(100, 'USD', 'INR')).toBe(8300);
  });

  it('throws for unsupported currency', () => {
    expect(() => fxRate('ZZZ', 'INR')).toThrow(/Unsupported currency/);
  });
});
