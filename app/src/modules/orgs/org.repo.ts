import { query } from '../../db/pool';
import { Organization } from '../../types';

export async function getOrgById(orgId: string): Promise<Organization | null> {
  const res = await query<Organization>(
    'SELECT id, name, base_currency, created_at FROM organizations WHERE id=$1',
    [orgId]
  );
  return res.rows[0] ?? null;
}

/** The org's base/reporting currency (what every expense's base_amount is in). */
export async function getBaseCurrency(orgId: string): Promise<string> {
  const org = await getOrgById(orgId);
  return org?.base_currency ?? 'INR';
}
