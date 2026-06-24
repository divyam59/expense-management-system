import { randomUUID } from 'crypto';
import { z } from 'zod';
import { withTransaction } from '../../db/pool';
import { Errors } from '../../http/errors';
import { hashPassword } from '../../auth/password';
import { signAccessToken } from '../../auth/jwt';
import { issueRefreshToken } from '../../auth/refreshToken';
import { recordAudit } from '../audit/audit.service';
import { findByEmail } from '../users/user.repo';
import { seedDefaults as seedCategories } from '../categories/category.service';
import { AuthUser } from '../../types';

const signupSchema = z.object({
  orgName: z.string().min(1),
  baseCurrency: z.string().length(3).optional(),
  adminName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
});

const DEFAULT_POLICY_RULES = {
  currency: 'INR',
  rules: [
    { min: 0, max: 5000, levels: ['manager'] },
    { min: 5001, max: 50000, levels: ['manager', 'finance'] },
    { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
  ]
};

/**
 * Self-serve tenant onboarding. Atomically creates a new organization, its first
 * admin user, and a sensible default approval policy + org budget so the tenant
 * can use the system immediately. Returns tokens (auto-login).
 */
export async function signup(body: unknown) {
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest('Invalid signup payload', parsed.error.flatten());

  const existing = await findByEmail(parsed.data.email);
  if (existing) throw Errors.conflict('A user with this email already exists');

  const baseCurrency = parsed.data.baseCurrency ?? 'INR';

  return withTransaction(async (client) => {
    const orgId = randomUUID();
    await client.query(
      'INSERT INTO organizations (id, name, base_currency) VALUES ($1,$2,$3)',
      [orgId, parsed.data.orgName, baseCurrency]
    );

    const adminId = randomUUID();
    await client.query(
      `INSERT INTO users (id, org_id, name, email, password_hash, role, manager_id)
       VALUES ($1,$2,$3,$4,$5,'admin',NULL)`,
      [adminId, orgId, parsed.data.adminName, parsed.data.email, await hashPassword(parsed.data.password)]
    );

    await client.query(
      `INSERT INTO policies (id, org_id, name, rules_json, tolerance_percent, active, version)
       VALUES ($1,$2,$3,$4,$5,true,1)`,
      [randomUUID(), orgId, 'Default approval policy', JSON.stringify(DEFAULT_POLICY_RULES), 10]
    );

    await client.query(
      `INSERT INTO budgets (id, org_id, user_id, scope, period, limit_amount, currency)
       VALUES ($1,$2,NULL,'org','monthly',$3,$4)`,
      [randomUUID(), orgId, 2000000, baseCurrency]
    );

    await seedCategories(orgId, (sql, params) => client.query(sql, params as never[]));

    await recordAudit(
      {
        orgId,
        actorId: adminId,
        action: 'org.created',
        entityType: 'organization',
        entityId: orgId,
        after: { name: parsed.data.orgName, admin: parsed.data.email }
      },
      client
    );

    const auth: AuthUser = { id: adminId, org_id: orgId, role: 'admin', email: parsed.data.email };
    return {
      accessToken: signAccessToken(auth),
      refreshToken: await issueRefreshToken(auth, client),
      user: {
        id: adminId,
        org_id: orgId,
        name: parsed.data.adminName,
        email: parsed.data.email,
        role: 'admin'
      },
      organization: { id: orgId, name: parsed.data.orgName, base_currency: baseCurrency }
    };
  });
}
