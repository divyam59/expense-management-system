import { PoolClient } from 'pg';

/**
 * Returns a previously stored response for this idempotency key, or null.
 * Used so a retried approve/reject/submit does not double-apply.
 */
export async function getIdempotentResponse(
  client: PoolClient,
  key: string,
  orgId: string,
  endpoint: string
): Promise<unknown | null> {
  const res = await client.query(
    'SELECT response_json FROM idempotency_keys WHERE key=$1 AND org_id=$2 AND endpoint=$3',
    [key, orgId, endpoint]
  );
  return res.rows[0]?.response_json ?? null;
}

export async function saveIdempotentResponse(
  client: PoolClient,
  key: string,
  orgId: string,
  endpoint: string,
  response: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (key, org_id, endpoint, response_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (key, org_id, endpoint) DO NOTHING`,
    [key, orgId, endpoint, JSON.stringify(response)]
  );
}
