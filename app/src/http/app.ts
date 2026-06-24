import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { AppError } from './errors';
import { metricsMiddleware, renderPrometheus } from '../metrics/metrics';
import { authRouter, userRouter } from '../modules/users/user.routes';
import { expenseRouter, approvalRouter } from '../modules/expenses/expense.routes';
import { policyRouter } from '../modules/policy/policy.routes';
import { budgetRouter } from '../modules/budget/budget.routes';
import { analyticsRouter } from '../modules/analytics/analytics.routes';
import { attachmentRouter } from '../modules/attachments/attachment.routes';
import { notificationRouter } from '../modules/notifications/notification.routes';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/metrics', (_req, res) => {
    res.type('text/plain').send(renderPrometheus());
  });

  app.use('/auth', authRouter);
  app.use('/users', userRouter);
  app.use('/expenses', expenseRouter);
  app.use('/approvals', approvalRouter);
  app.use('/policies', policyRouter);
  app.use('/budgets', budgetRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/attachments', attachmentRouter);
  app.use('/notifications', notificationRouter);

  // Static UI
  app.use('/', express.static(path.join(__dirname, '../../public')));

  // 404 for unmatched API routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || req.accepts('json')) {
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    next();
  });

  // Central error handler -> consistent error envelope
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details }
      });
    }
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    return res
      .status(500)
      .json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
