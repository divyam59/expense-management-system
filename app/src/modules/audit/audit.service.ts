import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { query } from '../../db/pool';
import { shipAuditToS3 } from './s3shipper';

export interface AuditInput {
  orgId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
}

/**
 * Records an immutable audit entry. When a transaction client is provided the
 * entry is written in the SAME transaction as the state change, so the audit log
 * can never diverge from reality. S3 shipping is best-effort and never blocks.
 */
export async function recordAudit(input: AuditInput, client?: PoolClient): Promise<string> {
  const id = randomUUID();
  const params = [
    id,
    input.orgId,
    input.actorId,
    input.action,
    input.entityType,
    input.entityId,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.reason ?? null,
    input.requestId ?? null
  ];
  const sql = `INSERT INTO audit_logs
      (id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json, reason, request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }

  // Best-effort, non-blocking export. Failure here must not affect the txn.
  void shipAuditToS3({ id, ...input });
  return id;
}

export async function getHistory(orgId: string, entityType: string, entityId: string) {
  const res = await query(
    `SELECT id, actor_id, action, entity_type, entity_id, before_json, after_json,
            reason, created_at
       FROM audit_logs
      WHERE org_id=$1 AND entity_type=$2 AND entity_id=$3
      ORDER BY created_at ASC`,
    [orgId, entityType, entityId]
  );
  return res.rows;
}
