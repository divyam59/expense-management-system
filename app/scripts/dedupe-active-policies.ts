import { query, closePool } from '../src/db/pool';

// One-off: enforce the single-active-policy invariant on pre-existing data by
// keeping only the most recently created active policy per org.
async function main(): Promise<void> {
  const res = await query(
    `UPDATE policies SET active=false
     WHERE active=true
       AND id NOT IN (
         SELECT DISTINCT ON (org_id) id
         FROM policies
         WHERE active=true
         ORDER BY org_id, created_at DESC
       )`
  );
  // eslint-disable-next-line no-console
  console.log(`Deactivated ${res.rowCount ?? 0} extra active policies.`);
}

main()
  .then(() => closePool())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Dedupe failed:', err);
    process.exit(1);
  });
