/**
 * Drizzle (0.44+) wraps every driver error in a DrizzleQueryError whose
 * MESSAGE embeds the full SQL and its parameter VALUES, with the real
 * postgres-js error (SQLSTATE `code`, message) on `.cause`. Detected by shape,
 * not by class, so it keeps working across Drizzle versions.
 */
function unwrapQueryError(err: Error): { driver: Error; query?: string } {
  const wrapped = err as Error & { query?: unknown; cause?: unknown };
  if (typeof wrapped.query === "string" && wrapped.cause instanceof Error) {
    return { driver: wrapped.cause, query: wrapped.query };
  }
  return { driver: err };
}

/** The Postgres SQLSTATE of a (possibly Drizzle-wrapped) query error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (unwrapQueryError(err).driver as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * One-line, log-safe description of a caught error for console.error context.
 *
 * Workers logs serialize nested Error objects poorly (often as `{}`), so pass
 * this string instead of the raw error. For query errors it reports the
 * driver's message, the Postgres SQLSTATE (e.g. 42703 undefined_column, 23505
 * unique violation) and the parameterized SQL text, but never the parameter
 * values or Postgres' `detail` (both can hold row data).
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { driver, query } = unwrapQueryError(err);
  const code = pgErrorCode(err);
  let out = `${driver.name}: ${driver.message}`;
  if (code) out += ` (code ${code})`;
  if (query) out += ` [query: ${query.length > 300 ? `${query.slice(0, 300)}...` : query}]`;
  return out;
}

/**
 * Catch handler for the fire-and-forget banner KV rebuild
 * (pushBannerConfigForOrg in waitUntil). The request has already succeeded,
 * so this never changes a response, but a failed rebuild leaves the live
 * banner serving the previous config (a paused campaign keeps showing, a new
 * discount or coupon never appears) until the next rebuild, so it is logged.
 */
export function logBannerPushFailure(orgId: string): (err: unknown) => void {
  return (err: unknown) => {
    console.error("banner-cache: rebuild failed", { orgId, error: errorSummary(err) });
  };
}
