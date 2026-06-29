import { randomUUID } from 'crypto';
import { query } from '../../db/pool';

export interface Budget {
  id: string;
  org_id: string;
  user_id: string | null;
  scope: 'user' | 'org';
  period: 'daily' | 'monthly';
  limit_amount: number;
  currency: string;
}

export async function insertBudget(b: Omit<Budget, 'id'>): Promise<Budget> {
  const res = await query<Budget>(
    `INSERT INTO budgets (id, org_id, user_id, scope, period, limit_amount, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), b.org_id, b.user_id, b.scope, b.period, b.limit_amount, b.currency]
  );
  return res.rows[0];
}

/**
 * Set a budget for a (org, user_id, scope, period) slot. Updates the existing
 * row if one is present, otherwise inserts — so re-setting a person's monthly
 * limit doesn't create duplicate, ambiguous rows.
 */
export async function upsertBudget(b: Omit<Budget, 'id'>): Promise<Budget> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM budgets
      WHERE org_id=$1 AND scope=$2 AND period=$3 AND user_id IS NOT DISTINCT FROM $4`,
    [b.org_id, b.scope, b.period, b.user_id]
  );
  if (existing.rows[0]) {
    const res = await query<Budget>(
      `UPDATE budgets SET limit_amount=$1, currency=$2 WHERE id=$3 RETURNING *`,
      [b.limit_amount, b.currency, existing.rows[0].id]
    );
    return res.rows[0];
  }
  return insertBudget(b);
}

export async function listBudgets(orgId: string): Promise<Budget[]> {
  const res = await query<Budget>('SELECT * FROM budgets WHERE org_id=$1', [orgId]);
  return res.rows;
}

export async function getUserBudget(
  orgId: string,
  userId: string,
  period: 'daily' | 'monthly'
): Promise<Budget | null> {
  const res = await query<Budget>(
    `SELECT * FROM budgets
      WHERE org_id=$1 AND period=$2 AND (user_id=$3 OR scope='org')
      ORDER BY user_id NULLS LAST LIMIT 1`,
    [orgId, period, userId]
  );
  return res.rows[0] ?? null;
}

/** Current-month spend per user (base currency), for the admin Budgets screen. */
export async function monthlySpendByUser(
  orgId: string,
  since: Date
): Promise<Record<string, number>> {
  const res = await query<{ requester_id: string; total: string }>(
    `SELECT requester_id, COALESCE(SUM(base_amount),0) AS total
       FROM expense_requests
      WHERE org_id=$1
        AND status NOT IN ('rejected','withdrawn','draft')
        AND created_at >= $2
      GROUP BY requester_id`,
    [orgId, since.toISOString()]
  );
  return res.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.requester_id] = Number(r.total);
    return acc;
  }, {});
}

/** Sum of base_amount for a user's non-rejected/withdrawn expenses in a window. */
export async function spentSince(
  orgId: string,
  userId: string,
  since: Date
): Promise<number> {
  const res = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(base_amount),0) AS total
       FROM expense_requests
      WHERE org_id=$1 AND requester_id=$2
        AND status NOT IN ('rejected','withdrawn','draft')
        AND created_at >= $3`,
    [orgId, userId, since.toISOString()]
  );
  return Number(res.rows[0]?.total ?? 0);
}
