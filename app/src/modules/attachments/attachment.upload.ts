import multer, { MulterError } from 'multer';
import { NextFunction, Request, Response } from 'express';
import { config } from '../../config';
import { Errors } from '../../http/errors';

// Buffer the upload in memory; the storage layer decides where the bytes land.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 }
});

const maxMb = Math.round(config.maxUploadBytes / (1024 * 1024));

/**
 * Parses a single `file` multipart field and translates multer's own errors
 * into the app's error envelope (so a too-large file is a clean 422, not a 500).
 */
export function billUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(Errors.unprocessable(`File too large (max ${maxMb}MB).`));
      }
      return next(Errors.badRequest(`Upload error: ${err.message}`));
    }
    if (err) return next(err);
    next();
  });
}
