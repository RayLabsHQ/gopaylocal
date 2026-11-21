// Runs before every API unit test file (vitest.config.ts, api project).
import { beforeEach } from "vitest";
import { configureBannerHotCache } from "../services/banner-hot-cache";

// The banner config route remembers key and quota lookups in module memory for
// a minute (services/banner-hot-cache.ts). Unit tests seed a fresh KV per test
// and often change it between two requests, so the memory is off unless a test
// turns it on (routes/banner-script.test.ts, "remembered lookups").
beforeEach(() => {
  configureBannerHotCache({ ttlMs: 0 });
});
