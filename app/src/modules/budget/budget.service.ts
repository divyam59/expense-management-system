import { z } from 'zod';
import * as repo from './budget.repo';
import { Errors } from '../../http/errors';

export async function checkBudget(
  orgId: string,
  userId: string,
  newBaseAmount: number
): Promise<{ ok: boolean; period?: string; limit?: number; spent?: number }> {
  for (const period of ['daily', 'monthly'] as const) {
    const budget = await repo.getUserBudget(orgId, userId, period);
    if (!budget) continue;
    const since = windowStart(period);
    const spent = await repo.spentSince(orgId, userId, since);
    if (spent + newBaseAmount > Number(budget.limit_amount)) {
      return { ok: false, period, limit: Number(budget.limit_amount), spent };
    }
  }
  return { ok: true };
}

export async function utilization(orgId: string, userId: string) {
  const out: Record<string, { limit: number; spent: number; pct: number }> = {};
  for (const period of ['daily', 'monthly'] as const) {
    const budget = await repo.getUserBudget(orgId, userId, period);
    if (!budget) continue;
    const spent = await repo.spentSince(orgId, userId, windowStart(period));
    const limit = Number(budget.limit_amount);
    out[period] = { limit, spent, pct: limit === 0 ? 0 : Math.round((spent / limit) * 100) };
  }
  return out;
}

const createSchema = z.object({
  userId: z.string().uuid().nullable().optional(),
  scope: z.enum(['user', 'org']),
  period: z.enum(['daily', 'monthly']),
  limitAmount: z.number().positive(),
  currency: z.string().default('INR')
});

export async function createBudget(orgId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid budget', parsed.error.flatten());
  return repo.insertBudget({
    org_id: orgId,
    user_id: parsed.data.userId ?? null,
    scope: parsed.data.scope,
    period: parsed.data.period,
    limit_amount: parsed.data.limitAmount,
    currency: parsed.data.currency
  });
}

export async function listBudgets(orgId: string) {
  return repo.listBudgets(orgId);
}

function windowStart(period: 'daily' | 'monthly'): Date {
  const now = new Date();
  if (period === 'daily') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
