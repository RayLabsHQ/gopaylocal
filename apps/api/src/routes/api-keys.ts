import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { apiKeys, users } from "../db/schema";
import { createApiKeySchema } from "@gopaylocal/shared/validation";
import { API_KEY_PREFIX_PUBLIC, API_KEY_PREFIX_SECRET } from "@gopaylocal/shared/constants";
import { requirePermission } from "../middleware/permissions";
import {
  pushApiKeyToKV,
  removeApiKeyFromKV,
  pushBannerConfigForOrg,
} from "../services/banner-cache.service";
import { errorSummary, logBannerPushFailure } from "../lib/log";
import { scopeOf } from "../lib/product-access";

const app = new Hono<AppEnv>();

/** Catch handler for a fire-and-forget KV write on an API key. */
function logKvFailure(action: string, orgId: string, apiKeyId: string) {
  return (err: unknown) => {
    console.error(`api-keys: KV ${action} failed`, { orgId, apiKeyId, error: errorSummary(err) });
  };
}

/**
 * Generate a cryptographically secure random key string.
 */
async function generateApiKey(prefix: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

/**
 * Hash a key using SHA-256.
 */
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// List API keys (show prefix only, not the full key)
app.get("/v1/teams/:orgId/api-keys", requirePermission("apiKeys.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const result = await db
      .select({
        id: apiKeys.id,
        organizationId: apiKeys.organizationId,
        name: apiKeys.name,
        keyType: apiKeys.keyType,
        keyPrefix: apiKeys.keyPrefix,
        // fullKey is only ever stored for public keys (public by design — see
        // schema comment). Secret keys have null here, so we never leak a secret.
        fullKey: apiKeys.fullKey,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        createdByUserId: apiKeys.createdByUserId,
        createdByName: users.name,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
      .where(eq(apiKeys.organizationId, orgId));

    // Defensive: only public keys may expose a fullKey, even if a secret row
    // somehow had the column populated. createdBy is null for keys created
    // before it was recorded, or whose creator's account was deleted.
    const data = result.map(({ createdByUserId, createdByName, ...row }) => ({
      ...row,
      fullKey: row.keyType === "public" ? row.fullKey : null,
      createdBy: createdByUserId ? { id: createdByUserId, name: createdByName } : null,
    }));

    return c.json({ data });
  } catch (err) {
    console.error("api-keys: failed to fetch API keys", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch API keys" }, 500);
  }
});

// Generate a new API key (returns the full key ONCE, stores only the hash)
app.post("/v1/teams/:orgId/api-keys", requirePermission("apiKeys.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = createApiKeySchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const prefix =
      parsed.data.keyType === "public"
        ? API_KEY_PREFIX_PUBLIC
        : API_KEY_PREFIX_SECRET;

    const rawKey = await generateApiKey(prefix);
    const keyHash = await hashKey(rawKey);
    const id = ulid();

    const isPublic = parsed.data.keyType === "public";

    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        id,
        organizationId: orgId,
        name: parsed.data.name,
        keyType: parsed.data.keyType,
        keyHash,
        keyPrefix: rawKey.substring(0, prefix.length + 8) + "...",
        // Store plaintext ONLY for public keys (used to render the banner
        // snippet later). Secret keys keep this null — only their hash lives in
        // the DB and the raw value is shown exactly once below.
        fullKey: isPublic ? rawKey : null,
        // A key cannot create keys (apiKeys.manage), so this is the signed-in
        // user; null rather than "" if that ever changed.
        createdByUserId: scopeOf(c).userId || null,
        createdAt: new Date(),
      })
      .returning();

    // Push API key mapping + banner config to KV (fire-and-forget). A failed
    // mapping push self-heals (the banner's DB fallback backfills it), but is
    // logged so a broken KV binding is visible.
    if (isPublic) {
      c.executionCtx.waitUntil(
        pushApiKeyToKV(c.env.CACHE, keyHash, id, orgId).catch(logKvFailure("push key mapping", orgId, id)),
      );
      c.executionCtx.waitUntil(
        pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
      );
    }

    // Return the full key ONCE — it cannot be retrieved again
    return c.json(
      {
        data: {
          id: apiKey!.id,
          name: apiKey!.name,
          keyType: apiKey!.keyType,
          key: rawKey,
          keyPrefix: apiKey!.keyPrefix,
          createdAt: apiKey!.createdAt,
        },
      },
      201,
    );
  } catch (err) {
    console.error("api-keys: failed to create API key", { error: errorSummary(err) });
    return c.json({ error: "Failed to create API key" }, 500);
  }
});

// Revoke an API key
app.delete("/v1/teams/:orgId/api-keys/:id", requirePermission("apiKeys.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const keyId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const result = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, orgId)))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "API key not found" }, 404);
    }

    // Remove API key mapping and banner config from KV. These entries have no
    // TTL and the banner/events fast paths trust them without touching the DB,
    // so if the mapping delete fails the REVOKED key keeps working. Never
    // silent: log loudly so it can be removed by hand.
    const deleted = result[0]!;
    if (deleted.keyType === "public") {
      c.executionCtx.waitUntil(
        removeApiKeyFromKV(c.env.CACHE, deleted.keyHash).catch(
          logKvFailure("REVOKED KEY STILL ACTIVE: remove key mapping", orgId, deleted.id),
        ),
      );
      c.executionCtx.waitUntil(
        c.env.CACHE.delete(`banner-config:${deleted.id}`).catch(
          logKvFailure("remove banner config", orgId, deleted.id),
        ),
      );
    }

    return c.json({ success: true });
  } catch (err) {
    console.error("api-keys: failed to delete API key", { error: errorSummary(err) });
    return c.json({ error: "Failed to delete API key" }, 500);
  }
});

export default app;
