import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate, requirePermission } from '../../auth/middleware';
import * as service from './user.service';
import * as orgService from '../orgs/org.service';

export const authRouter = Router();

authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    res.status(201).json(await orgService.signup(req.body));
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    res.json(await service.login(email, password));
  })
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    res.json(await service.refresh(refreshToken));
  })
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    res.json(await service.logout(refreshToken));
  })
);

export const userRouter = Router();

userRouter.use(authenticate);

userRouter.get(
  '/',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.listUsers(req.user!.org_id));
  })
);

userRouter.post(
  '/',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createUser(req.user!.org_id, req.body));
  })
);

userRouter.patch(
  '/:id',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    res.json(await service.updateUser(req.user!.org_id, req.params.id, req.body));
  })
);
