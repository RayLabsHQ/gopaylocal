import { describe, it, expect, vi } from "vitest";
import { errorSummary, logBannerPushFailure, pgErrorCode } from "./log";

/**
 * Same shape as drizzle-orm's DrizzleQueryError (0.44+): the message embeds
 * the SQL AND its parameter values; the driver error is `.cause`. Built by
 * hand so the test does not depend on that class staying exported.
 */
function drizzleQueryError(query: string, params: unknown[], cause: Error): Error {
  return Object.assign(new Error(`Failed query: ${query}\nparams: ${params.join(",")}`), {
    query,
    params,
    cause,
  });
}

const pgError = () =>
  Object.assign(new Error('column "analytics_rollups" of relation "analytics_rollups" does not exist'), {
    name: "PostgresError",
    code: "42703",
    detail: "Key (code)=(SECRET-ROW-VALUE) already exists.",
  });

describe("errorSummary", () => {
  it("reports name, message and SQLSTATE of a driver error, never `detail`", () => {
    const out = errorSummary(pgError());
    expect(out).toBe(
      'PostgresError: column "analytics_rollups" of relation "analytics_rollups" does not exist (code 42703)',
    );
    expect(out).not.toContain("SECRET-ROW-VALUE");
  });

  it("unwraps Drizzle's DrizzleQueryError: keeps the SQL text, drops the parameter values", () => {
    const wrapped = drizzleQueryError(
      'update "integrations" set "live_access_token_enc" = $1 where "integrations"."id" = $2',
      ["v1.SENSITIVE-CIPHERTEXT", "int_1"],
      pgError(),
    );
    const out = errorSummary(wrapped);
    expect(out).toContain("PostgresError:");
    expect(out).toContain("(code 42703)");
    expect(out).toContain('[query: update "integrations" set "live_access_token_enc" = $1');
    expect(out).not.toContain("SENSITIVE-CIPHERTEXT");
    expect(out).not.toContain("int_1");
  });

  it("handles non-Error throwables", () => {
    expect(errorSummary("plain string")).toBe("plain string");
  });
});

describe("pgErrorCode", () => {
  it("reads the SQLSTATE from a bare or wrapped driver error", () => {
    const fk = Object.assign(new Error("fk"), { code: "23503" });
    expect(pgErrorCode(fk)).toBe("23503");
    expect(pgErrorCode(drizzleQueryError("delete ...", [], fk))).toBe("23503");
    expect(pgErrorCode(new Error("no code"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
  });
});

describe("logBannerPushFailure", () => {
  it("logs the org and the error summary", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logBannerPushFailure("org_1")(pgError());
    expect(spy).toHaveBeenCalledWith("banner-cache: rebuild failed", {
      orgId: "org_1",
      error: expect.stringContaining("(code 42703)"),
    });
    spy.mockRestore();
  });
});
