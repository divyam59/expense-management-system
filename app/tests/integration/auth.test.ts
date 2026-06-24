import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture } from '../helpers';

const app = createApp();

describe('auth', () => {
  beforeEach(async () => {
    await resetDb();
    await standardFixture();
  });

  it('logs in with valid credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'emp@test.local', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects invalid credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'emp@test.local', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects unknown user', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'ghost@test.local', password: 'password123' });
    expect(res.status).toBe(401);
  });

  it('rotates a refresh token and revokes the old one (reuse detection)', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'emp@test.local', password: 'password123' });
    const oldRefresh = login.body.refreshToken;
    expect(oldRefresh).toBeDefined();

    const rotated = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken).toBeDefined();
    expect(rotated.body.refreshToken).toBeDefined();
    expect(rotated.body.refreshToken).not.toBe(oldRefresh);

    // Replaying the rotated (now revoked) token must be rejected.
    const reuse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(reuse.status).toBe(401);
  });

  it('rejects an invalid refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'emp@test.local', password: 'password123' });
    const rt = login.body.refreshToken;
    await request(app).post('/auth/logout').send({ refreshToken: rt }).expect(200);
    const after = await request(app).post('/auth/refresh').send({ refreshToken: rt });
    expect(after.status).toBe(401);
  });

  it('exposes health and metrics', async () => {
    await request(app).get('/health').expect(200);
    const m = await request(app).get('/metrics');
    expect(m.text).toContain('ems_requests_total');
  });
});
