import dotenv from 'dotenv';

dotenv.config();

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: process.env.NODE_ENV || 'development',
  isTest,
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: isTest
    ? process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/ems_test'
    : process.env.DATABASE_URL || 'postgres://localhost:5432/ems',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '15', 10),
  // In tests we never touch a real Redis; use the in-memory cache.
  useRedis: !isTest && !!process.env.REDIS_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtAccessTtl: parseInt(process.env.JWT_ACCESS_TTL || '3600', 10),
  jwtRefreshTtl: parseInt(process.env.JWT_REFRESH_TTL || '604800', 10),
  auditS3ShippingEnabled: process.env.AUDIT_S3_SHIPPING_ENABLED === 'true',
  auditS3Bucket: process.env.AUDIT_S3_BUCKET || 'ems-audit-logs',
  attachmentsS3Bucket: process.env.ATTACHMENTS_S3_BUCKET || 'ems-attachments'
};

export type Config = typeof config;
