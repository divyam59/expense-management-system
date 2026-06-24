import { query } from '../../db/pool';
import { Role, User } from '../../types';

export async function findByEmail(email: string): Promise<User | null> {
  const res = await query<User>('SELECT * FROM users WHERE email=$1 AND is_active=true', [
    email
  ]);
  return res.rows[0] ?? null;
}

export async function findById(orgId: string, id: string): Promise<User | null> {
  const res = await query<User>('SELECT * FROM users WHERE id=$1 AND org_id=$2', [id, orgId]);
  return res.rows[0] ?? null;
}

export async function listByOrg(orgId: string): Promise<User[]> {
  const res = await query<User>(
    'SELECT * FROM users WHERE org_id=$1 ORDER BY created_at ASC',
    [orgId]
  );
  return res.rows;
}

export async function listReportees(orgId: string, managerId: string): Promise<User[]> {
  const res = await query<User>(
    'SELECT * FROM users WHERE org_id=$1 AND manager_id=$2',
    [orgId, managerId]
  );
  return res.rows;
}

export async function countActiveByRole(orgId: string, role: Role): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users WHERE org_id=$1 AND role=$2 AND is_active=true',
    [orgId, role]
  );
  return Number(res.rows[0].count);
}

export async function firstUserWithRole(orgId: string, role: Role): Promise<User | null> {
  const res = await query<User>(
    'SELECT * FROM users WHERE org_id=$1 AND role=$2 AND is_active=true ORDER BY created_at ASC LIMIT 1',
    [orgId, role]
  );
  return res.rows[0] ?? null;
}

export async function insertUser(u: {
  id: string;
  org_id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  manager_id: string | null;
}): Promise<User> {
  const res = await query<User>(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, manager_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.id, u.org_id, u.name, u.email, u.password_hash, u.role, u.manager_id]
  );
  return res.rows[0];
}

export async function updateUser(
  orgId: string,
  id: string,
  fields: Partial<Pick<User, 'name' | 'role' | 'manager_id' | 'is_active'>>
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k}=$${i++}`);
    params.push(v);
  }
  if (sets.length === 0) return findById(orgId, id);
  params.push(id, orgId);
  const res = await query<User>(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${i++} AND org_id=$${i} RETURNING *`,
    params
  );
  return res.rows[0] ?? null;
}
