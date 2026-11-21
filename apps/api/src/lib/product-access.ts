// ── Member product access ───────────────────────────────────────────────────
// The `scoped` cells of the permission table (packages/shared/src/permissions)
// resolve here. Owners and admins work on every product. A member works on
// their explicit product scope (db/schema.ts, member_product_scopes):
//   - all products, or
//   - a listed set of products, where an EMPTY set means NO products.
// A member with no scope row has the default, all products (what a member
// gets on joining). Scope and grants hang off member.id with ON DELETE
// CASCADE, so they disappear with the membership.

import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { resolveRole } from "@gopaylocal/shared/permissions";
import { memberProductAccess, memberProductScopes, members, campaigns } from "../db/schema";
import type { Database } from "../db";
import type { AppEnv } from "../bindings";

/** Anything that can run a select: the database or an open transaction. */
type Queryable = Pick<Database, "select">;

export type ProductScope = { allProducts: true } | { allProducts: false; productIds: string[] };

/**
 * A member's stored scope, by member id. No scope row means the default, all
 * products. Grants are read by member_id only, so rows from an earlier
 * membership of the same person can never apply.
 */
export async function getMemberProductScope(
  db: Queryable,
  orgId: string,
  memberId: string,
): Promise<ProductScope> {
  const rows = await db
    .select({ allProducts: memberProductScopes.allProducts, productId: memberProductAccess.productId })
    .from(memberProductScopes)
    .leftJoin(
      memberProductAccess,
      and(
        eq(memberProductAccess.memberId, memberProductScopes.memberId),
        eq(memberProductAccess.organizationId, orgId),
      ),
    )
    .where(and(eq(memberProductScopes.memberId, memberId), eq(memberProductScopes.organizationId, orgId)));
  if (rows.length === 0 || rows[0]!.allProducts) return { allProducts: true };
  return { allProducts: false, productIds: rows.flatMap((r) => (r.productId ? [r.productId] : [])) };
}

/**
 * Replace a member's scope: upsert the scope row, then rewrite the grant set.
 * Run it inside a transaction. Product ids must already be checked to belong
 * to `orgId`.
 */
export async function setMemberProductScope(
  tx: Pick<Database, "insert" | "delete">,
  input: { orgId: string; memberId: string; userId: string; scope: ProductScope; newId: () => string },
): Promise<void> {
  const { orgId, memberId, userId, scope, newId } = input;
  const now = new Date();
  await tx
    .insert(memberProductScopes)
    .values({ memberId, organizationId: orgId, allProducts: scope.allProducts, updatedAt: now })
    .onConflictDoUpdate({
      target: memberProductScopes.memberId,
      set: { allProducts: scope.allProducts, updatedAt: now },
    });
  // Also clears grant rows written for this person before member_id existed,
  // so the unique (organization_id, user_id, product_id) index cannot collide.
  await tx
    .delete(memberProductAccess)
    .where(and(eq(memberProductAccess.organizationId, orgId), eq(memberProductAccess.userId, userId)));
  if (!scope.allProducts && scope.productIds.length > 0) {
    await tx.insert(memberProductAccess).values(
      scope.productIds.map((productId) => ({
        id: newId(),
        organizationId: orgId,
        userId,
        memberId,
        productId,
        createdAt: now,
      })),
    );
  }
}

/**
 * The `role` value that stands for a secret API key (middleware/api-key.ts) in
 * the helpers below: every product of its workspace. Not a workspace role (the
 * permission table's resolveRole never returns it, and teamMiddleware only
 * ever sets owner, admin or member), so no membership can carry it.
 */
export const API_KEY_SCOPE = "api_key";

/**
 * Whose product scope a /v1/teams request is resolved for: the signed-in
 * member, or the secret key (no user, all products). Route handlers use this
 * (or allowedProductIdsFor / allowedCampaignIdsFor) instead of reading
 * c.get("user") and c.get("memberRole"), which a key request does not have.
 */
