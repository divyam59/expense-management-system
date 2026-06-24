import { config } from '../../config';

/**
 * Audit log S3 shipping (feature-flagged). In the prototype this is MOCKED: when
 * enabled, entries are buffered and "shipped" to an in-memory sink that stands in
 * for S3 (NDJSON, partitioned by org_id/date). In production this would be an
 * async batched writer to S3 with retries + DLQ. It is best-effort and must never
 * block or fail the primary Postgres write.
 */
const shippedSink: Record<string, string[]> = {};

export async function shipAuditToS3(entry: { id: string; orgId: string }): Promise<void> {
  if (!config.auditS3ShippingEnabled) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const key = `${config.auditS3Bucket}/${entry.orgId}/${date}.ndjson`;
    shippedSink[key] = shippedSink[key] || [];
    shippedSink[key].push(JSON.stringify(entry));
  } catch {
    // swallow: shipping is best-effort
  }
}

export function getShippedAudit(): Record<string, string[]> {
  return shippedSink;
}

export function clearShippedAudit(): void {
  for (const k of Object.keys(shippedSink)) delete shippedSink[k];
}
