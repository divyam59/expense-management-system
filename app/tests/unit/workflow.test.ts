import { resolveLevels } from '../../src/modules/workflow/workflow.engine';
import { PolicyRule } from '../../src/types';

const rules: PolicyRule[] = [
  { min: 0, max: 5000, levels: ['manager'] },
  { min: 5001, max: 50000, levels: ['manager', 'finance'] },
  { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
];

describe('resolveLevels', () => {
  it('picks single level for small amounts', () => {
    expect(resolveLevels(rules, 3000)).toEqual(['manager']);
  });

  it('picks two levels for medium amounts', () => {
    expect(resolveLevels(rules, 20000)).toEqual(['manager', 'finance']);
  });

  it('picks three levels for large amounts (open-ended max)', () => {
    expect(resolveLevels(rules, 500000)).toEqual(['manager', 'finance', 'admin']);
  });

  it('handles boundary values inclusively', () => {
    expect(resolveLevels(rules, 5000)).toEqual(['manager']);
    expect(resolveLevels(rules, 5001)).toEqual(['manager', 'finance']);
  });

  it('falls back to widest chain when no rule matches', () => {
    const gapRules: PolicyRule[] = [{ min: 0, max: 100, levels: ['manager'] }];
    expect(resolveLevels(gapRules, 9999)).toEqual(['manager']);
  });
});
