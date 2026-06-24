import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthUser } from '../types';

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: config.jwtAccessTtl });
}

// Refresh tokens are NOT JWTs — they are opaque, DB-backed, rotated and
// revocable (see auth/refreshToken.ts). Access tokens stay short-lived JWTs.

export function verifyToken(token: string): AuthUser {
  const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  return {
    id: decoded.id,
    org_id: decoded.org_id,
    role: decoded.role,
    email: decoded.email
  };
}
