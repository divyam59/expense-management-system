import { randomUUID } from 'crypto';
import { z } from 'zod';
import { withTransaction } from '../../db/pool';
import { Errors } from '../../http/errors';
import { AuthUser, ExpenseStatus } from '../../types';
import { hasPermission } from '../../rbac/permissions';
import { getIdempotentResponse, saveIdempotentResponse } from '../../http/idempotency';
import * as repo from './expense.repo';
import * as stepRepo from '../workflow/approval.repo';
import * as userRepo from '../users/user.repo';
import * as policyRepo from '../policy/policy.repo';
import * as engine from '../workflow/workflow.engine';
import { recordAudit, getHistory } from '../audit/audit.service';
import { checkBudget } from '../budget/budget.service';
import { convert, fxRate, isSupportedCurrency } from './currency';

const createSchema = z.object({
  type: z.enum(['reimbursement', 'company_paid']),
  category: z.string().min(1).default('general'),
  description: z.string().default(''),
  amount: z.number().positive(),
  currency: z.string().default('INR')
});

const BASE_CURRENCY = 'INR';

export async function createExpense(user: AuthUser, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid expense', parsed.error.flatten());
  if (!isSupportedCurrency(parsed.data.currency)) {
    throw Errors.unprocessable(`Unsupported currency: ${parsed.data.currency}`);
  }
  // No approval policy = no way to route this expense, so don't let it be
  // created at all (clearer than letting a draft exist that can never be sent).
  const activePolicy = await policyRepo.getActivePolicy(user.org_id);
  if (!activePolicy) {
    throw Errors.unprocessable(
      'No active approval policy configured. An admin must create or activate a policy under "Policies" before expenses can be created.'
    );
  }
  const baseAmount = convert(parsed.data.amount, parsed.data.currency, BASE_CURRENCY);
  const rate = fxRate(parsed.data.currency, BASE_CURRENCY);

  const expense = await repo.insertExpense({
    id: randomUUID(),
    org_id: user.org_id,
    requester_id: user.id,
    type: parsed.data.type,
    category: parsed.data.category,
    description: parsed.data.description,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    base_amount: baseAmount,
    fx_rate: rate
  });

  await recordAudit({
    orgId: user.org_id,
    actorId: user.id,
    action: 'expense.created',
    entityType: 'expense',
    entityId: expense.id,
    after: { amount: expense.amount, currency: expense.currency, type: expense.type }
  });
  return expense;
}

export async function getExpense(user: AuthUser, id: string) {
  const expense = await repo.getById(user.org_id, id);
  if (!expense) throw Errors.notFound('Expense not found');
  await assertCanView(user, expense.requester_id);
  const steps = await stepRepo.listSteps(user.org_id, id);
  return { ...expense, steps };
}

export async function listExpenses(user: AuthUser, q: Record<string, unknown>) {
  const limit = Math.min(parseInt(String(q.limit ?? '20'), 10) || 20, 100);
  const offset = parseInt(String(q.offset ?? '0'), 10) || 0;
  const scope = String(q.scope ?? 'mine');
  const filter: repo.ListFilter = {
    limit,
    offset,
    status: q.status ? (String(q.status) as ExpenseStatus) : undefined,
    type: q.type ? String(q.type) : undefined
  };

  if (scope === 'all') {
    if (!hasPermission(user.role, 'expense:read:all')) throw Errors.forbidden();
  } else if (scope === 'reportees') {
    if (!hasPermission(user.role, 'expense:read:reportees')) throw Errors.forbidden();
    const reportees = await userRepo.listReportees(user.org_id, user.id);
    filter.requesterIds = reportees.map((r) => r.id);
    if (filter.requesterIds.length === 0) return [];
  } else {
    filter.requesterId = user.id;
  }
  return repo.listExpenses(user.org_id, filter);
}

const editSchema = z.object({
  category: z.string().min(1).optional(),
  description: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.string().optional()
});

export async function editExpense(user: AuthUser, id: string, body: unknown) {
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid payload', parsed.error.flatten());

  return withTransaction(async (client) => {
    const expense = await repo.getByIdForUpdate(client, user.org_id, id);
    if (!expense) throw Errors.notFound('Expense not found');
    if (expense.requester_id !== user.id) {
      throw Errors.forbidden('Only the requester can edit this expense');
    }
    if (!['draft', 'submitted', 'in_review'].includes(expense.status)) {
      throw Errors.conflict(`Cannot edit an expense in status ${expense.status}`);
    }

    const currency = parsed.data.currency ?? expense.currency;
    if (!isSupportedCurrency(currency)) {
      throw Errors.unprocessable(`Unsupported currency: ${currency}`);
    }
    const amount = parsed.data.amount ?? Number(expense.amount);
    const baseAmount = convert(amount, currency, BASE_CURRENCY);

    const updated = await repo.updateFields(client, user.org_id, id, {
      category: parsed.data.category,
      description: parsed.data.description,
      amount,
      currency,
      base_amount: baseAmount,
      fx_rate: fxRate(currency, BASE_CURRENCY)
    });

    // Re-evaluate the chain if amount changed while in review.
    if (expense.status === 'in_review') {
      const requester = await userRepo.findById(user.org_id, expense.requester_id);
      const policy = await policyRepo.getActivePolicy(user.org_id);
      const rules = expense.policy_snapshot_json?.rules ?? policy?.rules_json.rules ?? [];
      await stepRepo.deletePendingSteps(client, user.org_id, id);
      await engine.startApprovalChain(client, updated, requester!, rules, user.id);
    }

    await recordAudit(
      {
        orgId: user.org_id,
        actorId: user.id,
        action: 'expense.edited',
        entityType: 'expense',
        entityId: id,
        before: { amount: expense.amount, base_amount: expense.base_amount },
        after: { amount, base_amount: baseAmount }
      },
      client
    );
    return updated;
  });
}

