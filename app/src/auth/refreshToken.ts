import { createHash, randomBytes, randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { query } from '../db/pool';
import { config } from '../config';
import { Errors } from '../http/errors';
import { AuthUser, User } from '../types';
import { findById } from '../modules/users/user.repo';

// Refresh tokens are opaque random strings. We persist only their SHA-256 hash,
// so a DB leak does not expose usable tokens (same reasoning as password hashes).
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface RefreshRow {
  id: string;
  org_id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
}

async function createToken(
  user: AuthUser,
  client?: PoolClient
): Promise<{ id: string; raw: string }> {
  const raw = randomBytes(32).toString('hex');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.jwtRefreshTtl * 1000).toISOString();
  const sql = `INSERT INTO refresh_tokens (id, org_id, user_id, token_hash, expires_at)
               VALUES ($1,$2,$3,$4,$5)`;
  const params = [id, user.org_id, user.id, sha256(raw), expiresAt];
  if (client) await client.query(sql, params);
  else await query(sql, params);
  return { id, raw };
}

/** Issue a new refresh token (stored hashed). Returns the raw token to the client. */
export async function issueRefreshToken(user: AuthUser, client?: PoolClient): Promise<string> {
  return (await createToken(user, client)).raw;
}

/**
 * Rotate a refresh token: validate it, single-use-revoke it, and issue a
 * replacement. If an already-revoked token is presented (replay), treat it as a
 * theft signal and defensively revoke every live session for that user.
 */
export async function rotateRefreshToken(
  rawToken: string
): Promise<{ user: User; refreshToken: string }> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw Errors.unauthorized('Missing refresh token');
  }
  const res = await query<RefreshRow>(
    'SELECT * FROM refresh_tokens WHERE token_hash=$1',
    [sha256(rawToken)]
  );
  const row = res.rows[0];
  if (!row) throw Errors.unauthorized('Invalid refresh token');

  if (row.revoked_at) {
    await query(
      'UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
      [row.user_id]
    );
    throw Errors.unauthorized('Refresh token reuse detected; all sessions revoked');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Errors.unauthorized('Refresh token expired');
  }

  // Re-read the user so a rotated token always reflects current role / active state.
  const user = await findById(row.org_id, row.user_id);
  if (!user || !user.is_active) throw Errors.unauthorized('User is inactive');

  const auth: AuthUser = { id: user.id, org_id: user.org_id, role: user.role, email: user.email };
  const next = await createToken(auth);
  await query('UPDATE refresh_tokens SET revoked_at=now(), replaced_by=$2 WHERE id=$1', [
    row.id,
    next.id
  ]);
  return { user, refreshToken: next.raw };
}

/** Revoke a refresh token (logout). Idempotent — unknown/already-revoked is a no-op. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  if (!rawToken || typeof rawToken !== 'string') return;
  await query(
    'UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
    [sha256(rawToken)]
  );
}
