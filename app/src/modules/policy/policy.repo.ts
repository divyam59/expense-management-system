import { query, withTransaction } from '../../db/pool';
import { Policy } from '../../types';

// A new policy becomes the single active policy for the org: any previously
// active policy is deactivated in the same transaction so there is never any
// ambiguity about which policy drives approvals.
export async function insertPolicy(p: {
  id: string;
  org_id: string;
  name: string;
  rules_json: unknown;
  tolerance_percent: number;
}): Promise<Policy> {
  return withTransaction(async (client) => {
    await client.query('UPDATE policies SET active=false WHERE org_id=$1 AND active=true', [
      p.org_id
    ]);
    const res = await client.query<Policy>(
      `INSERT INTO policies (id, org_id, name, rules_json, tolerance_percent, active, version)
       VALUES ($1,$2,$3,$4,$5,true,1) RETURNING *`,
      [p.id, p.org_id, p.name, JSON.stringify(p.rules_json), p.tolerance_percent]
    );
    return res.rows[0];
  });
}

export async function findByName(orgId: string, name: string): Promise<Policy | null> {
  const res = await query<Policy>(
    'SELECT * FROM policies WHERE org_id=$1 AND lower(name)=lower($2) LIMIT 1',
    [orgId, name]
  );
  return res.rows[0] ?? null;
}

// Activating a policy deactivates every other policy in the org (single active
// policy invariant). Deactivating just flips this one off.
export async function setActive(
  orgId: string,
  id: string,
  active: boolean
): Promise<Policy | null> {
  return withTransaction(async (client) => {
    if (active) {
      await client.query('UPDATE policies SET active=false WHERE org_id=$1 AND id<>$2', [
        orgId,
        id
      ]);
    }
    const res = await client.query<Policy>(
      `UPDATE policies SET active=$3, version=version+1 WHERE id=$1 AND org_id=$2 RETURNING *`,
      [id, orgId, active]
    );
    return res.rows[0] ?? null;
  });
}

export async function listPolicies(orgId: string): Promise<Policy[]> {
  const res = await query<Policy>(
    'SELECT * FROM policies WHERE org_id=$1 ORDER BY created_at ASC',
    [orgId]
  );
  return res.rows;
}

export async function getById(orgId: string, id: string): Promise<Policy | null> {
  const res = await query<Policy>('SELECT * FROM policies WHERE id=$1 AND org_id=$2', [
    id,
    orgId
  ]);
  return res.rows[0] ?? null;
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
