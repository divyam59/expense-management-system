import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer } from '../helpers';

const app = createApp();

describe('users', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  it('admin can create a user', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'New', email: 'new@test.local', password: 'secret1', role: 'employee' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@test.local');
  });

  it('rejects duplicate email', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Dup', email: 'emp@test.local', password: 'secret1', role: 'employee' });
    expect(res.status).toBe(409);
  });

  it('non-admin cannot manage users', async () => {
    const res = await request(app)
      .get('/users')
      .set('Authorization', bearer(fx.manager));
    expect(res.status).toBe(403);
  });

  it('admin can list and update users', async () => {
    const list = await request(app).get('/users').set('Authorization', bearer(fx.admin));
    expect(list.body.length).toBeGreaterThanOrEqual(5);

    const upd = await request(app)
      .patch(`/users/${fx.emp.id}`)
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'Renamed Emp' });
    expect(upd.body.name).toBe('Renamed Emp');
  });

  it('validates user creation payload', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', bearer(fx.admin))
      .send({ name: 'x', email: 'not-an-email', password: '123', role: 'employee' });
    expect(res.status).toBe(400);
  });
});
