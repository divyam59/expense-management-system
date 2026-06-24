import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate } from '../../auth/middleware';
import { Errors } from '../../http/errors';
import * as service from './notification.service';

export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listNotifications(req.user!.org_id, req.user!.id));
  })
);

notificationRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const ok = await service.markRead(req.user!.org_id, req.user!.id, req.params.id);
    if (!ok) throw Errors.notFound('Notification not found');
    res.json({ read: true });
  })
);
