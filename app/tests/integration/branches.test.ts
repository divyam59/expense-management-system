import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer } from '../helpers';
import { randomUUID } from 'crypto';

const app = createApp();

describe('extra branch coverage', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('analytics summary uses cache on second call', async () => {
    const first = await request(app)
      .get('/analytics/summary')
      .set('Authorization', bearer(fx.finance));
    const second = await request(app)
      .get('/analytics/summary')
      .set('Authorization', bearer(fx.finance));
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('user patch with empty body returns the user', async () => {
    const res = await request(app)
      .patch(`/users/${fx.emp.id}`)
      .set('Authorization', bearer(fx.admin))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(fx.emp.id);
  });

  it('404 when patching a missing user', async () => {
    const res = await request(app)
      .patch(`/users/${randomUUID()}`)
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('updates a policy with new rules and tolerance', async () => {
    const list = await request(app).get('/policies').set('Authorization', bearer(fx.finance));
    const id = list.body[0].id;
    const ok = await request(app)
      .patch(`/policies/${id}`)
      .set('Authorization', bearer(fx.finance))
      .send({
        tolerancePercent: 15,
        rulesJson: { rules: [{ min: 0, max: null, levels: ['manager', 'finance'] }] }
      });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .patch(`/policies/${id}`)
      .set('Authorization', bearer(fx.finance))
      .send({ rulesJson: { rules: [{ min: 100, max: 1, levels: ['manager'] }] } });
    expect(bad.status).toBe(422);
  });

  it('attachment presign rejects partial payload', async () => {
    const res = await request(app)
      .post('/attachments/presign')
      .set('Authorization', bearer(fx.emp))
      .send({ filename: 'only-name.png' });
    expect(res.status).toBe(400);
  });

  it('reject by the wrong approver is forbidden', async () => {
    const d = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', amount: 20000, currency: 'INR' });
    await request(app).post(`/expenses/${d.body.id}/submit`).set('Authorization', bearer(fx.emp));
    // finance is level 2, cannot reject at level 1
    const res = await request(app)
      .post(`/expenses/${d.body.id}/reject`)
      .set('Authorization', bearer(fx.finance))
      .send({ reason: 'no' });
    expect(res.status).toBe(403);
  });

  it('reject on a missing expense returns 404', async () => {
    const res = await request(app)
      .post(`/expenses/${randomUUID()}/reject`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'x' });
    expect(res.status).toBe(404);
  });
});
