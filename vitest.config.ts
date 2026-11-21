import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./packages/shared",
          include: ["**/*.test.ts"],
        },
      },
      {
        // The client packages. Node environment on purpose: no DOM library is
        // installed, and the tests use fakes for storage, fetch and crypto.
        test: {
          name: "sdk",
          root: "./packages",
          include: [
            "js-sdk/src/**/*.test.ts",
            "react-sdk/src/**/*.test.{ts,tsx}",
            "banner/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "api",
          root: "./apps/api",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          setupFiles: ["./src/test/unit.setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          root: "./apps/api",
          include: ["src/**/*.integration.test.ts"],
          // Refuses to start unless DATABASE_URL is a local test database.
          setupFiles: ["./src/test/integration.setup.ts"],
          testTimeout: 15000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
    ],
  },
});
