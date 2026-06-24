import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './analytics.service';

export const analyticsRouter = Router();

analyticsRouter.use(authenticate, requirePermission('analytics:view'));

analyticsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => res.json(await service.summary(req.user!.org_id)))
);
analyticsRouter.get(
  '/spend',
  asyncHandler(async (req, res) => res.json(await service.spendOverTime(req.user!.org_id)))
);
analyticsRouter.get(
  '/by-status',
  asyncHandler(async (req, res) => res.json(await service.byStatus(req.user!.org_id)))
);
analyticsRouter.get(
  '/by-category',
  asyncHandler(async (req, res) => res.json(await service.byCategory(req.user!.org_id)))
);
analyticsRouter.get(
  '/audit-volume',
  asyncHandler(async (req, res) => res.json(await service.auditVolume(req.user!.org_id)))
);
