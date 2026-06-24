import request from 'supertest';
import { createApp } from '../../src/http/app';
import { resetDb, standardFixture, bearer, makeUser } from '../helpers';

const app = createApp();

// A tiny valid PNG and a minimal PDF, used as upload fixtures.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF', 'utf8');

describe('bill attachments', () => {
  let fx: Awaited<ReturnType<typeof standardFixture>>;
  beforeEach(async () => {
    await resetDb();
    fx = await standardFixture();
  });

  async function draft(amount = 3000) {
    const res = await request(app)
      .post('/expenses')
      .set('Authorization', bearer(fx.emp))
      .send({ type: 'reimbursement', category: 'travel', amount, currency: 'INR' });
    return res.body.id as string;
  }

  it('uploads an image bill, lists it, and downloads the bytes back', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PNG, { filename: 'receipt.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.filename).toBe('receipt.png');
    expect(up.body.content_type).toBe('image/png');
    expect(up.body.size).toBe(PNG.length);

    const list = await request(app)
      .get(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const dl = await request(app)
      .get(`/attachments/${up.body.id}`)
      .set('Authorization', bearer(fx.emp))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(dl.body as Buffer, PNG)).toBe(0);
  });

  it('accepts a PDF bill', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PDF, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.content_type).toBe('application/pdf');
  });

  it('rejects an unsupported file type (422)', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain'
      });
    expect(up.status).toBe(422);
    expect(up.body.error.message).toMatch(/unsupported file type/i);
  });

  it('rejects a request with no file (400)', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp));
    expect(up.status).toBe(400);
  });

  it('forbids a non-requester from attaching a bill (403)', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp2))
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' });
    expect(up.status).toBe(403);
  });

  it('lets a reviewer (finance) view the requester\'s bill', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' });
    const dl = await request(app)
      .get(`/attachments/${up.body.id}`)
      .set('Authorization', bearer(fx.finance));
    expect(dl.status).toBe(200);
  });

  it('blocks an unrelated employee from downloading the bill (403)', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' });
    const other = await makeUser(fx.orgId, 'employee', { email: 'other@test.local' });
    const dl = await request(app)
      .get(`/attachments/${up.body.id}`)
      .set('Authorization', bearer(other));
    expect(dl.status).toBe(403);
  });

  it('surfaces the bill on the approver queue and lets the assigned approver view it', async () => {
    const id = await draft(3000);
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' });
    await request(app)
      .post(`/expenses/${id}/submit`)
      .set('Authorization', bearer(fx.emp))
      .expect(200);

    const queue = await request(app)
      .get('/approvals/pending')
      .set('Authorization', bearer(fx.manager));
    expect(queue.status).toBe(200);
    const row = queue.body.find((r: { expense_id: string }) => r.expense_id === id);
    expect(row).toBeTruthy();
    expect(row.attachment_count).toBe(1);
    expect(row.first_attachment_id).toBe(up.body.id);
    expect(row.first_attachment_type).toBe('image/png');

    // The assigned approver can fetch the bill bytes.
    const dl = await request(app)
      .get(`/attachments/${up.body.id}`)
      .set('Authorization', bearer(fx.manager));
    expect(dl.status).toBe(200);
  });

  it('does not leak a bill across tenants (404)', async () => {
    const id = await draft();
    const up = await request(app)
      .post(`/expenses/${id}/attachments`)
      .set('Authorization', bearer(fx.emp))
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' });
    // A different org cannot see the attachment id at all.
    const otherFx = await standardFixture();
    const dl = await request(app)
      .get(`/attachments/${up.body.id}`)
      .set('Authorization', bearer(otherFx.admin));
    expect(dl.status).toBe(404);
  });
});
