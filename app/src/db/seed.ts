import { randomUUID } from 'crypto';
import { query, closePool } from './pool';
import { runMigrations } from './migrate';
import { hashPassword } from '../auth/password';
import { AuthUser, Role } from '../types';
import * as expenseService from '../modules/expenses/expense.service';
import * as attachmentService from '../modules/attachments/attachment.service';
import { seedDefaults as seedCategories } from '../modules/categories/category.service';

// A tiny valid PNG used to demonstrate the bill-upload feature in seeded data.
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function attachSampleBill(
  user: AuthUser,
  expenseId: string,
  filename: string
): Promise<void> {
  await attachmentService.uploadBill(user, expenseId, {
    originalname: filename,
    mimetype: 'image/png',
    size: SAMPLE_PNG.length,
    buffer: SAMPLE_PNG
  });
}

async function truncateAll(): Promise<void> {
  await query(`TRUNCATE idempotency_keys, notifications, audit_logs, approval_steps,
    attachments, expense_requests, budgets, policies, expense_categories, users, organizations CASCADE`);
}

async function createOrg(name: string): Promise<string> {
  const id = randomUUID();
  await query(
    'INSERT INTO organizations (id, name, base_currency) VALUES ($1,$2,$3)',
    [id, name, 'INR']
  );
  return id;
}

async function createUser(
  orgId: string,
  name: string,
  email: string,
  role: Role,
  managerId: string | null
): Promise<AuthUser> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, manager_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, orgId, name, email, await hashPassword('password123'), role, managerId]
  );
  return { id, org_id: orgId, role, email };
}

async function createPolicy(orgId: string): Promise<void> {
  await query(
    `INSERT INTO policies (id, org_id, name, rules_json, tolerance_percent, active, version)
     VALUES ($1,$2,$3,$4,$5,true,1)`,
    [
      randomUUID(),
      orgId,
      'Default approval policy',
      JSON.stringify({
        currency: 'INR',
        rules: [
          { min: 0, max: 5000, levels: ['manager'] },
          { min: 5001, max: 50000, levels: ['manager', 'finance'] },
          { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
        ]
      }),
      10
    ]
  );
}

async function createBudget(orgId: string): Promise<void> {
  await query(
    `INSERT INTO budgets (id, org_id, user_id, scope, period, limit_amount, currency)
     VALUES ($1,$2,NULL,'org','monthly',$3,'INR')`,
    [randomUUID(), orgId, 2000000]
  );
}

async function seed(): Promise<void> {
  await runMigrations();
  await truncateAll();

  // ---- Org 1: Acme Corp ----
  const acme = await createOrg('Acme Corp');
  const admin = await createUser(acme, 'Aditi Admin', 'admin@acme.test', 'admin', null);
  const cfo = await createUser(acme, 'Neha Finance', 'cfo@acme.test', 'finance', null);
  const manager = await createUser(acme, 'Amit Manager', 'manager@acme.test', 'manager', null);
  const riya = await createUser(acme, 'Riya Sharma', 'riya@acme.test', 'employee', manager.id);
  const arjun = await createUser(acme, 'Arjun Verma', 'arjun@acme.test', 'employee', manager.id);
  await createPolicy(acme);
  await createBudget(acme);
  await seedCategories(acme, (sql, params) => query(sql, params as unknown[]));

  // Small reimbursement (single-level: manager) -> approved
  const e1 = await expenseService.createExpense(riya, {
    type: 'reimbursement',
    category: 'meals',
    description: 'Team lunch',
    amount: 3200,
    currency: 'INR'
  });
  await expenseService.submitExpense(riya, e1.id);
  await expenseService.approveExpense(manager, e1.id, 'Approved');

  // Medium reimbursement (manager -> finance) -> fully approved
  const e2 = await expenseService.createExpense(riya, {
    type: 'reimbursement',
    category: 'travel',
    description: 'Client visit flight',
    amount: 22000,
    currency: 'INR'
  });
  await expenseService.submitExpense(riya, e2.id);
  await expenseService.approveExpense(manager, e2.id, 'OK from manager');
  await expenseService.approveExpense(cfo, e2.id, 'OK from finance');

  // Company-paid, large (manager -> finance -> admin) -> pending at finance
  const e3 = await expenseService.createExpense(arjun, {
    type: 'company_paid',
    category: 'software',
    description: 'Annual SaaS license (vendor invoice)',
    amount: 80000,
    currency: 'INR'
  });
  await expenseService.submitExpense(arjun, e3.id);
  await attachSampleBill(arjun, e3.id, 'saas-invoice.png');
  await expenseService.approveExpense(manager, e3.id, 'Needed for team');

  // Rejected example
  const e4 = await expenseService.createExpense(arjun, {
    type: 'reimbursement',
    category: 'misc',
    description: 'Personal gadget',
    amount: 15000,
    currency: 'INR'
  });
  await expenseService.submitExpense(arjun, e4.id);
  await expenseService.rejectExpense(manager, e4.id, 'Not a business expense');

  // Foreign currency draft (USD) left as draft
  await expenseService.createExpense(riya, {
    type: 'reimbursement',
    category: 'travel',
    description: 'Hotel in USD',
    amount: 200,
    currency: 'USD'
  });

  // Pending at manager (just submitted)
  const e6 = await expenseService.createExpense(riya, {
    type: 'reimbursement',
    category: 'meals',
    description: 'Client dinner',
    amount: 4500,
    currency: 'INR'
  });
  await attachSampleBill(riya, e6.id, 'client-dinner-receipt.png');
  await expenseService.submitExpense(riya, e6.id);

  // ---- Org 2: Globex (multi-tenancy isolation demo) ----
  const globex = await createOrg('Globex Inc');
  const gAdmin = await createUser(globex, 'Gina Admin', 'admin@globex.test', 'admin', null);
  await createUser(globex, 'Gabe Manager', 'manager@globex.test', 'manager', null);
  await createPolicy(globex);
  await createBudget(globex);
  await seedCategories(globex, (sql, params) => query(sql, params as unknown[]));
  void gAdmin;

  // eslint-disable-next-line no-console
  console.log('Seed complete.');
  // eslint-disable-next-line no-console
  console.log('Login with any of these (password: password123):');
  // eslint-disable-next-line no-console
  console.log('  admin@acme.test / cfo@acme.test / manager@acme.test / riya@acme.test / arjun@acme.test');
}

if (require.main === module) {
  seed()
    .then(() => closePool())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

export { seed };
