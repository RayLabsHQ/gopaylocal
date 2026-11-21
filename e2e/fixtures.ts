import { test as base, expect } from "@playwright/test";
import { seedAccount, type E2EAccount } from "./support/stack";

/**
 * Shared fixtures.
 *
 * `account`: a fresh password user that owns a fresh organization, seeded
 * directly in the local database (public email sign-up is disabled in the API,
 * so the old sign-up-through-the-API fixture can no longer work). The password
 * is random per test; nothing is hardcoded.
 *
 * `teamId`: signs that account in through the dashboard's test login form
 * (`/login?pw=1`), waits for `/dashboard`, and yields the organization id.
 * The API auto-selects the user's organization when the session is created,
 * so no onboarding step is needed.
 */
export const test = base.extend<{ account: E2EAccount; teamId: string }>({
  // eslint-disable-next-line no-empty-pattern
  account: async ({}, use) => {
    await use(await seedAccount());
  },

  teamId: async ({ page, account }, use) => {
    await page.goto("/login?pw=1");
    await page.getByPlaceholder("Email").fill(account.email);
    await page.getByPlaceholder("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/dashboard(\/|$|\?)/);
    await use(account.orgId);
  },
});

export { expect };
