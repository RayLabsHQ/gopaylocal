import { Hono } from "hono";
import { API_KEY_PERMISSIONS } from "@gopaylocal/shared/permissions";
import type { AppEnv } from "../bindings";

const app = new Hono<AppEnv>();

/**
 * GET /v1/me: what the calling secret key is. Mounted behind apiKeyMiddleware
 * (index.ts), so only a secret key reaches it. A client uses it to learn the
 * workspace id it needs for the /v1/teams/:orgId/... routes.
 */
app.get("/v1/me", (c) => {
  const key = c.get("apiKey");
  // Defensive: without the middleware there is no key, and nothing to answer.
  if (!key) return c.json({ error: "Unauthorized" }, 401);
  return c.json({
    data: {
      organization: { id: key.organizationId, name: key.organizationName },
      apiKey: { id: key.id, name: key.name, keyPrefix: key.keyPrefix, createdAt: key.createdAt },
      permissions: API_KEY_PERMISSIONS,
    },
  });
});

export default app;
