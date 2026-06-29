import { randomUUID } from 'crypto';
import { query, closePool } from './pool';
import { runMigrations } from './migrate';
import { hashPassword } from '../auth/password';
import { Role } from '../types';
import { seedDefaults as seedCategories } from '../modules/categories/category.service';

/**
 * Minimal "fresh start" reset: wipes ALL data and leaves a single organisation
 * with exactly one user per role (admin, finance, manager, employee) plus the
 * default expense categories. No policies, budgets, or expenses are created — so
 * the rest of the setup (policies, more employees, expenses, approvals) can be
 * walked through by hand from a clean slate.
 */
async function truncateAll(): Promise<void> {
  await query(`TRUNCATE idempotency_keys, notifications, audit_logs, approval_steps,
    attachments, expense_requests, budgets, policies, expense_categories, users, organizations CASCADE`);
}

async function createOrg(name: string): Promise<string> {
  const id = randomUUID();
  await query('INSERT INTO organizations (id, name, base_currency) VALUES ($1,$2,$3)', [
    id,
    name,
    'INR'
  ]);
  return id;
}

async function createUser(
  orgId: string,
  name: string,
  email: string,
  role: Role,
  managerId: string | null
): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, manager_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, orgId, name, email, await hashPassword('password123'), role, managerId]
  );
  return id;
}

async function seedMinimal(): Promise<void> {
  await runMigrations();
  await truncateAll();

  const acme = await createOrg('Acme Corp');
  await createUser(acme, 'Aditi Admin', 'admin@acme.test', 'admin', null);
  await createUser(acme, 'Neha Finance', 'cfo@acme.test', 'finance', null);
  const manager = await createUser(acme, 'Amit Manager', 'manager@acme.test', 'manager', null);
  await createUser(acme, 'Riya Sharma', 'riya@acme.test', 'employee', manager);
  await seedCategories(acme, (sql, params) => query(sql, params as unknown[]));

  // eslint-disable-next-line no-console
  console.log('Minimal reset complete: 1 org (Acme Corp), 4 users (one per role), default categories.');
  // eslint-disable-next-line no-console
  console.log('No policies, budgets, or expenses — build those by hand.');
  // eslint-disable-next-line no-console
  console.log('Login (password: password123):');
  // eslint-disable-next-line no-console
  console.log('  admin@acme.test · cfo@acme.test · manager@acme.test · riya@acme.test');
}

if (require.main === module) {
  seedMinimal()
    .then(() => closePool())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Minimal reset failed:', err);
      process.exit(1);
    });
}

export { seedMinimal };
