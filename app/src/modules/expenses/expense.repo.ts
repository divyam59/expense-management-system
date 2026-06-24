import { PoolClient } from 'pg';
import { query } from '../../db/pool';
import { ExpenseRequest, ExpenseStatus, PolicyRule } from '../../types';

export async function insertExpense(e: {
  id: string;
  org_id: string;
  requester_id: string;
  type: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
}): Promise<ExpenseRequest> {
  const res = await query<ExpenseRequest>(
    `INSERT INTO expense_requests
       (id, org_id, requester_id, type, category, description, amount, currency, base_amount, fx_rate, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING *`,
    [
      e.id,
      e.org_id,
      e.requester_id,
      e.type,
      e.category,
      e.description,
      e.amount,
      e.currency,
      e.base_amount,
      e.fx_rate
    ]
  );
  return res.rows[0];
}

export async function getById(orgId: string, id: string): Promise<ExpenseRequest | null> {
  const res = await query<ExpenseRequest>(
    'SELECT * FROM expense_requests WHERE id=$1 AND org_id=$2',
    [id, orgId]
  );
  return res.rows[0] ?? null;
}

/**
 * Row-locking read used by every state transition (submit/edit/approve/reject/
 * withdraw). The `FOR UPDATE` takes an exclusive row lock for the life of the
 * transaction, so two concurrent approvals/rejections on the same expense are
 * serialized by Postgres — the second waits, then re-reads the post-commit state
 * and is correctly rejected by the status/level guards. This (not the idempotency
 * key, which only dedupes identical retries) is what prevents double-apply races.
 */
export async function getByIdForUpdate(
  client: PoolClient,
  orgId: string,
  id: string
): Promise<ExpenseRequest | null> {
  const res = await client.query<ExpenseRequest>(
    'SELECT * FROM expense_requests WHERE id=$1 AND org_id=$2 FOR UPDATE',
    [id, orgId]
  );
  return res.rows[0] ?? null;
}

export interface ListFilter {
  status?: ExpenseStatus;
  type?: string;
  requesterId?: string;
  requesterIds?: string[];
  limit: number;
  offset: number;
}

export async function listExpenses(orgId: string, f: ListFilter) {
  const where: string[] = ['org_id=$1'];
  const params: unknown[] = [orgId];
  let i = 2;
  if (f.status) {
    where.push(`status=$${i++}`);
    params.push(f.status);
  }
  if (f.type) {
    where.push(`type=$${i++}`);
    params.push(f.type);
  }
  if (f.requesterId) {
    where.push(`requester_id=$${i++}`);
    params.push(f.requesterId);
  }
  if (f.requesterIds) {
    where.push(`requester_id = ANY($${i++})`);
    params.push(f.requesterIds);
  }
  params.push(f.limit, f.offset);
  const res = await query<ExpenseRequest>(
    `SELECT * FROM expense_requests WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i}`,
    params
  );
  return res.rows;
}

export async function updateFields(
  client: PoolClient,
  orgId: string,
  id: string,
  fields: Partial<
    Pick<
      ExpenseRequest,
      | 'amount'
      | 'currency'
      | 'base_amount'
      | 'fx_rate'
      | 'category'
      | 'description'
      | 'status'
      | 'current_level'
    >
  > & { policy_snapshot_json?: { rules: PolicyRule[] }; sla_due_at?: string | null }
): Promise<ExpenseRequest> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k}=$${i++}`);
    params.push(k === 'policy_snapshot_json' ? JSON.stringify(v) : v);
  }
  sets.push('updated_at=now()');
  params.push(id, orgId);
  const res = await client.query<ExpenseRequest>(
    `UPDATE expense_requests SET ${sets.join(', ')} WHERE id=$${i++} AND org_id=$${i} RETURNING *`,
    params
  );
  return res.rows[0];
}

export async function deleteExpense(orgId: string, id: string): Promise<boolean> {
  const res = await query('DELETE FROM expense_requests WHERE id=$1 AND org_id=$2', [
    id,
    orgId
  ]);
  return (res.rowCount ?? 0) > 0;
}
