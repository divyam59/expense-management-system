import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer } from '../helpers';

const app = createApp();

async function draft(authUser: { id: string }, amount: number, currency = 'INR') {
  const res = await request(app)
    .post('/expenses')
    .set('Authorization', bearer(authUser as never))
    .send({ type: 'reimbursement', category: 'travel', amount, currency });
  return res.body.id as string;
}

describe('organization base currency', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('honors the org base currency at signup + login and converts expenses into it', async () => {
    const su = await request(app).post('/auth/signup').send({
      orgName: 'Globex',
      baseCurrency: 'USD',
      adminName: 'Gina',
      email: 'gina@globex.test',
      password: 'password123'
    });
    expect(su.status).toBe(201);
    expect(su.body.organization.base_currency).toBe('USD');
    const tok = `Bearer ${su.body.accessToken}`;

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'gina@globex.test', password: 'password123' });
    expect(login.body.organization.base_currency).toBe('USD');

    // USD expense in a USD org -> stored 1:1 in the base currency.
    const usd = await request(app)
      .post('/expenses')
      .set('Authorization', tok)
      .send({ type: 'reimbursement', category: 'travel', amount: 100, currency: 'USD' });
    expect(usd.status).toBe(201);
    expect(Number(usd.body.base_amount)).toBe(100);
    expect(Number(usd.body.fx_rate)).toBe(1);

    // INR expense in a USD org -> converted into USD (8300 INR / 83 = 100 USD).
    const inr = await request(app)
      .post('/expenses')
      .set('Authorization', tok)
      .send({ type: 'reimbursement', category: 'travel', amount: 8300, currency: 'INR' });
    expect(inr.status).toBe(201);
    expect(Number(inr.body.base_amount)).toBeCloseTo(100, 2);
  });
});

describe('per-user (person-level) budgets', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('upserts a personal monthly limit and enforces it at submit', async () => {
    const set1 = await request(app)
      .post('/budgets')
      .set('Authorization', bearer(fx.admin))
      .send({ userId: fx.emp.id, scope: 'user', period: 'monthly', limitAmount: 5000, currency: 'INR' });
    expect(set1.status).toBe(201);

    // Re-setting updates the same row (no duplicate, ambiguous budgets).
    const set2 = await request(app)
      .post('/budgets')
      .set('Authorization', bearer(fx.admin))
      .send({ userId: fx.emp.id, scope: 'user', period: 'monthly', limitAmount: 6000, currency: 'INR' });
    expect(set2.status).toBe(201);

    const list = await request(app).get('/budgets').set('Authorization', bearer(fx.admin));
    const empBudgets = list.body.filter(
      (b: { user_id: string; period: string }) => b.user_id === fx.emp.id && b.period === 'monthly'
    );
    expect(empBudgets).toHaveLength(1);
    expect(Number(empBudgets[0].limit_amount)).toBe(6000);

    // Within the personal limit -> submit succeeds.
    const e1 = await draft(fx.emp, 4000);
    const s1 = await request(app).post(`/expenses/${e1}/submit`).set('Authorization', bearer(fx.emp));
    expect(s1.status).toBe(200);

    // 4000 + 3000 > 6000 personal limit -> blocked at submit.
    const e2 = await draft(fx.emp, 3000);
    const s2 = await request(app).post(`/expenses/${e2}/submit`).set('Authorization', bearer(fx.emp));
    expect(s2.status).toBe(422);
    expect(s2.body.error.message).toMatch(/budget/i);
  });

  it('a non-budget-manager cannot set budgets', async () => {
    const res = await request(app)
      .post('/budgets')
      .set('Authorization', bearer(fx.emp))
      .send({ userId: fx.emp.id, scope: 'user', period: 'monthly', limitAmount: 1000, currency: 'INR' });
    expect(res.status).toBe(403);
  });
});
