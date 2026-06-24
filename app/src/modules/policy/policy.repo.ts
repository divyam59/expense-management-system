import { query } from '../../db/pool';
import { Policy } from '../../types';

export async function insertPolicy(p: {
  id: string;
  org_id: string;
  name: string;
  rules_json: unknown;
  tolerance_percent: number;
}): Promise<Policy> {
  const res = await query<Policy>(
    `INSERT INTO policies (id, org_id, name, rules_json, tolerance_percent, active, version)
     VALUES ($1,$2,$3,$4,$5,true,1) RETURNING *`,
    [p.id, p.org_id, p.name, JSON.stringify(p.rules_json), p.tolerance_percent]
  );
  return res.rows[0];
}

export async function listPolicies(orgId: string): Promise<Policy[]> {
  const res = await query<Policy>(
    'SELECT * FROM policies WHERE org_id=$1 ORDER BY created_at ASC',
    [orgId]
  );
  return res.rows;
}

export async function getActivePolicy(orgId: string): Promise<Policy | null> {
  const res = await query<Policy>(
    'SELECT * FROM policies WHERE org_id=$1 AND active=true ORDER BY created_at DESC LIMIT 1',
    [orgId]
  );
  return res.rows[0] ?? null;
}

export async function updatePolicy(
  orgId: string,
  id: string,
  fields: Partial<Pick<Policy, 'name' | 'tolerance_percent' | 'active'>> & {
    rules_json?: unknown;
  }
): Promise<Policy | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k}=$${i++}`);
    params.push(k === 'rules_json' ? JSON.stringify(v) : v);
  }
  if (sets.length === 0) {
    const cur = await query<Policy>('SELECT * FROM policies WHERE id=$1 AND org_id=$2', [
      id,
      orgId
    ]);
    return cur.rows[0] ?? null;
  }
  params.push(id, orgId);
  const res = await query<Policy>(
    `UPDATE policies SET ${sets.join(', ')}, version=version+1 WHERE id=$${i++} AND org_id=$${i} RETURNING *`,
    params
  );
  return res.rows[0] ?? null;
}

export async function deletePolicy(orgId: string, id: string): Promise<boolean> {
  const res = await query('DELETE FROM policies WHERE id=$1 AND org_id=$2', [id, orgId]);
  return (res.rowCount ?? 0) > 0;
}
