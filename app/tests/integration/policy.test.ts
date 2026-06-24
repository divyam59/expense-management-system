import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer } from '../helpers';

const app = createApp();

describe('policies', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('finance can create a policy', async () => {
    const res = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.finance))
      .send({
        name: 'New policy',
        rulesJson: { rules: [{ min: 0, max: null, levels: ['manager'] }] },
        tolerancePercent: 5
      });
    expect(res.status).toBe(201);
    expect(res.body.tolerance_percent).toBe('5.00');
  });

  it('employee cannot create a policy', async () => {
    const res = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.emp))
      .send({ name: 'x', rulesJson: { rules: [{ min: 0, max: null, levels: ['manager'] }] } });
    expect(res.status).toBe(403);
  });

  it('validates rule ranges', async () => {
    const res = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.finance))
      .send({ name: 'bad', rulesJson: { rules: [{ min: 100, max: 10, levels: ['manager'] }] } });
    expect(res.status).toBe(422);
  });

  it('rejects malformed payloads', async () => {
    const res = await request(app)
      .post('/policies')
      .set('Authorization', bearer(fx.finance))
      .send({ name: '', rulesJson: { rules: [] } });
    expect(res.status).toBe(400);
  });

  it('lists, updates and deletes policies', async () => {
    const list = await request(app).get('/policies').set('Authorization', bearer(fx.finance));
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const id = list.body[0].id;

    const upd = await request(app)
      .patch(`/policies/${id}`)
      .set('Authorization', bearer(fx.finance))
      .send({ name: 'Renamed' });
    expect(upd.body.name).toBe('Renamed');

    const del = await request(app)
      .delete(`/policies/${id}`)
      .set('Authorization', bearer(fx.finance));
    expect(del.body.deleted).toBe(true);
  });

  it('404 on updating a missing policy', async () => {
    const res = await request(app)
      .patch('/policies/00000000-0000-0000-0000-000000000000')
      .set('Authorization', bearer(fx.finance))
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});
