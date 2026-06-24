import { query } from '../../db/pool';

export interface Category {
  id: string;
  org_id: string;
  name: string;
  active: boolean;
  created_at: string;
}

export async function listCategories(orgId: string): Promise<Category[]> {
  const res = await query<Category>(
    'SELECT * FROM expense_categories WHERE org_id=$1 AND active=true ORDER BY name ASC',
    [orgId]
  );
  return res.rows;
}

export async function findByName(orgId: string, name: string): Promise<Category | null> {
  const res = await query<Category>(
    'SELECT * FROM expense_categories WHERE org_id=$1 AND lower(name)=lower($2) LIMIT 1',
    [orgId, name]
  );
  return res.rows[0] ?? null;
}

export async function insertCategory(c: {
  id: string;
  org_id: string;
  name: string;
}): Promise<Category> {
  const res = await query<Category>(
    `INSERT INTO expense_categories (id, org_id, name) VALUES ($1,$2,$3) RETURNING *`,
    [c.id, c.org_id, c.name]
  );
  return res.rows[0];
}

export async function deactivate(orgId: string, id: string): Promise<boolean> {
  const res = await query(
    'UPDATE expense_categories SET active=false WHERE id=$1 AND org_id=$2',
    [id, orgId]
  );
  return (res.rowCount ?? 0) > 0;
}
