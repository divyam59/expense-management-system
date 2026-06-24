import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * Object storage for uploaded bills (receipts/invoices). The app codes against
 * this interface so the storage backend can change without touching callers.
 *
 * - `LocalDiskStorage` (default) writes bytes under `config.uploadsDir`. It's
 *   what dev and tests use — no cloud account required.
 * - In production this would be an `S3Storage` implementing the same three
 *   methods with the AWS SDK (`PutObjectCommand` / `GetObjectCommand`), keeping
 *   the bucket private and serving downloads via the API (or short-lived
 *   pre-signed GET URLs). The object `key` format is identical, so swapping the
 *   driver is the only change.
 */
export interface BlobStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Filesystem-backed storage. The object key doubles as the relative path. */
export class LocalDiskStorage implements BlobStorage {
  constructor(private readonly baseDir: string) {}

  // Resolve a key to an absolute path and refuse anything that escapes baseDir
  // (defence against `..` path traversal in a key).
  private resolve(key: string): string {
    const full = path.resolve(this.baseDir, key);
    const root = path.resolve(this.baseDir);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

let storageInstance: BlobStorage | null = null;

export function getStorage(): BlobStorage {
  if (!storageInstance) {
    // Only the local driver is implemented; `s3` is the documented prod path.
    // An S3Storage would be constructed here when config.storageDriver === 's3'.
    storageInstance = new LocalDiskStorage(config.uploadsDir);
  }
  return storageInstance;
}

export function setStorage(storage: BlobStorage): void {
  storageInstance = storage;
}
