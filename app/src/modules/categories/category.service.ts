import { randomUUID } from 'crypto';
import { z } from 'zod';
import * as repo from './category.repo';
import { Errors } from '../../http/errors';

export const DEFAULT_CATEGORIES = [
  'Travel',
  'Meals',
  'Accommodation',
  'Office Supplies',
  'Software',
  'Training',
  'Other'
];

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function listCategories(orgId: string) {
  return repo.listCategories(orgId);
}

export async function createCategory(orgId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw Errors.badRequest('Invalid category', parsed.error.flatten());
  }
  const existing = await repo.findByName(orgId, parsed.data.name);
  if (existing) throw Errors.conflict('A category with this name already exists');
  return repo.insertCategory({ id: randomUUID(), org_id: orgId, name: parsed.data.name });
}

export async function deleteCategory(orgId: string, id: string) {
  const ok = await repo.deactivate(orgId, id);
  if (!ok) throw Errors.notFound('Category not found');
  return { deleted: true };
}

/** Seed the default category set for a freshly created org. */
export async function seedDefaults(
  orgId: string,
  run: (sql: string, params: unknown[]) => Promise<unknown>
) {
  for (const name of DEFAULT_CATEGORIES) {
    await run(
      'INSERT INTO expense_categories (id, org_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [randomUUID(), orgId, name]
    );
  }
}
