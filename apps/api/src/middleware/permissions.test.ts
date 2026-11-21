import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  WORKSPACE_ROLES,
  permissionTableMarkdown,
  type Permission,
} from "@gopaylocal/shared/permissions";
import type { AppEnv } from "../bindings";
import { requirePermission, guardedPermission } from "./permissions";

// The API side of the shared permission table: requirePermission per role
// per action (generated from the table), every /v1/teams route guarded, and
// the docs copy of the table identical to the table.

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

function appFor(role: string | undefined, permission: Permission) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (role !== undefined) c.set("memberRole", role);
    await next();
  });
  app.post("/v1/teams/org_1/thing", requirePermission(permission), (c) => c.json({ ok: true }));
  return app;
}

const KEY_PRINCIPAL = {
  id: "key_1",
  name: "CI",
  keyPrefix: "gpl_sk_01234567...",
  createdAt: new Date(0),
  organizationId: "org_1",
  organizationName: "Org",
};

/** A secret-key request, optionally with a (stale, injected) memberRole that must be ignored. */
function appForKey(permission: Permission, alsoRole?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", KEY_PRINCIPAL);
    if (alsoRole !== undefined) c.set("memberRole", alsoRole);
    await next();
  });
  app.post("/v1/teams/org_1/thing", requirePermission(permission), (c) => c.json({ ok: true }));
  return app;
}

