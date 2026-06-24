import { Role } from '../types';

export type Permission =
  | 'expense:create'
  | 'expense:read:own'
  | 'expense:read:reportees'
  | 'expense:read:all'
  | 'expense:approve'
  | 'policy:manage'
  | 'budget:manage'
  | 'user:manage'
  | 'analytics:view';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  employee: ['expense:create', 'expense:read:own'],
  manager: [
    'expense:create',
    'expense:read:own',
    'expense:read:reportees',
    'expense:approve',
    'analytics:view'
  ],
  finance: [
    'expense:create',
    'expense:read:own',
    'expense:read:all',
    'expense:approve',
    'policy:manage',
    'budget:manage',
    'analytics:view'
  ],
  admin: [
    'expense:create',
    'expense:read:own',
    'expense:read:reportees',
    'expense:read:all',
    'expense:approve',
    'policy:manage',
    'budget:manage',
    'user:manage',
    'analytics:view'
  ]
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
