import { randomUUID } from 'crypto';
import { z } from 'zod';
import * as repo from './user.repo';
import { hashPassword, verifyPassword } from '../../auth/password';
import { signAccessToken } from '../../auth/jwt';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken
} from '../../auth/refreshToken';
import { Errors } from '../../http/errors';
import { AuthUser, Role, User } from '../../types';

const sanitize = (u: User) => {
  const { password_hash, ...rest } = u;
  return rest;
};

export async function login(email: string, password: string) {
  const user = await repo.findByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw Errors.unauthorized('Invalid email or password');
  }
  const auth: AuthUser = {
    id: user.id,
    org_id: user.org_id,
    role: user.role,
    email: user.email
  };
  return {
    accessToken: signAccessToken(auth),
    refreshToken: await issueRefreshToken(auth),
    user: sanitize(user)
  };
}

/** Exchange a valid refresh token for a fresh access + refresh token (rotation). */
export async function refresh(rawToken: string) {
  const { user, refreshToken } = await rotateRefreshToken(rawToken);
  const auth: AuthUser = {
    id: user.id,
    org_id: user.org_id,
    role: user.role,
    email: user.email
  };
  return { accessToken: signAccessToken(auth), refreshToken, user: sanitize(user) };
}

/** Revoke a refresh token (logout). */
export async function logout(rawToken: string) {
  await revokeRefreshToken(rawToken);
  return { revoked: true };
}

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['employee', 'manager', 'finance', 'admin']),
  managerId: z.string().uuid().nullable().optional()
});

export async function createUser(orgId: string, body: unknown) {
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid user payload', parsed.error.flatten());
  const existing = await repo.findByEmail(parsed.data.email);
  if (existing) throw Errors.conflict('A user with this email already exists');
  const user = await repo.insertUser({
    id: randomUUID(),
    org_id: orgId,
    name: parsed.data.name,
    email: parsed.data.email,
    password_hash: await hashPassword(parsed.data.password),
    role: parsed.data.role as Role,
    manager_id: parsed.data.managerId ?? null
  });
  return sanitize(user);
}

export async function listUsers(orgId: string) {
  return (await repo.listByOrg(orgId)).map(sanitize);
}

export async function updateUser(orgId: string, id: string, body: unknown) {
  const schema = z.object({
    name: z.string().min(1).optional(),
    role: z.enum(['employee', 'manager', 'finance', 'admin']).optional(),
    managerId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional()
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid payload', parsed.error.flatten());
  const updated = await repo.updateUser(orgId, id, {
    name: parsed.data.name,
    role: parsed.data.role as Role | undefined,
    manager_id: parsed.data.managerId,
    is_active: parsed.data.isActive
  });
  if (!updated) throw Errors.notFound('User not found');
  return sanitize(updated);
}
