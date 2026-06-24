import { runMigrations } from '../src/db/migrate';
import { closePool } from '../src/db/pool';

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});
