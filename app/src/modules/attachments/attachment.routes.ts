import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate } from '../../auth/middleware';
import { config } from '../../config';
import { Errors } from '../../http/errors';
import * as service from './attachment.service';

export const attachmentRouter = Router();

attachmentRouter.use(authenticate);

/**
 * Returns a (MOCKED) S3 pre-signed PUT URL + object key. In production this calls
 * the AWS SDK `getSignedUrl` for a private bucket. The client PUTs the file
 * directly to S3, then references the returned key on the expense.
 */
attachmentRouter.post(
  '/presign',
  asyncHandler(async (req, res) => {
    const { filename, contentType } = req.body ?? {};
    if (!filename || !contentType) {
      throw Errors.badRequest('filename and contentType are required');
    }
    const key = `${config.attachmentsS3Bucket}/${req.user!.org_id}/${randomUUID()}-${filename}`;
    const uploadUrl = `https://mock-s3.local/${key}?X-Amz-Signature=mock&expires=900`;
    res.json({
      key,
      uploadUrl,
      method: 'PUT',
      expiresInSeconds: 900,
      note: 'MOCK presigned URL (no real S3 in prototype)'
    });
  })
);

/**
 * Streams a stored bill back to an authorized viewer. Bytes come from the
 * storage layer (local disk by default; S3 in production), never served as a
 * public static file — every download is authenticated and tenant-scoped.
 */
attachmentRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { buffer, contentType, filename } = await service.download(
      req.user!,
      req.params.id
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(filename)}"`
    );
    res.send(buffer);
  })
);
