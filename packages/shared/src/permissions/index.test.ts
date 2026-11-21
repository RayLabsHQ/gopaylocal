import { describe, it, expect } from 'vitest';
import {
  API_KEY_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_KEYS,
  WORKSPACE_ROLES,
  accessFor,
  apiKeyAccess,
  can,
  isScoped,
  isWorkspaceRole,
  permissionTableMarkdown,
  resolveRole,
  type Access,
  type KeyAccess,
  type Permission,
} from './index.js';

const ACCESS: Access[] = ['all', 'scoped', 'none'];
const RANK: Record<Access, number> = { none: 0, scoped: 1, all: 2 };

describe('PERMISSIONS table', () => {
  // One generated case per role per action: an action added without a
  // decision for every role fails here (and fails to compile).
  const cells = PERMISSION_KEYS.flatMap((permission) => WORKSPACE_ROLES.map((role) => ({ permission, role })));

  it.each(cells)('$permission has a decision for $role', ({ permission, role }) => {
    expect(ACCESS).toContain(PERMISSIONS[permission][role]);
    expect(accessFor(role, permission)).toBe(PERMISSIONS[permission][role]);
    expect(can(role, permission)).toBe(PERMISSIONS[permission][role] !== 'none');
    expect(isScoped(role, permission)).toBe(PERMISSIONS[permission][role] === 'scoped');
  });

  it.each(PERMISSION_KEYS)('%s is monotonic: owner >= admin >= member', (permission) => {
    const rule = PERMISSIONS[permission];
    expect(RANK[rule.owner]).toBeGreaterThanOrEqual(RANK[rule.admin]);
    expect(RANK[rule.admin]).toBeGreaterThanOrEqual(RANK[rule.member]);
  });

  it('the owner can do everything, everywhere', () => {
    for (const permission of PERMISSION_KEYS) expect(PERMISSIONS[permission].owner).toBe('all');
  });

  it('only members are ever product-scoped', () => {
    for (const permission of PERMISSION_KEYS) {
      expect(PERMISSIONS[permission].owner).not.toBe('scoped');
      expect(PERMISSIONS[permission].admin).not.toBe('scoped');
    }
  });

  it('every key is area.action and every row says what it is', () => {
    for (const permission of PERMISSION_KEYS) {
      expect(permission).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
      expect(PERMISSIONS[permission].area.length).toBeGreaterThan(0);
      expect(PERMISSIONS[permission].action.length).toBeGreaterThan(0);
    }
  });

  // The decisions written down in the authz report. If one of these changes,
  // the report and docs/dashboard/team.mdx change with it.
  it.each<[Permission, Access, Access, Access]>([
    ['team.invite', 'all', 'none', 'none'],
    ['team.viewInvitations', 'all', 'none', 'none'],
    ['team.cancelInvitation', 'all', 'none', 'none'],
    ['team.removeMember', 'all', 'none', 'none'],
    ['team.changeRole', 'all', 'none', 'none'],
    ['team.manageProductAccess', 'all', 'none', 'none'],
    ['workspace.rename', 'all', 'none', 'none'],
    ['workspace.delete', 'all', 'none', 'none'],
    ['billing.manage', 'all', 'none', 'none'],
    ['products.create', 'all', 'all', 'none'],
    ['products.delete', 'all', 'all', 'none'],
    ['products.update', 'all', 'all', 'scoped'],
    ['parityGroups.manage', 'all', 'all', 'none'],
    ['integrations.manage', 'all', 'all', 'none'],
    ['integrations.import', 'all', 'all', 'none'],
    ['apiKeys.manage', 'all', 'all', 'none'],
  ])('decision: %s is owner=%s admin=%s member=%s', (permission, owner, admin, member) => {
    expect(PERMISSIONS[permission]).toMatchObject({ owner, admin, member });
  });

  it('experiments have exactly the rights of campaigns', () => {
    for (const action of ['view', 'create', 'update'] as const) {
      const { owner, admin, member } = PERMISSIONS[`campaigns.${action}`];
      expect(PERMISSIONS[`experiments.${action}`]).toMatchObject({ owner, admin, member });
    }
  });
});

