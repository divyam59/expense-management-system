import { query } from '../../db/pool';
import { getCache } from '../../cache/cache';

const cache = () => getCache();

export async function summary(orgId: string) {
  const key = `analytics:summary:${orgId}`;
  const cached = await cache().get(key);
  if (cached) return cached;

  const statusCounts = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) AS count FROM expense_requests WHERE org_id=$1 GROUP BY status`,
    [orgId]
  );
  const totals = await query<{ total: string | null; cnt: string }>(
    `SELECT COALESCE(SUM(base_amount),0) AS total, COUNT(*) AS cnt
       FROM expense_requests WHERE org_id=$1 AND status IN ('approved','paid')`,
    [orgId]
  );
  const pending = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM expense_requests WHERE org_id=$1 AND status='in_review'`,
    [orgId]
  );
  const slaBreached = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM expense_requests
      WHERE org_id=$1 AND status='in_review' AND sla_due_at IS NOT NULL AND sla_due_at < now()`,
    [orgId]
  );
  const auditCount = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM audit_logs WHERE org_id=$1`,
    [orgId]
  );

  const result = {
    approvedSpend: Number(totals.rows[0]?.total ?? 0),
    approvedCount: Number(totals.rows[0]?.cnt ?? 0),
    pendingApprovals: Number(pending.rows[0]?.cnt ?? 0),
    slaBreached: Number(slaBreached.rows[0]?.cnt ?? 0),
    auditEvents: Number(auditCount.rows[0]?.cnt ?? 0),
    byStatus: statusCounts.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = Number(r.count);
      return acc;
    }, {})
  };
  await cache().set(key, result);
  return result;
}

export async function byStatus(orgId: string) {
  const res = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) AS count FROM expense_requests WHERE org_id=$1 GROUP BY status`,
    [orgId]
  );
  return res.rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

export async function byCategory(orgId: string) {
  const res = await query<{ category: string; total: string }>(
    `SELECT category, COALESCE(SUM(base_amount),0) AS total
       FROM expense_requests
      WHERE org_id=$1 AND status IN ('approved','paid')
      GROUP BY category ORDER BY total DESC`,
    [orgId]
  );
  return res.rows.map((r) => ({ category: r.category, total: Number(r.total) }));
}

export async function spendOverTime(orgId: string) {
  const res = await query<{ day: string; total: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(base_amount),0) AS total
       FROM expense_requests
      WHERE org_id=$1 AND status IN ('approved','paid')
      GROUP BY 1 ORDER BY 1`,
    [orgId]
  );
  return res.rows.map((r) => ({ day: r.day, total: Number(r.total) }));
}

export async function auditVolume(orgId: string) {
  const res = await query<{ day: string; count: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*) AS count
       FROM audit_logs WHERE org_id=$1 GROUP BY 1 ORDER BY 1`,
    [orgId]
  );
  return res.rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}
