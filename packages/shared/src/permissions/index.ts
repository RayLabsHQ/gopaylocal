// ── Workspace permissions ───────────────────────────────────────────────────
//
// The one table of what each workspace role, and a secret API key, may do.
// Everything reads it:
//  - the API enforces it: requirePermission() on every /v1/teams route
//    (apps/api/src/middleware/permissions.ts), for a member by role and for a
//    secret key by the apiKey column, and Better Auth's organization routes get
//    roles derived from it (apps/api/src/auth.ts);
//  - the dashboard hides the controls a role cannot use (apps/dashboard/src/lib/permissions.ts);
//  - the docs page dashboard/team.mdx carries permissionTableMarkdown(), and a
//    test fails when the two differ.
//
// Adding an action: add a row here, then guard its route with
// requirePermission("<key>"). The per-role tests are generated from this
// table, so a row without a decision for every role fails to compile, and a
// route without a guard fails the route-guard test.

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * - `all`: allowed for everything in the workspace.
 * - `scoped`: allowed only for products in the member's product access (and
 *   the campaigns, experiments, banners and analytics of those products).
 *   A member's product access is either "all products" (the default when they
 *   join) or a listed set; an empty listed set means no products.
 * - `none`: refused (403).
 */
export type Access = 'all' | 'scoped' | 'none';

/**
 * What a secret API key (gpl_sk_) may do. A key is its own principal, not a
 * member: it belongs to the workspace (not to whoever created it), has every
 * product of its workspace in scope, and is never `scoped`. It never has more
 * than an admin.
 */
export type KeyAccess = 'all' | 'none';

export interface PermissionRule {
  /** Section heading in the docs table. */
  area: string;
  /** What the action is, in the words the dashboard uses. */
  action: string;
  owner: Access;
  admin: Access;
  member: Access;
  /** A secret API key on the /v1/teams/:orgId routes (apps/api/src/middleware/api-key.ts). */
  apiKey: KeyAccess;
  /** Shown under the docs table when a cell needs explaining. */
  note?: string;
}

