import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { ExpenseRequest, PolicyRule, Role, User } from '../../types';
import { Errors } from '../../http/errors';
import * as stepRepo from './approval.repo';
import * as expenseRepo from '../expenses/expense.repo';
import * as userRepo from '../users/user.repo';
import { recordAudit } from '../audit/audit.service';
import { notify } from '../notifications/notification.service';

const SLA_HOURS = 72;

/** Pick the matching rule for an amount and return the ordered approver levels. */
export function resolveLevels(rules: PolicyRule[], baseAmount: number): Role[] {
  const match = rules.find(
    (r) => baseAmount >= r.min && (r.max === null || baseAmount <= r.max)
  );
  if (!match) {
    // Amount above all configured ranges with finite max -> require the highest chain.
    const widest = [...rules].sort((a, b) => a.levels.length - b.levels.length).pop();
    return widest ? widest.levels : ['manager'];
  }
  return match.levels;
}

/** Resolve the concrete approver user for a required role (self-approval safe). */
async function resolveApprover(
  orgId: string,
  requester: User,
  role: Role
): Promise<string | null> {
  if (role === 'manager') {
    if (requester.manager_id && requester.manager_id !== requester.id) {
      return requester.manager_id;
    }
    // Fall back to any manager in the org who is not the requester.
    const mgr = await userRepo.firstUserWithRole(orgId, 'manager');
    return mgr && mgr.id !== requester.id ? mgr.id : null;
  }
  const user = await userRepo.firstUserWithRole(orgId, role);
  return user && user.id !== requester.id ? user.id : null;
}

/**
 * Build the approval chain on submit: snapshot policy, create one step per level,
 * resolve approvers, move expense to in_review at level 1, notify first approver.
 */
export async function startApprovalChain(
  client: PoolClient,
  expense: ExpenseRequest,
  requester: User,
  rules: PolicyRule[],
  actorId: string,
  requestId?: string | null
): Promise<ExpenseRequest> {
  const levels = resolveLevels(rules, Number(expense.base_amount));
  const slaDue = new Date(Date.now() + SLA_HOURS * 3600 * 1000).toISOString();

  // Pre-resolve every approver before mutating anything. If a required role has
  // no eligible user (e.g. a brand-new org with only an admin and no manager),
  // fail fast with an actionable message instead of creating a chain that can
  // never advance.
  const resolved: { role: Role; approverId: string }[] = [];
  for (const role of levels) {
    const approverId = await resolveApprover(expense.org_id, requester, role);
    if (!approverId) {
      throw Errors.unprocessable(
        `This expense needs a ${role} approval, but there is no eligible ${role} in your organisation yet. ` +
          `Add a ${role} user under "Users" before submitting.`
      );
    }
    resolved.push({ role, approverId });
  }

  let level = 1;
  for (const { role, approverId } of resolved) {
    await stepRepo.insertStep(client, {
      id: randomUUID(),
      org_id: expense.org_id,
      expense_id: expense.id,
      level,
      required_role: role,
      approver_id: approverId,
      sla_due_at: slaDue
    });
    level += 1;
  }

  const updated = await expenseRepo.updateFields(client, expense.org_id, expense.id, {
    status: 'in_review',
    current_level: 1,
    policy_snapshot_json: { rules },
    sla_due_at: slaDue
  });

  await recordAudit(
    {
      orgId: expense.org_id,
      actorId,
      action: 'expense.submitted',
      entityType: 'expense',
      entityId: expense.id,
      before: { status: expense.status },
      after: { status: 'in_review', levels },
      requestId
    },
    client
  );

  const firstStep = await stepRepo.getStepAtLevel(client, expense.org_id, expense.id, 1);
  if (firstStep?.approver_id) {
    await notify(
      {
        orgId: expense.org_id,
        userId: firstStep.approver_id,
        type: 'approval_requested',
        payload: { expenseId: expense.id, level: 1 }
      },
      client
    );
  }
  return updated;
}

