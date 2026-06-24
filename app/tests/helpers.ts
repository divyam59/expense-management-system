import { randomUUID } from 'crypto';
import { query } from '../src/db/pool';
import { hashPassword } from '../src/auth/password';
import { signAccessToken } from '../src/auth/jwt';
import { AuthUser, Role } from '../src/types';

export async function resetDb(): Promise<void> {
  await query(`TRUNCATE idempotency_keys, notifications, audit_logs, approval_steps,
    attachments, expense_requests, budgets, policies, expense_categories, users, organizations CASCADE`);
}

export async function makeOrg(name = 'TestCo'): Promise<string> {
  const id = randomUUID();
  await query('INSERT INTO organizations (id, name, base_currency) VALUES ($1,$2,$3)', [
    id,
    name,
    'INR'
  ]);
  return id;
}

export async function makeUser(
  orgId: string,
  role: Role,
  opts: { email?: string; managerId?: string | null; name?: string } = {}
): Promise<AuthUser> {
  const id = randomUUID();
  const email = opts.email ?? `${role}-${id.slice(0, 8)}@test.local`;
  await query(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, manager_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      orgId,
      opts.name ?? `${role} user`,
      email,
      await hashPassword('password123'),
      role,
      opts.managerId ?? null
    ]
  );
  return { id, org_id: orgId, role, email };
}

export async function makePolicy(
  orgId: string,
  tolerance = 10
): Promise<void> {
  await query(
    `INSERT INTO policies (id, org_id, name, rules_json, tolerance_percent, active, version)
     VALUES ($1,$2,$3,$4,$5,true,1)`,
    [
      randomUUID(),
      orgId,
      'Test policy',
      JSON.stringify({
        currency: 'INR',
        rules: [
          { min: 0, max: 5000, levels: ['manager'] },
          { min: 5001, max: 50000, levels: ['manager', 'finance'] },
          { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
        ]
      }),
      tolerance
    ]
  );
}

export async function makeOrgBudget(orgId: string, limit = 2000000): Promise<void> {
  await query(
    `INSERT INTO budgets (id, org_id, user_id, scope, period, limit_amount, currency)
     VALUES ($1,$2,NULL,'org','monthly',$3,'INR')`,
    [randomUUID(), orgId, limit]
  );
}

export function token(user: AuthUser): string {
  return signAccessToken(user);
}

export function bearer(user: AuthUser): string {
  return `Bearer ${signAccessToken(user)}`;
}

/** Standard fixture: org with admin, finance, manager, two employees, policy, budget. */
export async function standardFixture() {
  const orgId = await makeOrg();
  const admin = await makeUser(orgId, 'admin', { email: 'admin@test.local' });
  const finance = await makeUser(orgId, 'finance', { email: 'fin@test.local' });
  const manager = await makeUser(orgId, 'manager', { email: 'mgr@test.local' });
  const emp = await makeUser(orgId, 'employee', {
    email: 'emp@test.local',
    managerId: manager.id
  });
  const emp2 = await makeUser(orgId, 'employee', {
    email: 'emp2@test.local',
    managerId: manager.id
  });
  await makePolicy(orgId);
  await makeOrgBudget(orgId);
  return { orgId, admin, finance, manager, emp, emp2 };
}
