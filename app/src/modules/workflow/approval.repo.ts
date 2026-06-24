import { PoolClient } from 'pg';
import { query } from '../../db/pool';
import { ApprovalStep, Role, StepStatus } from '../../types';

export async function insertStep(
  client: PoolClient,
  step: {
    id: string;
    org_id: string;
    expense_id: string;
    level: number;
    required_role: Role;
    approver_id: string | null;
    sla_due_at: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO approval_steps
       (id, org_id, expense_id, level, required_role, approver_id, status, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
    [
      step.id,
      step.org_id,
      step.expense_id,
      step.level,
      step.required_role,
      step.approver_id,
      step.sla_due_at
    ]
  );
}

export async function listSteps(orgId: string, expenseId: string): Promise<ApprovalStep[]> {
  const res = await query<ApprovalStep>(
    'SELECT * FROM approval_steps WHERE org_id=$1 AND expense_id=$2 ORDER BY level ASC',
    [orgId, expenseId]
  );
  return res.rows;
}

export async function getStepAtLevel(
  client: PoolClient,
  orgId: string,
  expenseId: string,
  level: number
): Promise<ApprovalStep | null> {
  const res = await client.query<ApprovalStep>(
    'SELECT * FROM approval_steps WHERE org_id=$1 AND expense_id=$2 AND level=$3',
    [orgId, expenseId, level]
  );
  return res.rows[0] ?? null;
}

export async function setStepStatus(
  client: PoolClient,
  id: string,
  status: StepStatus,
  reason: string | null
): Promise<void> {
  await client.query(
    `UPDATE approval_steps SET status=$1, reason=$2, acted_at=now() WHERE id=$3`,
    [status, reason, id]
  );
}

export async function deletePendingSteps(
  client: PoolClient,
  orgId: string,
  expenseId: string
): Promise<void> {
  await client.query(
    `DELETE FROM approval_steps WHERE org_id=$1 AND expense_id=$2 AND status='pending'`,
    [orgId, expenseId]
  );
}

/** Pending approvals assigned to a given approver (with bill/attachment info). */
export async function pendingForApprover(orgId: string, approverId: string) {
  const res = await query(
    `SELECT s.*, e.amount, e.base_amount, e.currency, e.type, e.category,
            e.description, e.requester_id, e.status AS expense_status,
            u.name AS requester_name, u.email AS requester_email,
            att.cnt AS attachment_count,
            att.first_id AS first_attachment_id,
            att.first_type AS first_attachment_type
       FROM approval_steps s
       JOIN expense_requests e ON e.id = s.expense_id
       JOIN users u ON u.id = e.requester_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS cnt,
                (array_agg(a.id ORDER BY a.uploaded_at))[1] AS first_id,
                (array_agg(a.content_type ORDER BY a.uploaded_at))[1] AS first_type
           FROM attachments a WHERE a.expense_id = e.id
       ) att ON true
      WHERE s.org_id=$1 AND s.approver_id=$2 AND s.status='pending'
        AND e.status='in_review' AND s.level = e.current_level
      ORDER BY s.sla_due_at ASC NULLS LAST`,
    [orgId, approverId]
  );
  return res.rows;
}

/** True if the user is (or was) an assigned approver on this expense. */
export async function isAssignedApprover(
  orgId: string,
  expenseId: string,
  userId: string
): Promise<boolean> {
  const res = await query(
    'SELECT 1 FROM approval_steps WHERE org_id=$1 AND expense_id=$2 AND approver_id=$3 LIMIT 1',
    [orgId, expenseId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}
