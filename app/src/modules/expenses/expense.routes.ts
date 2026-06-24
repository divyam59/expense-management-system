import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './expense.service';
import * as stepRepo from '../workflow/approval.repo';

export const expenseRouter = Router();

expenseRouter.use(authenticate);

expenseRouter.post(
  '/',
  requirePermission('expense:create'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createExpense(req.user!, req.body));
  })
);

expenseRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listExpenses(req.user!, req.query as Record<string, unknown>));
  })
);

expenseRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.getExpense(req.user!, req.params.id));
  })
);

expenseRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.editExpense(req.user!, req.params.id, req.body));
  })
);

expenseRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.deleteExpense(req.user!, req.params.id));
  })
);

expenseRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    res.json(await service.submitExpense(req.user!, req.params.id));
  })
);

expenseRouter.post(
  '/:id/approve',
  requirePermission('expense:approve'),
  asyncHandler(async (req, res) => {
    const key = req.header('Idempotency-Key') || undefined;
    res.json(await service.approveExpense(req.user!, req.params.id, req.body?.reason ?? null, key));
  })
);

expenseRouter.post(
  '/:id/reject',
  requirePermission('expense:approve'),
  asyncHandler(async (req, res) => {
    const key = req.header('Idempotency-Key') || undefined;
    res.json(await service.rejectExpense(req.user!, req.params.id, req.body?.reason ?? '', key));
  })
);

expenseRouter.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    res.json(await service.withdrawExpense(req.user!, req.params.id));
  })
);

expenseRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    res.json(await service.history(req.user!, req.params.id));
  })
);

export const approvalRouter = Router();
approvalRouter.use(authenticate);

approvalRouter.get(
  '/pending',
  requirePermission('expense:approve'),
  asyncHandler(async (req, res) => {
    res.json(await stepRepo.pendingForApprover(req.user!.org_id, req.user!.id));
  })
);
