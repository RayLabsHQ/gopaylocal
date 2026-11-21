// Tests for scripts/sync-admins.js (run by `deploy:full` after migrations).
// Lives under src/ only because the `api` vitest project includes
// src/**/*.test.ts. Nothing here opens a database connection: only the TLS
// decision is tested, and importing the script must not run it.

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type SslOption = false | "allow" | "prefer" | "require" | "verify-full" | undefined;
type SyncAdminsModule = {
  resolveSsl: (databaseUrl: string, env: Record<string, string | undefined>) => SslOption;
};

const scriptPath = fileURLToPath(new URL("../../scripts/sync-admins.js", import.meta.url));
// Plain JS outside the TS project: import by computed URL, typed by hand above.
const loadScript = () => import(pathToFileURL(scriptPath).href) as Promise<SyncAdminsModule>;

const REMOTE = "postgres://user:pw@db.example.com:5432/gopaylocal";

describe("sync-admins resolveSsl", () => {
  it("keeps TLS required for a remote host with no other setting (previous behaviour)", async () => {
    const { resolveSsl } = await loadScript();
    expect(resolveSsl(REMOTE, {})).toBe("require");
  });

  it("connects without TLS to a loopback host (the docker-compose database)", async () => {
    const { resolveSsl } = await loadScript();
    expect(resolveSsl("postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal", {})).toBe(false);
    expect(resolveSsl("postgresql://u:p@127.0.0.1:5433/db", {})).toBe(false);
    expect(resolveSsl("postgresql://u:p@[::1]:5433/db", {})).toBe(false);
  });

  it("leaves sslmode in the URL, or PGSSLMODE, to the driver", async () => {
    const { resolveSsl } = await loadScript();
    expect(resolveSsl(`${REMOTE}?sslmode=disable`, {})).toBeUndefined();
    expect(resolveSsl(`${REMOTE}?sslmode=verify-full`, {})).toBeUndefined();
    expect(resolveSsl("postgresql://u:p@localhost/db?sslmode=require", {})).toBeUndefined();
    expect(resolveSsl(REMOTE, { PGSSLMODE: "verify-full" })).toBeUndefined();
  });

  it("lets DATABASE_SSL override everything", async () => {
    const { resolveSsl } = await loadScript();
    expect(resolveSsl(REMOTE, { DATABASE_SSL: "disable" })).toBe(false);
    expect(resolveSsl(REMOTE, { DATABASE_SSL: "false" })).toBe(false);
    expect(resolveSsl(`${REMOTE}?sslmode=disable`, { DATABASE_SSL: "verify-full" })).toBe("verify-full");
    expect(resolveSsl("postgresql://u:p@localhost/db", { DATABASE_SSL: " Require " })).toBe("require");
    expect(resolveSsl(REMOTE, { DATABASE_SSL: "true" })).toBe("require");
  });

  it("rejects an unknown DATABASE_SSL value instead of guessing", async () => {
    const { resolveSsl } = await loadScript();
    expect(() => resolveSsl(REMOTE, { DATABASE_SSL: "yes" })).toThrow(/DATABASE_SSL/);
  });

  it("falls back to TLS required for a connection string that is not a URL", async () => {
    const { resolveSsl } = await loadScript();
    expect(resolveSsl("host=db.example.com dbname=gopaylocal", {})).toBe("require");
  });
});

describe("sync-admins as a command", () => {
  it("skips cleanly with exit code 0 when DATABASE_URL is unset", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.ADMIN_EMAILS;
    const run = spawnSync(process.execPath, [scriptPath], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("DATABASE_URL not set, skipping admin sync.");
  });

  it("exits 1 before connecting when DATABASE_SSL is invalid", () => {
    const env = {
      ...process.env,
      // Unroutable on purpose: the script must fail on DATABASE_SSL first.
      DATABASE_URL: "postgres://u:p@db.invalid:5432/db",
      ADMIN_EMAILS: "admin@example.com",
      DATABASE_SSL: "yes",
    };
    const run = spawnSync(process.execPath, [scriptPath], { env, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("DATABASE_SSL");
  });
});