describe('secret API keys (the apiKey column)', () => {
  const KEY_ACCESS: KeyAccess[] = ['all', 'none'];

  it.each(PERMISSION_KEYS)('%s has a key decision that is all or none, never more than admin', (permission) => {
    const rule = PERMISSIONS[permission];
    expect(KEY_ACCESS).toContain(rule.apiKey);
    expect(apiKeyAccess(permission)).toBe(rule.apiKey);
    if (rule.apiKey === 'all') expect(rule.admin).toBe('all');
  });

  // The lead's decisions for Wave D. Changing one is a permission decision:
  // the authz report and docs/dashboard/team.mdx change with it.
  it('may work on products, campaigns, A/B tests, banners, parity groups, analytics; import from integrations', () => {
    expect(API_KEY_PERMISSIONS).toEqual([
      'products.view',
      'products.create',
      'products.update',
      'products.delete',
      'campaigns.view',
      'campaigns.create',
      'campaigns.update',
      'campaigns.delete',
      'experiments.view',
      'experiments.create',
      'experiments.update',
      'banners.view',
      'banners.update',
      'parityGroups.view',
      'parityGroups.manage',
      'integrations.view',
      'integrations.import',
      'apiKeys.view',
      'analytics.view',
      'analytics.export',
    ]);
  });

  it('never manages people, billing, keys, integration credentials or the workspace', () => {
    for (const permission of PERMISSION_KEYS) {
      if (/^(team|billing|workspace)\./.test(permission)) expect(PERMISSIONS[permission].apiKey).toBe('none');
    }
    expect(PERMISSIONS['apiKeys.manage'].apiKey).toBe('none');
    expect(PERMISSIONS['integrations.manage'].apiKey).toBe('none');
  });

  it('is not a role: "apiKey" as a role string gets nothing', () => {
    for (const permission of PERMISSION_KEYS) expect(accessFor('apiKey', permission)).toBe('none');
    expect(resolveRole('apiKey')).toBeNull();
  });

  it('an unknown permission is none', () => {
    expect(apiKeyAccess('nope.nope' as Permission)).toBe('none');
  });
});

describe('resolveRole', () => {
  it('accepts the three roles', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(resolveRole(role)).toBe(role);
      expect(isWorkspaceRole(role)).toBe(true);
    }
  });

  it("takes the highest known role from Better Auth's comma-separated list", () => {
    expect(resolveRole('admin,member')).toBe('admin');
    expect(resolveRole('member, owner')).toBe('owner');
    expect(resolveRole(' member ')).toBe('member');
  });

  it('never upgrades an unknown name', () => {
    expect(resolveRole('billing')).toBeNull();
    expect(resolveRole('superadmin,member')).toBe('member');
    expect(resolveRole('Owner')).toBeNull();
    expect(resolveRole('')).toBeNull();
    expect(resolveRole(undefined)).toBeNull();
    expect(resolveRole(null)).toBeNull();
  });

  it('an unknown or missing role can do nothing', () => {
    for (const permission of PERMISSION_KEYS) {
      expect(can('billing', permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
      expect(accessFor(null, permission)).toBe('none');
    }
  });

  it('an unknown permission is refused', () => {
    expect(can('owner', 'nope.nope' as Permission)).toBe(false);
  });
});

describe('permissionTableMarkdown', () => {
  const md = permissionTableMarkdown();

  it('has one row per permission and one section per area', () => {
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Action') && !l.startsWith('| ---'));
    expect(rows).toHaveLength(PERMISSION_KEYS.length);
    const areas = new Set(PERMISSION_KEYS.map((k) => PERMISSIONS[k].area));
    for (const area of areas) expect(md).toContain(`**${area}**`);
  });

  it('renders the cells in plain words, the secret API key last', () => {
    expect(md).toContain('| Action | Owner | Admin | Member | Secret API key |');
    expect(md).toContain('| Invite people | Yes | No | No | No |');
    expect(md).toContain('| Edit products | Yes | Yes | Their products | Yes |');
    expect(md).toContain('(1) An owner can leave only while another owner remains.');
  });
});
