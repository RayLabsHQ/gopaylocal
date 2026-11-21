import { describe, it, expect } from "vitest";
import { clampFrom } from "./analytics";

const DAY_MS = 86_400_000;

describe("clampFrom (analytics lower bound)", () => {
  const retentionStart = Date.UTC(2026, 10, 1); // 2026-11-01

  it("uses the retention start when no `from` is given", () => {
    expect(clampFrom(undefined, retentionStart).getTime()).toBe(retentionStart);
  });

  it("never reaches back past the plan's retention window", () => {
    expect(clampFrom("2000-01-01", retentionStart).getTime()).toBe(retentionStart);
  });

  it("narrows to a later `from` inside the window", () => {
    const later = retentionStart + 5 * DAY_MS;
    expect(clampFrom(new Date(later).toISOString(), retentionStart).getTime()).toBe(later);
  });

  it("ignores an unparseable `from` instead of producing an Invalid Date (was a 500)", () => {
    const out = clampFrom("not-a-date", retentionStart);
    expect(Number.isNaN(out.getTime())).toBe(false);
    expect(out.getTime()).toBe(retentionStart);
  });
});
