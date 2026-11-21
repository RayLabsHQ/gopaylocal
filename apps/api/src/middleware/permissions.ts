import { createMiddleware } from "hono/factory";
import { PERMISSIONS, accessFor, apiKeyAccess, type Access, type Permission } from "@gopaylocal/shared/permissions";
import type { AppEnv } from "../bindings";

/**
 * Guard a /v1/teams/:orgId route with one row of the permission table
 * (packages/shared/src/permissions). Must run after teamMiddleware, which
 * sets `memberRole`. Answers 403 when the role has `none` for the action
 * (code forbidden_role), or, for a secret API key, when the row's apiKey
 * cell is `none` (code forbidden_api_key).
 *
 * `scoped` passes: the handler then limits the request to the member's
 * products with lib/product-access.ts (getAllowedProductIds and friends),
 * which return everything for owners and admins.
 *
 * Usage: app.post("/v1/teams/:orgId/api-keys", requirePermission("apiKeys.manage"), handler)
 */
export const requirePermission = (permission: Permission) => {
  if (!(permission in PERMISSIONS)) {
    // A typo'd key must fail at startup, not by locking a route at runtime.
    throw new Error(`requirePermission: unknown permission "${permission}"`);
  }
  const middleware = createMiddleware<AppEnv>(async (c, next) => {
    // A secret key is its own principal: the table's apiKey column, never a role.
    if (c.get("apiKey")) {
      if (apiKeyAccess(permission) === "none") {
        return c.json(
          {
            error: `Forbidden: an API key cannot do this (${PERMISSIONS[permission].action.toLowerCase()})`,
            code: "forbidden_api_key",
            permission,
          },
          403,
        );
      }
      await next();
      return;
    }
    const access: Access = accessFor(c.get("memberRole"), permission);
    if (access === "none") {
      return c.json(
        {
          error: `Forbidden: your role cannot do this (${PERMISSIONS[permission].action.toLowerCase()})`,
          code: "forbidden_role",
          permission,
        },
        403,
      );
    }
    await next();
  });
  // Tagged so the route-guard test can find, on every team route, which row guards it.
  return Object.assign(middleware, { permission });
};

/** The permission a route handler enforces, when it is a requirePermission guard. */
export function guardedPermission(handler: unknown): Permission | undefined {
  return typeof handler === "function" && "permission" in handler
    ? ((handler as { permission: Permission }).permission)
    : undefined;
}
