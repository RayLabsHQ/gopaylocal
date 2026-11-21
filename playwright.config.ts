import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real dashboard against the real API Worker
// (wrangler dev) and a LOCAL Postgres. Read e2e/README.md before running.
//
// The servers are NOT started automatically unless E2E_START_SERVERS=1:
// `pnpm dev:api` loads apps/api/.dev.vars, which must contain local-only
// values (copy apps/api/.dev.vars.example). Starting them is an explicit,
// informed choice. e2e/global-setup.ts then checks that the stack is
// reachable and uses the local database before any test runs.
const startServers = process.env.E2E_START_SERVERS === "1";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: startServers
    ? [
        {
          command: "pnpm dev:api",
          url: "http://localhost:8787/health",
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: "pnpm dev:dashboard",
          url: "http://localhost:3000",
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ]
    : undefined,
});
