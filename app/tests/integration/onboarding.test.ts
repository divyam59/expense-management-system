import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb } from '../helpers';

const app = createApp();

describe('tenant onboarding (signup)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a new org + first admin and auto-logs in', async () => {
    const res = await request(app).post('/auth/signup').send({
      orgName: 'Initech',
      adminName: 'Bill',
      email: 'admin@initech.test',
      password: 'password123'
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.role).toBe('admin');
    expect(res.body.organization.name).toBe('Initech');
  });

  it('seeds a default policy so the new org can submit immediately', async () => {
    const signup = await request(app).post('/auth/signup').send({
      orgName: 'Acme2',
      adminName: 'Boss',
      email: 'boss@acme2.test',
      password: 'password123'
    });
    const adminToken = `Bearer ${signup.body.accessToken}`;

    // Admin creates a manager + an employee under that manager
    const mgr = await request(app)
      .post('/users')
      .set('Authorization', adminToken)
      .send({ name: 'Mgr', email: 'mgr@acme2.test', password: 'password123', role: 'manager' });
    const emp = await request(app)
      .post('/users')
      .set('Authorization', adminToken)
      .send({
        name: 'Emp',
        email: 'emp@acme2.test',
        password: 'password123',
        role: 'employee',
        managerId: mgr.body.id
      });
    expect(emp.status).toBe(201);

    // Employee logs in, creates and submits an expense -> chain builds (default policy)
    const empLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'emp@acme2.test', password: 'password123' });
    const empToken = `Bearer ${empLogin.body.accessToken}`;
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', empToken)
      .send({ type: 'reimbursement', amount: 3000, currency: 'INR' });
    const submit = await request(app)
      .post(`/expenses/${draft.body.id}/submit`)
      .set('Authorization', empToken);
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('in_review');
  });

  it('rejects duplicate admin email', async () => {
    await request(app).post('/auth/signup').send({
      orgName: 'A', adminName: 'X', email: 'dup@x.test', password: 'password123'
    });
    const res = await request(app).post('/auth/signup').send({
      orgName: 'B', adminName: 'Y', email: 'dup@x.test', password: 'password123'
    });
    expect(res.status).toBe(409);
  });

  it('validates the signup payload', async () => {
    const res = await request(app).post('/auth/signup').send({
      orgName: '', adminName: 'X', email: 'not-email', password: '123'
    });
    expect(res.status).toBe(400);
  });

  it('isolates the new org from other tenants', async () => {
    const a = await request(app).post('/auth/signup').send({
      orgName: 'OrgA', adminName: 'A', email: 'a@a.test', password: 'password123'
    });
    const b = await request(app).post('/auth/signup').send({
      orgName: 'OrgB', adminName: 'B', email: 'b@b.test', password: 'password123'
    });
    // Admin A creates an expense
    const draft = await request(app)
      .post('/expenses')
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .send({ type: 'reimbursement', amount: 1000, currency: 'INR' });
    // Admin B cannot see it
    const res = await request(app)
      .get(`/expenses/${draft.body.id}`)
      .set('Authorization', `Bearer ${b.body.accessToken}`);
    expect(res.status).toBe(404);
  });
});