export interface DecisionResult {
  expense: ExpenseRequest;
  finalized: boolean;
}

/** Apply an approve decision for the acting user at the current level. */
export async function approve(
  client: PoolClient,
  orgId: string,
  expenseId: string,
  actor: { id: string },
  reason: string | null,
  requestId?: string | null
): Promise<DecisionResult> {
  const expense = await expenseRepo.getByIdForUpdate(client, orgId, expenseId);
  if (!expense) throw Errors.notFound('Expense not found');
  if (expense.status !== 'in_review') {
    throw Errors.conflict(`Expense is not awaiting approval (status=${expense.status})`);
  }
  const step = await stepRepo.getStepAtLevel(
    client,
    orgId,
    expenseId,
    expense.current_level
  );
  if (!step) throw Errors.conflict('No approval step at the current level');
  if (step.approver_id !== actor.id) {
    throw Errors.forbidden('You are not the assigned approver for this step');
  }
  if (expense.requester_id === actor.id) {
    throw Errors.forbidden('You cannot approve your own expense');
  }

  await stepRepo.setStepStatus(client, step.id, 'approved', reason);

  const steps = await stepRepo.listSteps(orgId, expenseId);
  const isLast = expense.current_level >= steps.length;
  const finalized = isLast;
  const nextLevel = expense.current_level + 1;

  const updated = await expenseRepo.updateFields(client, orgId, expenseId, {
    status: isLast ? 'approved' : 'in_review',
    current_level: isLast ? expense.current_level : nextLevel
  });

  await recordAudit(
    {
      orgId,
      actorId: actor.id,
      action: isLast ? 'expense.approved' : 'expense.step_approved',
      entityType: 'expense',
      entityId: expenseId,
      before: { status: 'in_review', level: expense.current_level },
      after: { status: updated.status, level: updated.current_level },
      reason,
      requestId
    },
    client
  );

  if (isLast) {
    await notify(
      {
        orgId,
        userId: expense.requester_id,
        type: 'expense_approved',
        payload: { expenseId }
      },
      client
    );
  } else {
    const nextStep = await stepRepo.getStepAtLevel(client, orgId, expenseId, nextLevel);
    if (nextStep?.approver_id) {
      await notify(
        {
          orgId,
          userId: nextStep.approver_id,
          type: 'approval_requested',
          payload: { expenseId, level: nextLevel }
        },
        client
      );
    }
  }
  return { expense: updated, finalized };
}

/** Apply a reject decision (terminates the chain). */
export async function reject(
  client: PoolClient,
  orgId: string,
  expenseId: string,
  actor: { id: string },
  reason: string,
  requestId?: string | null
): Promise<DecisionResult> {
  const expense = await expenseRepo.getByIdForUpdate(client, orgId, expenseId);
  if (!expense) throw Errors.notFound('Expense not found');
  if (expense.status !== 'in_review') {
    throw Errors.conflict(`Expense is not awaiting approval (status=${expense.status})`);
  }
  const step = await stepRepo.getStepAtLevel(
    client,
    orgId,
    expenseId,
    expense.current_level
  );
  if (!step) throw Errors.conflict('No approval step at the current level');
  if (step.approver_id !== actor.id) {
    throw Errors.forbidden('You are not the assigned approver for this step');
  }

  await stepRepo.setStepStatus(client, step.id, 'rejected', reason);
  const updated = await expenseRepo.updateFields(client, orgId, expenseId, {
    status: 'rejected'
  });

  await recordAudit(
    {
      orgId,
      actorId: actor.id,
      action: 'expense.rejected',
      entityType: 'expense',
      entityId: expenseId,
      before: { status: 'in_review', level: expense.current_level },
      after: { status: 'rejected' },
      reason,
      requestId
    },
    client
  );

  await notify(
    {
      orgId,
      userId: expense.requester_id,
      type: 'expense_rejected',
      payload: { expenseId, reason }
    },
    client
  );
  return { expense: updated, finalized: true };
}
