import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './jwt';
import { Errors } from '../http/errors';
import { hasPermission, Permission } from '../rbac/permissions';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(Errors.unauthorized());
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    next(Errors.unauthorized('Invalid or expired token'));
  }
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (!hasPermission(req.user.role, permission)) {
      return next(Errors.forbidden());
    }
    next();
  };
}

/** Convenience guard: any of the listed permissions is sufficient. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (permissions.some((p) => hasPermission(req.user!.role, p))) return next();
    next(Errors.forbidden());
  };
}
