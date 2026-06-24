import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { query } from '../../db/pool';

export interface NotifyInput {
  orgId: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Persists an in-app notification (and logs to console as the prototype's
 * "delivery"). Email/SMS/push are documented as the production path. Best-effort
 * with a transaction client when called inside a state change.
 */
export async function notify(input: NotifyInput, client?: PoolClient): Promise<void> {
  const id = randomUUID();
  const sql = `INSERT INTO notifications (id, org_id, user_id, type, payload_json, read)
               VALUES ($1,$2,$3,$4,$5,false)`;
  const params = [id, input.orgId, input.userId, input.type, JSON.stringify(input.payload)];
  if (client) await client.query(sql, params);
  else await query(sql, params);
  // eslint-disable-next-line no-console
  console.log(`[notify] -> user=${input.userId} type=${input.type}`);
}

export async function listNotifications(orgId: string, userId: string) {
  const res = await query(
    `SELECT id, type, payload_json, read, created_at
       FROM notifications WHERE org_id=$1 AND user_id=$2
      ORDER BY created_at DESC LIMIT 100`,
    [orgId, userId]
  );
  return res.rows;
}

export async function markRead(orgId: string, userId: string, id: string): Promise<boolean> {
  const res = await query(
    `UPDATE notifications SET read=true WHERE id=$1 AND org_id=$2 AND user_id=$3`,
    [id, orgId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}
