import { hasPermission, permissionsFor } from '../../src/rbac/permissions';

describe('rbac permissions', () => {
  it('employee can create but not approve', () => {
    expect(hasPermission('employee', 'expense:create')).toBe(true);
    expect(hasPermission('employee', 'expense:approve')).toBe(false);
    expect(hasPermission('employee', 'expense:read:all')).toBe(false);
  });

  it('manager can approve and read reportees', () => {
    expect(hasPermission('manager', 'expense:approve')).toBe(true);
    expect(hasPermission('manager', 'expense:read:reportees')).toBe(true);
    expect(hasPermission('manager', 'user:manage')).toBe(false);
  });

  it('finance can read all and manage policy', () => {
    expect(hasPermission('finance', 'expense:read:all')).toBe(true);
    expect(hasPermission('finance', 'policy:manage')).toBe(true);
  });

  it('admin can manage users', () => {
    expect(hasPermission('admin', 'user:manage')).toBe(true);
  });

  it('returns the permission list for a role', () => {
    expect(permissionsFor('admin').length).toBeGreaterThan(0);
    expect(permissionsFor('employee')).toContain('expense:create');
  });
});
