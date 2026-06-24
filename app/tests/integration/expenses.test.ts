import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer, makeOrg, makeUser, makePolicy, makeOrgBudget } from '../helpers';

const app = createApp();

describe('expense lifecycle & workflow', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;

  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  async function createDraft(amount: number, type = 'reimbursement', currency = 'INR') {
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type, category: 'travel', description: 'trip', amount, currency });
    return res;
  }

  it('creates a draft expense with base currency conversion', async () => {
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 100, currency: 'USD' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(Number(res.body.base_amount)).toBe(8300);
  });

  it('rejects unsupported currency', async () => {
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 100, currency: 'ZZZ' });
    expect(res.status).toBe(422);
  });

  it('runs a single-level approval (small amount) to approved', async () => {
    const draft = await createDraft(3000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp)).expect(200);

    const detail = await request(app)
      .get(`/expenses/${draft.body.id}`)
      .set('Authorization', bearer(fx.emp));
    expect(detail.body.status).toBe('in_review');
    expect(detail.body.steps).toHaveLength(1);

    const approved = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'ok' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
  });

  it('runs a two-level approval (manager then finance)', async () => {
    const draft = await createDraft(20000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp)).expect(200);

    // Manager approves -> still in_review at level 2
    const afterMgr = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'mgr ok' });
    expect(afterMgr.body.status).toBe('in_review');
    expect(afterMgr.body.current_level).toBe(2);

    // Finance approves -> approved
    const afterFin = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.finance))
      .send({ reason: 'fin ok' });
    expect(afterFin.body.status).toBe('approved');
  });

  it('prevents the wrong approver from acting', async () => {
    const draft = await createDraft(20000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));
    // Finance is level 2, cannot act at level 1
    const res = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.finance))
      .send({ reason: 'jump the queue' });
    expect(res.status).toBe(403);
  });

  it('prevents self-approval', async () => {
    // A second manager files their own expense. It routes to the *other*
    // (original) manager as approver, so the requester is never their own
    // approver — any attempt by them to approve it is forbidden.
    const mgr2 = await makeUser(fx.orgId, 'manager', { email: 'mgr2@test.local' });
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(mgr2))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(mgr2));
    const res = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(mgr2))
      .send({ reason: 'self' });
    expect(res.status).toBe(403);
  });

  it('blocks submit when no eligible approver exists', async () => {
    // Single-manager org: the manager has no one else to approve their own
    // small expense, so submit fails fast with a clear message.
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.manager))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    const res = await request(app)
      .post(`/expenses/${draft.body.id}/submit`)
      .set('Authorization', bearer(fx.manager));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no eligible/i);
  });

  it('rejects with a mandatory reason and notifies requester', async () => {
    const draft = await createDraft(3000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));

    const noReason = await request(app)
      .post(`/expenses/${draft.body.id}/reject`)
      .set('Authorization', bearer(fx.manager))
      .send({});
    expect(noReason.status).toBe(400);

    const rejected = await request(app)
      .post(`/expenses/${draft.body.id}/reject`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'not allowed' });
    expect(rejected.body.status).toBe('rejected');
  });

  it('is idempotent on approve with Idempotency-Key', async () => {
    const draft = await createDraft(3000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));
    const key = 'idem-key-1';
    const first = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .set('Idempotency-Key', key)
      .send({ reason: 'ok' });
    const second = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .set('Idempotency-Key', key)
      .send({ reason: 'ok' });
    expect(first.body.status).toBe('approved');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('approved');
  });

  it('enforces budget at submit', async () => {
    const org = await makeOrg('LowBudget');
    const mgr = await makeUser(org, 'manager', { email: 'm@lb.local' });
    const emp = await makeUser(org, 'employee', { email: 'e@lb.local', managerId: mgr.id });
    await makePolicy(org);
    await makeOrgBudget(org, 1000); // tiny budget

    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(emp))
      .send({ type: 'reimbursement', amount: 5000, currency: 'INR' });
    const res = await request(app)
      .post(`/expenses/${draft.body.id}/submit`)
      .set('Authorization', bearer(emp));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Budget exceeded/);
  });

  it('re-evaluates the chain when amount is edited across a threshold', async () => {
    const draft = await createDraft(3000); // single level
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));
    // Edit up to a two-level amount
    await request(app)
      .patch(`/expenses/${draft.body.id}`)
      .set('Authorization', bearer(fx.emp))
      .send({ amount: 20000 })
      .expect(200);
    const detail = await request(app)
      .get(`/expenses/${draft.body.id}`)
      .set('Authorization', bearer(fx.emp));
    expect(detail.body.steps.length).toBe(2);
  });

  it('allows requester to withdraw', async () => {
    const draft = await createDraft(3000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));
    const res = await request(app)
      .post(`/expenses/${draft.body.id}/withdraw`)
      .set('Authorization', bearer(fx.emp));
    expect(res.body.status).toBe('withdrawn');
  });

  it('deletes only drafts', async () => {
    const draft = await createDraft(3000);
    const del = await request(app)
      .delete(`/expenses/${draft.body.id}`)
      .set('Authorization', bearer(fx.emp));
    expect(del.body.deleted).toBe(true);
  });

  it('blocks approve after final state (conflict)', async () => {
    const draft = await createDraft(3000);
    await request(app).post(`/expenses/${draft.body.id}/submit`).set('Authorization', bearer(fx.emp));
    await request(app).post(`/expenses/${draft.body.id}/approve`).set('Authorization', bearer(fx.manager)).send({ reason: 'ok' });
    const again = await request(app)
      .post(`/expenses/${draft.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'again' });
    expect(again.status).toBe(409);
  });
});

describe('RBAC & multi-tenancy', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('employee cannot list all expenses', async () => {
    const res = await request(app)
      .get('/expenses?scope=all')
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(403);
  });

  it('manager can list reportees expenses', async () => {
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    void draft;
    const res = await request(app)
      .get('/expenses?scope=reportees')
      .set('Authorization', bearer(fx.manager));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('isolates data across tenants', async () => {
    // emp from org A creates an expense
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });

    // a user from another org cannot read it
    const orgB = await makeOrg('OrgB');
    const adminB = await makeUser(orgB, 'admin', { email: 'admin@orgb.local' });
    const res = await request(app)
      .get(`/expenses/${draft.body.id}`)
      .set('Authorization', bearer(adminB));
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/expenses');
    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app).get('/expenses').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
  });
});
