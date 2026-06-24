import { randomUUID } from 'crypto';
import { config } from '../../config';
import { Errors } from '../../http/errors';
import { AuthUser, Attachment } from '../../types';
import { getStorage } from '../../storage/storage';
import { recordAudit } from '../audit/audit.service';
import { assertCanViewExpense } from '../expenses/expense.service';
import * as repo from './attachment.repo';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// Keep filenames safe to use as part of an object key / on disk.
function sanitizeName(name: string): string {
  const base = (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || 'file';
}

/**
 * Upload a bill (image or PDF) for an expense. Only the requester can attach a
 * bill to their own expense, and only while it is still editable (before a
 * final decision). Bytes go to object storage; metadata goes to Postgres.
 */
export async function uploadBill(
  user: AuthUser,
  expenseId: string,
  file: UploadedFile | undefined
): Promise<Attachment> {
  if (!file) throw Errors.badRequest('No file uploaded (expected form field "file")');

  const expense = await assertCanViewExpense(user, expenseId);
  if (expense.requester_id !== user.id) {
    throw Errors.forbidden('Only the requester can attach a bill to this expense');
  }
  if (!['draft', 'submitted', 'in_review'].includes(expense.status)) {
    throw Errors.conflict(`Cannot attach a bill to an expense in status ${expense.status}`);
  }
  if (!config.allowedUploadTypes.includes(file.mimetype)) {
    throw Errors.unprocessable(
      `Unsupported file type "${file.mimetype}". Allowed: images (PNG/JPEG/WebP/GIF) or PDF.`
    );
  }
  if (file.size > config.maxUploadBytes) {
    throw Errors.unprocessable(
      `File too large (max ${Math.round(config.maxUploadBytes / (1024 * 1024))}MB).`
    );
  }

  const id = randomUUID();
  const key = `${config.attachmentsS3Bucket}/${user.org_id}/${expenseId}/${id}-${sanitizeName(
    file.originalname
  )}`;
  await getStorage().put(key, file.buffer, file.mimetype);

  const attachment = await repo.insertAttachment({
    id,
    org_id: user.org_id,
    expense_id: expenseId,
    s3_key: key,
    filename: file.originalname,
    content_type: file.mimetype,
    size: file.size,
    uploaded_by: user.id
  });

  await recordAudit({
    orgId: user.org_id,
    actorId: user.id,
    action: 'attachment.uploaded',
    entityType: 'expense',
    entityId: expenseId,
    after: { attachmentId: id, filename: attachment.filename, size: attachment.size }
  });

  return attachment;
}

/** List bill metadata for an expense (anyone allowed to view the expense). */
export async function listForExpense(
  user: AuthUser,
  expenseId: string
): Promise<Attachment[]> {
  await assertCanViewExpense(user, expenseId);
  return repo.listByExpense(user.org_id, expenseId);
}

/** Fetch a bill's bytes for download/preview (same visibility as the expense). */
export async function download(
  user: AuthUser,
  attachmentId: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const att = await repo.getById(user.org_id, attachmentId);
  if (!att) throw Errors.notFound('Attachment not found');
  if (att.expense_id) await assertCanViewExpense(user, att.expense_id);
  const buffer = await getStorage().get(att.s3_key);
  return { buffer, contentType: att.content_type, filename: att.filename };
}
