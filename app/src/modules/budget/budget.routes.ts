import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './budget.service';

export const budgetRouter = Router();

budgetRouter.use(authenticate);

budgetRouter.get(
  '/',
  requirePermission('analytics:view'),
  asyncHandler(async (req, res) => {
    res.json(await service.listBudgets(req.user!.org_id));
  })
);

budgetRouter.get(
  '/utilization',
  asyncHandler(async (req, res) => {
    res.json(await service.utilization(req.user!.org_id, req.user!.id));
  })
);

budgetRouter.get(
  '/spend',
  requirePermission('budget:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.monthlySpend(req.user!.org_id));
  })
);

budgetRouter.post(
  '/',
  requirePermission('budget:manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createBudget(req.user!.org_id, req.body));
  })
);