export const PERMISSIONS = {
  // Products
  'products.view': { area: 'Products', action: 'View products', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'products.create': { area: 'Products', action: 'Add products (manually or imported from an integration)', owner: 'all', admin: 'all', member: 'none', apiKey: 'all' },
  'products.update': { area: 'Products', action: 'Edit products', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'products.delete': { area: 'Products', action: 'Delete products', owner: 'all', admin: 'all', member: 'none', apiKey: 'all' },

  // Campaigns
  'campaigns.view': { area: 'Campaigns', action: 'View campaigns', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'campaigns.create': { area: 'Campaigns', action: 'Create campaigns', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'campaigns.update': { area: 'Campaigns', action: 'Edit, activate and pause campaigns', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'campaigns.delete': { area: 'Campaigns', action: 'Delete campaigns', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },

  // A/B tests: the same rights as campaigns, since an experiment is two campaigns.
  'experiments.view': { area: 'A/B tests', action: 'View A/B tests and their results', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'experiments.create': { area: 'A/B tests', action: 'Start A/B tests', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'experiments.update': { area: 'A/B tests', action: 'Change and end A/B tests', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },

  // Banners
  'banners.view': { area: 'Banners', action: 'View banner settings', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'banners.update': { area: 'Banners', action: 'Edit banner settings', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },

  // Parity groups
  'parityGroups.view': { area: 'Parity groups', action: 'View parity groups', owner: 'all', admin: 'all', member: 'all', apiKey: 'all' },
  'parityGroups.manage': { area: 'Parity groups', action: 'Create, edit and delete parity groups', owner: 'all', admin: 'all', member: 'none', apiKey: 'all' },

  // Integrations. Connecting, testing and disconnecting handle provider
  // credentials and webhooks: one-time setup by a person, never a key (a
  // leaked key must not be able to swap the account coupons are created in,
  // or delete webhooks that only the provider credentials can restore).
  'integrations.view': { area: 'Integrations', action: 'View connected integrations', owner: 'all', admin: 'all', member: 'all', apiKey: 'all' },
  'integrations.manage': { area: 'Integrations', action: 'Connect, test and disconnect integrations, set up their webhooks', owner: 'all', admin: 'all', member: 'none', apiKey: 'none' },
  'integrations.import': { area: 'Integrations', action: "List an integration's products and import them", owner: 'all', admin: 'all', member: 'none', apiKey: 'all' },

  // API keys
  'apiKeys.view': { area: 'API keys', action: 'View API keys (secret keys show only their prefix)', owner: 'all', admin: 'all', member: 'all', apiKey: 'all' },
  'apiKeys.manage': { area: 'API keys', action: 'Create and revoke API keys', owner: 'all', admin: 'all', member: 'none', apiKey: 'none' },

  // Analytics
  'analytics.view': { area: 'Analytics', action: 'View analytics', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },
  'analytics.export': { area: 'Analytics', action: 'Export analytics as CSV', owner: 'all', admin: 'all', member: 'scoped', apiKey: 'all' },

  // Team
  'team.view': { area: 'Team', action: 'See who is in the workspace', owner: 'all', admin: 'all', member: 'all', apiKey: 'none' },
  'team.viewInvitations': { area: 'Team', action: 'See pending invitations and their links', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.invite': { area: 'Team', action: 'Invite people', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.cancelInvitation': { area: 'Team', action: 'Cancel invitations', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.changeRole': { area: 'Team', action: "Change someone's role", owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.removeMember': { area: 'Team', action: 'Remove someone from the workspace', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.viewProductAccess': { area: 'Team', action: "View a member's product access", owner: 'all', admin: 'all', member: 'none', apiKey: 'none' },
  'team.manageProductAccess': { area: 'Team', action: "Change a member's product access", owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'team.leave': {
    area: 'Team',
    action: 'Leave the workspace',
    owner: 'all',
    admin: 'all',
    member: 'all',
    apiKey: 'none',
    note: 'An owner can leave only while another owner remains.',
  },

  // Billing
  'billing.view': { area: 'Billing', action: 'View the plan and usage', owner: 'all', admin: 'all', member: 'all', apiKey: 'none' },
  'billing.manage': { area: 'Billing', action: 'Upgrade, change or cancel the plan', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },

  // Workspace
  'workspace.rename': { area: 'Workspace', action: 'Rename the workspace (name, slug, logo)', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
  'workspace.delete': { area: 'Workspace', action: 'Delete the workspace', owner: 'all', admin: 'none', member: 'none', apiKey: 'none' },
} as const satisfies Record<string, PermissionRule>;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * The role a stored `member.role` value grants, or null when it names no
 * known role. Better Auth stores several roles as a comma-separated list
 * ("admin,member") and grants a permission when any of them has it; since
 * every row above is monotonic (owner ⊇ admin ⊇ member), that is the
 * highest-ranked known role. Unknown names are ignored, never upgraded.
 */
export function resolveRole(raw: string | null | undefined): WorkspaceRole | null {
  if (typeof raw !== 'string') return null;
  let best: WorkspaceRole | null = null;
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (isWorkspaceRole(name) && (best === null || RANK[name] > RANK[best])) best = name;
  }
  return best;
}

/** What `role` may do for `permission`. Anything unrecognised gets `none`. */
export function accessFor(role: string | null | undefined, permission: Permission): Access {
  const resolved = resolveRole(role);
  const rule: PermissionRule | undefined = PERMISSIONS[permission];
  if (!resolved || !rule) return 'none';
  return rule[resolved];
}

/** True when `role` may do `permission` at all (everywhere or within its product scope). */
export function can(role: string | null | undefined, permission: Permission): boolean {
  return accessFor(role, permission) !== 'none';
}

/** True when `role` may do `permission` only within its product scope. */
export function isScoped(role: string | null | undefined, permission: Permission): boolean {
  return accessFor(role, permission) === 'scoped';
}

/** What a secret API key may do for `permission`. An unknown permission gets `none`. */
export function apiKeyAccess(permission: Permission): KeyAccess {
  const rule: PermissionRule | undefined = PERMISSIONS[permission];
  return rule ? rule.apiKey : 'none';
}

/** Every permission a secret API key holds (GET /v1/me lists them). */
export const API_KEY_PERMISSIONS: Permission[] = PERMISSION_KEYS.filter((key) => PERMISSIONS[key].apiKey === 'all');

const CELL: Record<Access, string> = {
  all: 'Yes',
  scoped: 'Their products',
  none: 'No',
};

/**
 * The table as Markdown, grouped by area, for docs/dashboard/team.mdx (a test
 * keeps the docs copy identical to this output).
 */
export function permissionTableMarkdown(): string {
  const lines: string[] = [];
  const notes: string[] = [];
  let area = '';
  for (const key of PERMISSION_KEYS) {
    const rule: PermissionRule = PERMISSIONS[key];
    if (rule.area !== area) {
      if (lines.length > 0) lines.push('');
      area = rule.area;
      lines.push(
        `**${area}**`,
        '',
        '| Action | Owner | Admin | Member | Secret API key |',
        '| --- | --- | --- | --- | --- |',
      );
    }
    let action = rule.action;
    if (rule.note) {
      notes.push(rule.note);
      action += ` (${notes.length})`;
    }
    lines.push(
      `| ${action} | ${CELL[rule.owner]} | ${CELL[rule.admin]} | ${CELL[rule.member]} | ${CELL[rule.apiKey]} |`,
    );
  }
  if (notes.length > 0) {
    lines.push('', ...notes.map((n, i) => `(${i + 1}) ${n}`));
  }
  return lines.join('\n');
}
