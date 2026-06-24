import request from 'supertest';
import { createApp } from '../../src/http/app';
import {
  resetDb,
  standardFixture,
  bearer,
  makeOrg,
  makeUser,
  makeOrgBudget
} from '../helpers';
import { query } from '../../src/db/pool';
import { randomUUID } from 'crypto';

const app = createApp();

describe('expense edge cases', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  const draft = async (amount: number, type = 'reimbursement') => {
    const r = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type, category: 'travel', amount, currency: 'INR' });
    return r.body;
  };

  it('400 on invalid create payload', async () => {
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement' });
    expect(res.status).toBe(400);
  });

  it('404 on get missing expense', async () => {
    const res = await request(app)
      .get(`/expenses/${randomUUID()}`)
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(404);
  });

  it('403 when a non-requester edits', async () => {
    const d = await draft(3000);
    const res = await request(app)
      .patch(`/expenses/${d.id}`)
      .set('Authorization', bearer(fx.emp2))
      .send({ amount: 4000 });
    expect(res.status).toBe(403);
  });

  it('422 on edit with unsupported currency', async () => {
    const d = await draft(3000);
    const res = await request(app)
      .patch(`/expenses/${d.id}`)
      .set('Authorization', bearer(fx.emp))
      .send({ currency: 'ZZZ' });
    expect(res.status).toBe(422);
  });

  it('conflict editing an approved expense', async () => {
    const d = await draft(3000);
    await request(app).post(`/expenses/${d.id}/submit`).set('Authorization', bearer(fx.emp));
    await request(app)
      .post(`/expenses/${d.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'ok' });
    const res = await request(app)
      .patch(`/expenses/${d.id}`)
      .set('Authorization', bearer(fx.emp))
      .send({ amount: 4000 });
    expect(res.status).toBe(409);
  });

  it('conflict submitting twice', async () => {
    const d = await draft(3000);
    await request(app).post(`/expenses/${d.id}/submit`).set('Authorization', bearer(fx.emp));
    const res = await request(app)
      .post(`/expenses/${d.id}/submit`)
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(409);
  });

  it('conflict withdrawing an approved expense', async () => {
    const d = await draft(3000);
    await request(app).post(`/expenses/${d.id}/submit`).set('Authorization', bearer(fx.emp));
    await request(app)
      .post(`/expenses/${d.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'ok' });
    const res = await request(app)
      .post(`/expenses/${d.id}/withdraw`)
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(409);
  });

  it('conflict deleting a non-draft expense', async () => {
    const d = await draft(3000);
    await request(app).post(`/expenses/${d.id}/submit`).set('Authorization', bearer(fx.emp));
    const res = await request(app)
      .delete(`/expenses/${d.id}`)
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(409);
  });

  it('403 when unrelated employee views history', async () => {
    const d = await draft(3000);
    const res = await request(app)
      .get(`/expenses/${d.id}/history`)
      .set('Authorization', bearer(fx.emp2));
    expect(res.status).toBe(403);
  });

  it('finance can view any expense (read:all)', async () => {
    const d = await draft(3000);
    const res = await request(app)
      .get(`/expenses/${d.id}`)
      .set('Authorization', bearer(fx.finance));
    expect(res.status).toBe(200);
  });

  it('supports pagination and status filter', async () => {
    await draft(3000);
    await draft(4000);
    const res = await request(app)
      .get('/expenses?scope=mine&limit=1&offset=0&status=draft')
      .set('Authorization', bearer(fx.emp));
    expect(res.body.length).toBe(1);
  });

  it('runs the full three-level company_paid flow', async () => {
    const d = await draft(80000, 'company_paid');
    await request(app).post(`/expenses/${d.id}/submit`).set('Authorization', bearer(fx.emp));
    await request(app).post(`/expenses/${d.id}/approve`).set('Authorization', bearer(fx.manager)).send({ reason: '1' });
    await request(app).post(`/expenses/${d.id}/approve`).set('Authorization', bearer(fx.finance)).send({ reason: '2' });
    const final = await request(app)
      .post(`/expenses/${d.id}/approve`)
      .set('Authorization', bearer(fx.admin))
      .send({ reason: '3' });
    expect(final.body.status).toBe('approved');
  });

  it('422 creating an expense when org has no active policy', async () => {
    const org = await makeOrg('NoPolicy');
    const mgr = await makeUser(org, 'manager', { email: 'm@np.local' });
    const emp = await makeUser(org, 'employee', { email: 'e@np.local', managerId: mgr.id });
    await makeOrgBudget(org);
    // Creation is blocked outright: no policy means the expense could never be
    // routed, so we don't allow even a draft to exist.
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(emp))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no active approval policy/i);
  });

  it('404 approve on missing expense', async () => {
    const res = await request(app)
      .post(`/expenses/${randomUUID()}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('resolves a manager when requester has no direct manager', async () => {
    // emp with no manager_id; org has a manager available as fallback
    const orgless = await makeUser(fx.orgId, 'employee', { email: 'nomgr@test.local' });
    const d = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(orgless))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    await request(app).post(`/expenses/${d.body.id}/submit`).set('Authorization', bearer(orgless));
    const detail = await request(app)
      .get(`/expenses/${d.body.id}`)
      .set('Authorization', bearer(orgless));
    expect(detail.body.steps[0].approver_id).toBe(fx.manager.id);
  });
});

describe('budget module', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('finance can create a user budget', async () => {
    const res = await request(app)
      .post('/budgets')
      .set('Authorization', bearer(fx.finance))
      .send({ userId: fx.emp.id, scope: 'user', period: 'daily', limitAmount: 5000 });
    expect(res.status).toBe(201);
  });

  it('rejects invalid budget payload', async () => {
    const res = await request(app)
      .post('/budgets')
      .set('Authorization', bearer(fx.finance))
      .send({ scope: 'user', period: 'weekly', limitAmount: -1 });
    expect(res.status).toBe(400);
  });

  it('lists budgets and reports utilization', async () => {
    const list = await request(app).get('/budgets').set('Authorization', bearer(fx.finance));
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const util = await request(app)
      .get('/budgets/utilization')
      .set('Authorization', bearer(fx.emp));
    expect(util.status).toBe(200);
    expect(util.body.monthly).toBeDefined();
  });

  it('enforces a daily budget', async () => {
    // tiny per-user daily budget
    await query(
      `INSERT INTO budgets (id, org_id, user_id, scope, period, limit_amount, currency)
       VALUES ($1,$2,$3,'user','daily',$4,'INR')`,
      [randomUUID(), fx.orgId, fx.emp.id, 1000]
    );
    const d = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 2000, currency: 'INR' });
    const res = await request(app)
      .post(`/expenses/${d.body.id}/submit`)
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(422);
    expect(res.body.error.details.period).toBe('daily');
  });
});

describe('policy patch no-op', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('patch with empty body returns current policy', async () => {
    const list = await request(app).get('/policies').set('Authorization', bearer(fx.finance));
    const id = list.body[0].id;
    const res = await request(app)
      .patch(`/policies/${id}`)
      .set('Authorization', bearer(fx.finance))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('404 deleting a missing policy', async () => {
    const res = await request(app)
      .delete(`/policies/${randomUUID()}`)
      .set('Authorization', bearer(fx.finance));
    expect(res.status).toBe(404);
  });
});
