import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './category.service';

export const categoryRouter = Router();

categoryRouter.use(authenticate);

// Any authenticated user can read categories (needed to create an expense).
categoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listCategories(req.user!.org_id));
  })
);

categoryRouter.post(
  '/',
  requirePermission('policy:manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createCategory(req.user!.org_id, req.body));
  })
);

categoryRouter.delete(
  '/:id',
  requirePermission('policy:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteCategory(req.user!.org_id, req.params.id));
  })
);
