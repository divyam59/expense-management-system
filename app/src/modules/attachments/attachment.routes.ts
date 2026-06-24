import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../../http/asyncHandler';
import { authenticate } from '../../auth/middleware';
import { config } from '../../config';
import { Errors } from '../../http/errors';

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
