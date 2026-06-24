import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer } from '../helpers';

const app = createApp();

describe('analytics / observability', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;

  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
    // generate some data
    const d = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', category: 'travel', amount: 3000, currency: 'INR' });
    await request(app).post(`/expenses/${d.body.id}/submit`).set('Authorization', bearer(fx.emp));
    await request(app)
      .post(`/expenses/${d.body.id}/approve`)
      .set('Authorization', bearer(fx.manager))
      .send({ reason: 'ok' });
  });

  it('returns a summary with spend and audit events', async () => {
    const res = await request(app)
      .get('/analytics/summary')
      .set('Authorization', bearer(fx.finance));
    expect(res.status).toBe(200);
    expect(res.body.approvedSpend).toBeGreaterThanOrEqual(3000);
    expect(res.body.auditEvents).toBeGreaterThan(0);
  });

  it('returns breakdowns', async () => {
    const byStatus = await request(app).get('/analytics/by-status').set('Authorization', bearer(fx.finance));
    expect(Array.isArray(byStatus.body)).toBe(true);
    const byCat = await request(app).get('/analytics/by-category').set('Authorization', bearer(fx.finance));
    expect(Array.isArray(byCat.body)).toBe(true);
    const spend = await request(app).get('/analytics/spend').set('Authorization', bearer(fx.finance));
    expect(Array.isArray(spend.body)).toBe(true);
    const audit = await request(app).get('/analytics/audit-volume').set('Authorization', bearer(fx.finance));
    expect(Array.isArray(audit.body)).toBe(true);
  });

  it('employee cannot view analytics', async () => {
    const res = await request(app)
      .get('/analytics/summary')
      .set('Authorization', bearer(fx.emp));
    expect(res.status).toBe(403);
  });
});