export function scopeOf(c: Context<AppEnv>): { userId: string; role: string | undefined } {
  if (c.get("apiKey")) return { userId: "", role: API_KEY_SCOPE };
  return { userId: c.get("user").id, role: c.get("memberRole") };
}

/** getAllowedProductIds for whoever makes the request. */
export function allowedProductIdsFor(
  c: Context<AppEnv>,
  db: Queryable,
  orgId: string,
): Promise<Set<string> | null> {
  const { userId, role } = scopeOf(c);
  return getAllowedProductIds(db, orgId, userId, role);
}

/** getAllowedCampaignIds for whoever makes the request. */
export function allowedCampaignIdsFor(
  c: Context<AppEnv>,
  db: Queryable,
  orgId: string,
): Promise<Set<string> | null> {
  const { userId, role } = scopeOf(c);
  return getAllowedCampaignIds(db, orgId, userId, role);
}

/**
 * Resolve which products a user may access within an org.
 * - null     -> ALL products (owner, admin, a secret API key, or a member whose scope is all products).
 * - Set<id>  -> exactly these products. An empty set means none: a member with
 *               an empty listed scope, an unknown role, or no membership.
 */
export async function getAllowedProductIds(
  db: Queryable,
  orgId: string,
  userId: string,
  role: string | undefined,
): Promise<Set<string> | null> {
  if (role === API_KEY_SCOPE) return null;
  const resolved = resolveRole(role);
  if (resolved === "owner" || resolved === "admin") return null;
  if (resolved !== "member") return new Set();

  // One round trip: the membership, its scope row (if any) and its grants.
  const rows = await db
    .select({
      memberId: members.id,
      allProducts: memberProductScopes.allProducts,
      productId: memberProductAccess.productId,
    })
    .from(members)
    .leftJoin(memberProductScopes, eq(memberProductScopes.memberId, members.id))
    .leftJoin(
      memberProductAccess,
      and(eq(memberProductAccess.memberId, members.id), eq(memberProductAccess.organizationId, orgId)),
    )
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)));

  const first = rows[0];
  if (!first) return new Set();
  // No scope row (allProducts null) is the default: all products.
  if (first.allProducts !== false) return null;
  return new Set(
    rows.flatMap((r) => (r.memberId === first.memberId && r.productId ? [r.productId] : [])),
  );
}

/** True if `allowed` (from getAllowedProductIds) permits this product. */
export function canAccessProduct(
  allowed: Set<string> | null,
  productId: string | null | undefined,
): boolean {
  if (allowed === null) return true;
  return productId != null && allowed.has(productId);
}

/**
 * Resolve which campaigns a user may access within an org, derived from their
 * product scope.
 * - null    -> ALL campaigns (owner/admin, or a member with all products).
 * - Set<id> -> restricted to campaigns whose product is in scope; empty when
 *              the scope is empty or its products have no campaigns yet.
 */
export async function getAllowedCampaignIds(
  db: Queryable,
  orgId: string,
  userId: string,
  role: string | undefined,
): Promise<Set<string> | null> {
  const allowedProducts = await getAllowedProductIds(db, orgId, userId, role);
  if (allowedProducts === null) return null;
  if (allowedProducts.size === 0) return new Set();

  const rows = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.organizationId, orgId),
        inArray(campaigns.productId, Array.from(allowedProducts)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * True when `campaignId` exists IN `orgId` and the user may access it.
 *
 * Always checks org ownership first, for every role: owners and admins skip
 * only the product-scope step, never the tenant check. (An earlier version
 * returned true for owners/admins without looking the campaign up, so a
 * caller that trusted it alone could act on another org's campaign id.)
 * Accepts an open transaction so callers can make the check atomic with the
 * writes that depend on it.
 */
export async function assertCampaignAccess(
  db: Queryable,
  userId: string,
  role: string | undefined,
  orgId: string,
  campaignId: string,
): Promise<boolean> {
  const [camp] = await db
    .select({ productId: campaigns.productId })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, orgId)))
    .limit(1);
  if (!camp) return false;
  const allowed = await getAllowedProductIds(db, orgId, userId, role);
  return canAccessProduct(allowed, camp.productId);
}
