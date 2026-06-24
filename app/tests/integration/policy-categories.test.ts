import request from 'supertest';
import { createApp } from '../../src/http/app';
import {
  resetDb,
  standardFixture,
  bearer,
  makeOrg,
  makeUser,
  makePolicy,
  makeOrgBudget
} from '../helpers';

const app = createApp();

describe('Single active policy', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  const rules = { rules: [{ min: 0, max: 10000, levels: ['manager'] }] };

  it('creating a new policy deactivates the previous active one (only one active)', async () => {
    await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Policy A', rulesJson: rules })
      .expect(201);

    await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Policy B', rulesJson: rules })
      .expect(201);

    const list = await request(app).get('/policies').set('Authorization', bearer(fx.admin));
    const active = list.body.filter((p: { active: boolean }) => p.active);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Policy B');
  });

  it('blocks duplicate policy names within an org (409)', async () => {
    await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Duplicate', rulesJson: rules })
      .expect(201);

    await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'duplicate', rulesJson: rules })
      .expect(409);
  });

  it('activating a policy deactivates the others', async () => {
    const a = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'First', rulesJson: rules });
    const b = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Second', rulesJson: rules });

    // Re-activate the first; the second must turn inactive.
    await request(app)
      .patch(`/policies/${a.body.id}`)
      .set('Authorization', bearer(fx.admin))
      .send({ active: true })
      .expect(200);

    const list = await request(app).get('/policies').set('Authorization', bearer(fx.admin));
    const byId = Object.fromEntries(list.body.map((p: { id: string }) => [p.id, p]));
    expect(byId[a.body.id].active).toBe(true);
    expect(byId[b.body.id].active).toBe(false);
  });
});

describe('Expense categories', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('admin can add a category, employees can read it', async () => {
    const create = await request(app)
      .post('/categories')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Marketing' });
    expect(create.status).toBe(201);

    const list = await request(app).get('/categories').set('Authorization', bearer(fx.emp));
    expect(list.status).toBe(200);
    expect(list.body.some((c: { name: string }) => c.name === 'Marketing')).toBe(true);
  });

  it('rejects duplicate category names (409)', async () => {
    await request(app)
      .post('/categories')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Travel' })
      .expect(201);
    await request(app)
      .post('/categories')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'travel' })
      .expect(409);
  });

  it('employees cannot create categories (403)', async () => {
    await request(app)
      .post('/categories')
      .set('Authorization', bearer(fx.emp))
      .send({ name: 'Sneaky' })
      .expect(403);
  });

  it('deleting a category hides it from the list', async () => {
    const c = await request(app)
      .post('/categories')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Temp' });
    await request(app)
      .delete(`/categories/${c.body.id}`)
      .set('Authorization', bearer(fx.admin))
      .expect(200);

    const list = await request(app).get('/categories').set('Authorization', bearer(fx.admin));
    expect(list.body.some((x: { id: string }) => x.id === c.body.id)).toBe(false);
  });
});

describe('Approver guard on submit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 422 with a helpful message when no eligible approver exists', async () => {
    // Fresh org with only an admin (no manager) — the classic new-org pitfall.
    const orgId = await makeOrg('Solo Org');
    await makePolicy(orgId);
    await makeOrgBudget(orgId);
    const admin = await makeUser(orgId, 'admin', { email: 'solo-admin@test.local' });

    const created = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(admin))
      .send({ type: 'reimbursement', category: 'Travel', amount: 3000, currency: 'INR' });
    expect(created.status).toBe(201);

    const submit = await request(app)
      .post(`/expenses/${created.body.id}/submit`)
      .set('Authorization', bearer(admin));
    expect(submit.status).toBe(422);
    expect(submit.body.error.message).toMatch(/no eligible manager/i);
  });
});
