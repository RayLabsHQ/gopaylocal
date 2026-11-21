import { test, expect } from "./fixtures";

// Smoke test for the fixture itself and the password login path that
// CLAUDE.md documents for automated testing. Needs only the local stack.
test.describe("Password test login", () => {
  test("a seeded user signs in at /login?pw=1 and lands on their dashboard", async ({ page, teamId }) => {
    expect(teamId).toBeTruthy();
    await expect(page).toHaveURL(/\/dashboard/);
    // Not bounced to onboarding (organization auto-selected) or back to login.
    await expect(page.getByPlaceholder("Password")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/onboarding/);
  });

  test("wrong password stays on the login page with an error", async ({ page, account }) => {
    await page.goto("/login?pw=1");
    await page.getByPlaceholder("Email").fill(account.email);
    await page.getByPlaceholder("Password").fill(`${account.password}-wrong`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Invalid email or password")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
