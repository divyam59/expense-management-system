import { randomUUID } from 'crypto';
import { z } from 'zod';
import * as repo from './policy.repo';
import { Errors } from '../../http/errors';

const ruleSchema = z.object({
  min: z.number().min(0),
  max: z.number().nullable(),
  levels: z.array(z.enum(['employee', 'manager', 'finance', 'admin'])).min(1)
});

const rulesJsonSchema = z.object({
  currency: z.string().optional(),
  rules: z.array(ruleSchema).min(1)
});

const createSchema = z.object({
  name: z.string().min(1),
  rulesJson: rulesJsonSchema,
  tolerancePercent: z.number().min(0).max(100).optional()
});

export async function createPolicy(orgId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid policy', parsed.error.flatten());
  validateRuleRanges(parsed.data.rulesJson.rules);
  const existing = await repo.findByName(orgId, parsed.data.name);
  if (existing) throw Errors.conflict('A policy with this name already exists');
  return repo.insertPolicy({
    id: randomUUID(),
    org_id: orgId,
    name: parsed.data.name,
    rules_json: parsed.data.rulesJson,
    tolerance_percent: parsed.data.tolerancePercent ?? 0
  });
}

export async function listPolicies(orgId: string) {
  return repo.listPolicies(orgId);
}

export async function updatePolicy(orgId: string, id: string, body: unknown) {
  const schema = z.object({
    name: z.string().min(1).optional(),
    rulesJson: rulesJsonSchema.optional(),
    tolerancePercent: z.number().min(0).max(100).optional(),
    active: z.boolean().optional()
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid policy', parsed.error.flatten());
  if (parsed.data.rulesJson) validateRuleRanges(parsed.data.rulesJson.rules);
  if (parsed.data.name) {
    const existing = await repo.findByName(orgId, parsed.data.name);
    if (existing && existing.id !== id) {
      throw Errors.conflict('A policy with this name already exists');
    }
  }

  const { active, name, rulesJson, tolerancePercent } = parsed.data;
  // Content fields go through the generic update (which also returns the current
  // row for an empty body). The active flag is handled separately so it can
  // enforce the single-active-policy invariant.
  let updated = await repo.updatePolicy(orgId, id, {
    name,
    rules_json: rulesJson,
    tolerance_percent: tolerancePercent
  });
  if (active !== undefined) {
    updated = await repo.setActive(orgId, id, active);
  }
  if (!updated) throw Errors.notFound('Policy not found');
  return updated;
}

export async function deletePolicy(orgId: string, id: string) {
  const ok = await repo.deletePolicy(orgId, id);
  if (!ok) throw Errors.notFound('Policy not found');
  return { deleted: true };
}

function validateRuleRanges(rules: { min: number; max: number | null }[]): void {
  for (const r of rules) {
    if (r.max !== null && r.max < r.min) {
      throw Errors.unprocessable('Policy rule max cannot be less than min');
    }
  }
}