describe("requirePermission, secret API key per action", () => {
  it.each(PERMISSION_KEYS.map((permission) => ({ permission, access: PERMISSIONS[permission].apiKey })))(
    "key / $permission ($access)",
    async ({ permission, access }) => {
      const res = await appForKey(permission).request("/v1/teams/org_1/thing", { method: "POST" });
      if (access === "none") {
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body).toMatchObject({ code: "forbidden_api_key", permission });
        expect(body.error).toMatch(/^Forbidden: an API key cannot do this \(/);
      } else {
        expect(res.status).toBe(200);
      }
    },
  );

  it("reads the key's column, never a role, even if one were set", async () => {
    const res = await appForKey("team.invite", "owner").request("/v1/teams/org_1/thing", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_api_key" });
  });
});

describe("requirePermission, per role per action", () => {
  const cases = PERMISSION_KEYS.flatMap((permission) =>
    WORKSPACE_ROLES.map((role) => ({ permission, role, access: PERMISSIONS[permission][role] })),
  );

  it.each(cases)("$role / $permission ($access)", async ({ permission, role, access }) => {
    const res = await appFor(role, permission).request("/v1/teams/org_1/thing", { method: "POST" });
    if (access === "none") {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_role", permission });
    } else {
      // "scoped" passes the gate; the handler narrows to the member's products.
      expect(res.status).toBe(200);
    }
  });

  it.each(PERMISSION_KEYS)("refuses %s to a missing or unknown role", async (permission) => {
    for (const role of [undefined, "billing", "", "Owner"]) {
      const res = await appFor(role, permission).request("/v1/teams/org_1/thing", { method: "POST" });
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
    }
  });

  it("treats Better Auth's comma-separated roles as the highest known one", async () => {
    expect((await appFor("member,admin", "apiKeys.manage").request("/v1/teams/org_1/thing", { method: "POST" })).status).toBe(200);
    expect((await appFor("member,admin", "team.invite").request("/v1/teams/org_1/thing", { method: "POST" })).status).toBe(403);
  });

  it("fails at startup on a key that is not in the table", () => {
    expect(() => requirePermission("products.destroy" as Permission)).toThrow(/unknown permission/);
  });

  it("tags the guard with its permission", () => {
    expect(guardedPermission(requirePermission("products.view"))).toBe("products.view");
    expect(guardedPermission(() => {})).toBeUndefined();
  });
});

// ── Every team route is guarded ─────────────────────────────────────────────
// Imports every route module in src/routes and checks each /v1/teams route has
// a requirePermission guard, so a new endpoint without a rule fails here.

const ROUTES_DIR = fileURLToPath(new URL("../routes/", import.meta.url));

async function teamRouteGuards(): Promise<Map<string, Permission | undefined>> {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const guards = new Map<string, Permission | undefined>();
  for (const file of files) {
    const mod = (await import(`../routes/${file}`)) as { default?: { routes?: Array<{ method: string; path: string; handler: unknown }> } };
    for (const route of mod.default?.routes ?? []) {
      if (!route.path.startsWith("/v1/teams") || route.method === "ALL") continue;
      const key = `${route.method} ${route.path}`;
      const permission = guardedPermission(route.handler);
      if (!guards.has(key) || permission) guards.set(key, permission ?? guards.get(key));
    }
  }
  return guards;
}

describe("route guards", () => {
  it("every /v1/teams route has a requirePermission guard", async () => {
    const guards = await teamRouteGuards();
    expect(guards.size).toBeGreaterThan(20);
    const unguarded = [...guards].filter(([, permission]) => !permission).map(([route]) => route);
    expect(unguarded).toEqual([]);
  });

  // The routes in authz-audit's files, pinned: changing what guards one of
  // these is a permission decision and belongs in the table and the report.
  it.each<[string, Permission]>([
    ["GET /v1/teams/:orgId/products", "products.view"],
    ["POST /v1/teams/:orgId/products", "products.create"],
    ["GET /v1/teams/:orgId/products/:id", "products.view"],
    ["PATCH /v1/teams/:orgId/products/:id", "products.update"],
    ["DELETE /v1/teams/:orgId/products/:id", "products.delete"],
    ["GET /v1/teams/:orgId/parity-groups", "parityGroups.view"],
    ["POST /v1/teams/:orgId/parity-groups", "parityGroups.manage"],
    ["PATCH /v1/teams/:orgId/parity-groups/:id", "parityGroups.manage"],
    ["DELETE /v1/teams/:orgId/parity-groups/:id", "parityGroups.manage"],
    ["PUT /v1/teams/:orgId/parity-groups/:id/countries", "parityGroups.manage"],
    ["POST /v1/teams/:orgId/parity-groups/seed-defaults", "parityGroups.manage"],
    ["GET /v1/teams/:orgId/banner-configs/:campaignId", "banners.view"],
    ["PUT /v1/teams/:orgId/banner-configs/:campaignId", "banners.update"],
    ["GET /v1/teams/:orgId/api-keys", "apiKeys.view"],
    ["POST /v1/teams/:orgId/api-keys", "apiKeys.manage"],
    ["DELETE /v1/teams/:orgId/api-keys/:id", "apiKeys.manage"],
    ["GET /v1/teams/:orgId/members", "team.view"],
    ["GET /v1/teams/:orgId/invitations", "team.viewInvitations"],
    ["GET /v1/teams/:orgId/members/:userId/product-access", "team.viewProductAccess"],
    ["PUT /v1/teams/:orgId/members/:userId/product-access", "team.manageProductAccess"],
    ["DELETE /v1/teams/:orgId", "workspace.delete"],
    ["POST /v1/teams/:orgId/integrations", "integrations.manage"],
    ["POST /v1/teams/:orgId/integrations/:id/webhook", "integrations.manage"],
    ["POST /v1/teams/:orgId/integrations/:id/test", "integrations.manage"],
    ["DELETE /v1/teams/:orgId/integrations/:id", "integrations.manage"],
    ["GET /v1/teams/:orgId/integrations/:id/products", "integrations.import"],
    ["POST /v1/teams/:orgId/integrations/:id/products/import", "integrations.import"],
  ])("%s is guarded by %s", async (route, permission) => {
    expect((await teamRouteGuards()).get(route)).toBe(permission);
  });

  // What a secret API key may call, route by route. The key's column in the
  // table decides it; this list pins the outcome, so a new /v1/teams route (or
  // a guard change) fails here until someone decides, in the table, whether a
  // key may call it, and updates this list and the route list in the report
  // the API docs are written from (reports/authz2.md, Wave D).
  it("every /v1/teams route declares what a secret API key may do", async () => {
    const guards = await teamRouteGuards();
    const byKey = { all: [] as string[], none: [] as string[] };
    for (const [route, permission] of guards) byKey[PERMISSIONS[permission!].apiKey].push(route);
    expect(byKey.all.sort()).toEqual(
      [
        "GET /v1/teams/:orgId/analytics/by-campaign",
        "GET /v1/teams/:orgId/analytics/by-country",
        "GET /v1/teams/:orgId/analytics/overview",
        "GET /v1/teams/:orgId/api-keys",
        "GET /v1/teams/:orgId/banner-configs/:campaignId",
        "PUT /v1/teams/:orgId/banner-configs/:campaignId",
        "GET /v1/teams/:orgId/campaigns",
        "POST /v1/teams/:orgId/campaigns",
        "GET /v1/teams/:orgId/campaigns/:id",
        "PATCH /v1/teams/:orgId/campaigns/:id",
        "DELETE /v1/teams/:orgId/campaigns/:id",
        "GET /v1/teams/:orgId/experiments",
        "POST /v1/teams/:orgId/experiments",
        "GET /v1/teams/:orgId/experiments/:id",
        "PATCH /v1/teams/:orgId/experiments/:id",
        "POST /v1/teams/:orgId/experiments/:id/end",
        "GET /v1/teams/:orgId/fx-rates",
        "GET /v1/teams/:orgId/integrations",
        "GET /v1/teams/:orgId/integrations/:id/products",
        "POST /v1/teams/:orgId/integrations/:id/products/import",
        "GET /v1/teams/:orgId/parity-groups",
        "POST /v1/teams/:orgId/parity-groups",
        "PATCH /v1/teams/:orgId/parity-groups/:id",
        "DELETE /v1/teams/:orgId/parity-groups/:id",
        "PUT /v1/teams/:orgId/parity-groups/:id/countries",
        "POST /v1/teams/:orgId/parity-groups/seed-defaults",
        "GET /v1/teams/:orgId/products",
        "POST /v1/teams/:orgId/products",
        "GET /v1/teams/:orgId/products/:id",
        "PATCH /v1/teams/:orgId/products/:id",
        "DELETE /v1/teams/:orgId/products/:id",
      ].sort(),
    );
    expect(byKey.none.sort()).toEqual(
      [
        "POST /v1/teams/:orgId/api-keys",
        "DELETE /v1/teams/:orgId/api-keys/:id",
        "GET /v1/teams/:orgId/billing",
        "GET /v1/teams/:orgId/billing/usage",
        "POST /v1/teams/:orgId/billing/checkout",
        "POST /v1/teams/:orgId/billing/portal",
        "POST /v1/teams/:orgId/integrations",
        "POST /v1/teams/:orgId/integrations/:id/webhook",
        "POST /v1/teams/:orgId/integrations/:id/test",
        "DELETE /v1/teams/:orgId/integrations/:id",
        "GET /v1/teams/:orgId/members",
        "GET /v1/teams/:orgId/invitations",
        "GET /v1/teams/:orgId/members/:userId/product-access",
        "PUT /v1/teams/:orgId/members/:userId/product-access",
        "DELETE /v1/teams/:orgId",
      ].sort(),
    );
  });
});

// ── Docs ────────────────────────────────────────────────────────────────────

describe("docs/dashboard/team.mdx", () => {
  it("carries the permission table exactly as the code defines it", () => {
    const mdx = readFileSync(
      fileURLToPath(new URL("../../../docs/src/content/docs/dashboard/team.mdx", import.meta.url)),
      "utf8",
    );
    const match = /\{\/\* permission-table:start[^*]*\*\/\}\n([\s\S]*?)\n\{\/\* permission-table:end \*\/\}/.exec(mdx);
    expect(match, "permission-table markers missing from team.mdx").not.toBeNull();
    expect(match![1]).toBe(permissionTableMarkdown());
  });
});
