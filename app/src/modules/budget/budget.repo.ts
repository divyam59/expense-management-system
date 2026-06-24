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
