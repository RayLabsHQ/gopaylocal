// Runs before every integration test file (vitest.config.ts, integration
// project). Fails the file before any test code runs if DATABASE_URL points
// anywhere but a local test database; see testDatabaseUrl() in ./setup.ts.
import { afterEach, beforeEach, expect } from "vitest";
import { usageMeter } from "../services/usage-meter";
import { testDatabaseUrl } from "./setup";

testDatabaseUrl();

// The banner route meters every call through an isolate-wide UsageMeter. For
// unlimited organizations (Pro, self-hosted) it waits out a 15 s window before
// writing, and createTestClient's settle() would wait with it (past the 15 s
// testTimeout). With the window at 0 every call is written inside the request's
// own waitUntil, which settle() awaits, so tests see exact api_usage_daily rows.
usageMeter.configure({ unlimitedFlushDelayMs: 0 });

// The meter keeps buffered counts and a failure backoff in module state. Start
// every test from nothing, so counts from one test can never be written into the
// next test's (freshly truncated) tables.
beforeEach(() => {
  usageMeter.reset();
});

// Every request went through settle(), so nothing may still be buffered: a
// leftover count means some background work outlived the request that started it.
afterEach(() => {
  expect(usageMeter.bufferedCount(), "usage counts still buffered after the test (unsettled waitUntil?)").toBe(0);
});
