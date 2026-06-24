import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './policy.service';

export const policyRouter = Router();

policyRouter.use(authenticate);

policyRouter.get(
  '/',
  requirePermission('analytics:view'),
  asyncHandler(async (req, res) => {
    res.json(await service.listPolicies(req.user!.org_id));
  })
);

policyRouter.post(
  '/',
  requirePermission('policy:manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createPolicy(req.user!.org_id, req.body));
  })
);

policyRouter.patch(
  '/:id',
  requirePermission('policy:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.updatePolicy(req.user!.org_id, req.params.id, req.body));
  })
);

policyRouter.delete(
  '/:id',
  requirePermission('policy:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.deletePolicy(req.user!.org_id, req.params.id));
  })
);
