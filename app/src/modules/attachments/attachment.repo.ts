import { query } from '../../db/pool';
import { Attachment } from '../../types';

export async function insertAttachment(a: {
  id: string;
  org_id: string;
  expense_id: string;
  s3_key: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by: string;
}): Promise<Attachment> {
  const res = await query<Attachment>(
    `INSERT INTO attachments
       (id, org_id, expense_id, s3_key, filename, content_type, size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      a.id,
      a.org_id,
      a.expense_id,
      a.s3_key,
      a.filename,
      a.content_type,
      a.size,
      a.uploaded_by
    ]
  );
  return res.rows[0];
}

export async function listByExpense(
  orgId: string,
  expenseId: string
): Promise<Attachment[]> {
  const res = await query<Attachment>(
    'SELECT * FROM attachments WHERE org_id=$1 AND expense_id=$2 ORDER BY uploaded_at ASC',
    [orgId, expenseId]
  );
  return res.rows;
}

export async function getById(orgId: string, id: string): Promise<Attachment | null> {
  const res = await query<Attachment>(
    'SELECT * FROM attachments WHERE id=$1 AND org_id=$2',
    [id, orgId]
  );
  return res.rows[0] ?? null;
}
