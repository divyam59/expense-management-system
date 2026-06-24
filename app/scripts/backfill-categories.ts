import { query, closePool } from '../src/db/pool';
import { DEFAULT_CATEGORIES, seedDefaults } from '../src/modules/categories/category.service';

async function main(): Promise<void> {
  const orgs = await query<{ id: string }>('SELECT id FROM organizations');
  let touched = 0;
  for (const org of orgs.rows) {
    const existing = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM expense_categories WHERE org_id=$1',
      [org.id]
    );
    if (Number(existing.rows[0].count) > 0) continue;
    await seedDefaults(org.id, (sql, params) => query(sql, params as unknown[]));
    touched += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`Backfilled ${DEFAULT_CATEGORIES.length} categories for ${touched} org(s).`);
}

main()
  .then(() => closePool())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Backfill failed:', err);
    process.exit(1);
  });
