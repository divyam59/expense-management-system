import request from 'supertest';
import { createApp } from '../../src/http/app';
import {
  resetDb,
  standardFixture,
  bearer,
  makeOrg,
  makeUser,
  makePolicy
} from '../helpers';

const app = createApp();

// Server-side behaviours backing the UI fixes (validation visibility, edit-on-
// over-budget, create-policy, notifications, session refresh).
describe('UI fixes (server behaviour)', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  describe('user creation validation is surfaced', () => {
    it('rejects an invalid email with 400 + field error', async () => {
      const res = await request(app)
        .post('/users')
        .set('Authorization', bearer(fx.admin))
        .send({ name: 'Bad', email: 'dd@gmail', password: 'secret1', role: 'employee' });
      expect(res.status).toBe(400);
      // field-level error so the UI can show "email: ..."
      expect(res.body.error.details?.fieldErrors?.email).toBeDefined();
    });

    it('rejects a duplicate email with 409', async () => {
      const res = await request(app)
        .post('/users')
        .set('Authorization', bearer(fx.admin))
        .send({ name: 'Dup', email: 'emp@test.local', password: 'secret1', role: 'employee' });
      expect(res.status).toBe(409);
    });

    it('rejects a too-short password with 400', async () => {
      const res = await request(app)
        .post('/users')
        .set('Authorization', bearer(fx.admin))
        .send({ name: 'Shorty', email: 'new@test.local', password: '123', role: 'employee' });
      expect(res.status).toBe(400);
    });
  });

  describe('over-budget submit returns an editable error (not a dead end)', () => {
    it('returns 422 with budget details so the UI can prompt an edit', async () => {
      // org monthly budget is 2,000,000; create an expense above it.
      const created = await request(app)
        .post('/expenses')
        .set('Authorization', bearer(fx.emp))
        .send({ type: 'reimbursement', category: 'travel', amount: 5000000, currency: 'INR' });
      expect(created.status).toBe(201);

      const submit = await request(app)
        .post(`/expenses/${created.body.id}/submit`)
        .set('Authorization', bearer(fx.emp));
      expect(submit.status).toBe(422);
      expect(submit.body.error.message).toMatch(/budget/i);

      // The expense stays editable: PATCH to a within-budget amount then submit works.
      const edit = await request(app)
        .patch(`/expenses/${created.body.id}`)
        .set('Authorization', bearer(fx.emp))
        .send({ amount: 4000 });
      expect(edit.status).toBe(200);

      const submit2 = await request(app)
        .post(`/expenses/${created.body.id}/submit`)
        .set('Authorization', bearer(fx.emp));
      expect(submit2.status).toBe(200);
      expect(submit2.body.status).toBe('in_review');
    });
  });

  describe('create policy from the UI form', () => {
    it('creates a policy and lists it', async () => {
      const create = await request(app)
        .post('/policies')
        .set('Authorization', bearer(fx.admin))
        .send({
          name: 'Travel policy',
          tolerancePercent: 10,
          rulesJson: { currency: 'INR', rules: [{ min: 0, max: 10000, levels: ['manager'] }] }
        });
      expect(create.status).toBe(201);

      const list = await request(app).get('/policies').set('Authorization', bearer(fx.admin));
      expect(list.status).toBe(200);
      expect(list.body.some((p: { name: string }) => p.name === 'Travel policy')).toBe(true);
    });

    it('rejects an invalid rule range with 422', async () => {
      const res = await request(app)
        .post('/policies')
        .set('Authorization', bearer(fx.admin))
        .send({
          name: 'Bad policy',
          tolerancePercent: 0,
          rulesJson: { currency: 'INR', rules: [{ min: 100, max: 10, levels: ['manager'] }] }
        });
      expect(res.status).toBe(422);
    });
  });

  describe('notifications are readable + markable (badge source)', () => {
    it('notifies the approver on submit and supports mark-as-read', async () => {
      const created = await request(app)
        .post('/expenses')
        .set('Authorization', bearer(fx.emp))
        .send({ type: 'reimbursement', category: 'meals', amount: 3000, currency: 'INR' });
      await request(app)
        .post(`/expenses/${created.body.id}/submit`)
        .set('Authorization', bearer(fx.emp));

      const notifs = await request(app)
        .get('/notifications')
        .set('Authorization', bearer(fx.manager));
      expect(notifs.status).toBe(200);
      const n = notifs.body.find(
        (x: { type: string }) => x.type === 'approval_requested'
      );
      expect(n).toBeDefined();
      expect(n.read).toBe(false);

      const read = await request(app)
        .post(`/notifications/${n.id}/read`)
        .set('Authorization', bearer(fx.manager));
      expect(read.status).toBe(200);
      expect(read.body.read).toBe(true);
    });
  });

  describe('session survives via refresh-token rotation', () => {
    it('logs in, refreshes, and the new access token works', async () => {
      const orgId = await makeOrg('Refresh Co');
      await makePolicy(orgId);
      await makeUser(orgId, 'admin', { email: 'r-admin@test.local' });

      const login = await request(app)
        .post('/auth/login')
        .send({ email: 'r-admin@test.local', password: 'password123' });
      expect(login.status).toBe(200);

      const refreshed = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(refreshed.status).toBe(200);

      const me = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
      expect(me.status).toBe(200);
    });
  });
});
