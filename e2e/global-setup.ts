import { API_URL, APP_URL, e2eDatabaseUrl, seedAccount } from "./support/stack";

/**
 * Preflight for the e2e suite (runs once, after any webServer has started).
 * Fails fast with a pointer to e2e/README.md instead of letting every test
 * time out, and refuses to run unless the stack is local:
 *   1. E2E_DATABASE_URL (default: the docker-compose dev database) is loopback.
 *   2. The API (:8787) and dashboard (:3000) answer.
 *   3. A freshly seeded account can sign in through the API. Accounts are
 *      seeded straight into E2E_DATABASE_URL, so this proves the running API
 *      uses that same local database (a fresh random email exists nowhere else).
 */
export default async function globalSetup() {
  e2eDatabaseUrl();

  for (const [name, url] of [
    ["API", `${API_URL}/health`],
    ["dashboard", APP_URL],
  ] as const) {
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) {
      throw new Error(`The ${name} is not reachable at ${url}. Start the local stack first: see e2e/README.md.`);
    }
  }

  const probe = await seedAccount("Preflight");
  const signIn = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_URL },
    body: JSON.stringify({ email: probe.email, password: probe.password }),
  });
  if (signIn.status !== 200) {
    throw new Error(
      `A user seeded into E2E_DATABASE_URL could not sign in through ${API_URL} (HTTP ${signIn.status}). ` +
        "The running API is not using that database (or password sign-in is broken). See e2e/README.md.",
    );
  }
}