export async function submitExpense(user: AuthUser, id: string) {
  return withTransaction(async (client) => {
    const expense = await repo.getByIdForUpdate(client, user.org_id, id);
    if (!expense) throw Errors.notFound('Expense not found');
    if (expense.requester_id !== user.id) {
      throw Errors.forbidden('Only the requester can submit this expense');
    }
    if (expense.status !== 'draft') {
      throw Errors.conflict(`Only draft expenses can be submitted (status=${expense.status})`);
    }

    const budget = await checkBudget(user.org_id, user.id, Number(expense.base_amount));
    if (!budget.ok) {
      throw Errors.unprocessable(
        `Budget exceeded for ${budget.period} (limit ${budget.limit}, already spent ${budget.spent})`,
        budget
      );
    }

    const policy = await policyRepo.getActivePolicy(user.org_id);
    if (!policy) throw Errors.unprocessable('No active approval policy configured');

    const requester = await userRepo.findById(user.org_id, user.id);
    return engine.startApprovalChain(
      client,
      expense,
      requester!,
      policy.rules_json.rules,
      user.id
    );
  });
}

export async function approveExpense(
  user: AuthUser,
  id: string,
  reason: string | null,
  idempotencyKey?: string
) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const prev = await getIdempotentResponse(
        client,
        idempotencyKey,
        user.org_id,
        'expense.approve'
      );
      if (prev) return prev;
    }
    const result = await engine.approve(client, user.org_id, id, user, reason);
    if (idempotencyKey) {
      await saveIdempotentResponse(
        client,
        idempotencyKey,
        user.org_id,
        'expense.approve',
        result.expense
      );
    }
    return result.expense;
  });
}

export async function rejectExpense(
  user: AuthUser,
  id: string,
  reason: string,
  idempotencyKey?: string
) {
  if (!reason || reason.trim().length === 0) {
    throw Errors.badRequest('A reason is required to reject');
  }
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const prev = await getIdempotentResponse(
        client,
        idempotencyKey,
        user.org_id,
        'expense.reject'
      );
      if (prev) return prev;
    }
    const result = await engine.reject(client, user.org_id, id, user, reason);
    if (idempotencyKey) {
      await saveIdempotentResponse(
        client,
        idempotencyKey,
        user.org_id,
        'expense.reject',
        result.expense
      );
    }
    return result.expense;
  });
}

export async function withdrawExpense(user: AuthUser, id: string) {
  return withTransaction(async (client) => {
    const expense = await repo.getByIdForUpdate(client, user.org_id, id);
    if (!expense) throw Errors.notFound('Expense not found');
    if (expense.requester_id !== user.id) {
      throw Errors.forbidden('Only the requester can withdraw this expense');
    }
    if (!['submitted', 'in_review', 'draft'].includes(expense.status)) {
      throw Errors.conflict(`Cannot withdraw an expense in status ${expense.status}`);
    }
    await stepRepo.deletePendingSteps(client, user.org_id, id);
    const updated = await repo.updateFields(client, user.org_id, id, { status: 'withdrawn' });
    await recordAudit(
      {
        orgId: user.org_id,
        actorId: user.id,
        action: 'expense.withdrawn',
        entityType: 'expense',
        entityId: id,
        before: { status: expense.status },
        after: { status: 'withdrawn' }
      },
      client
    );
    return updated;
  });
}

export async function deleteExpense(user: AuthUser, id: string) {
  const expense = await repo.getById(user.org_id, id);
  if (!expense) throw Errors.notFound('Expense not found');
  if (expense.requester_id !== user.id) throw Errors.forbidden();
  if (expense.status !== 'draft') {
    throw Errors.conflict('Only draft expenses can be deleted');
  }
  await repo.deleteExpense(user.org_id, id);
  return { deleted: true };
}

export async function history(user: AuthUser, id: string) {
  const expense = await repo.getById(user.org_id, id);
  if (!expense) throw Errors.notFound('Expense not found');
  await assertCanView(user, expense.requester_id);
  return getHistory(user.org_id, 'expense', id);
}

async function assertCanView(user: AuthUser, requesterId: string): Promise<void> {
  if (requesterId === user.id) return;
  if (hasPermission(user.role, 'expense:read:all')) return;
  if (hasPermission(user.role, 'expense:read:reportees')) {
    const reportees = await userRepo.listReportees(user.org_id, user.id);
    if (reportees.some((r) => r.id === requesterId)) return;
  }
  throw Errors.forbidden();
}
