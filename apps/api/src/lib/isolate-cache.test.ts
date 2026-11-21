import { describe, it, expect } from "vitest";
import { IsolateCache, deepFreeze } from "./isolate-cache";

describe("IsolateCache", () => {
  it("answers until the time limit, then misses", () => {
    const cache = new IsolateCache<string>(1_000);
    cache.set("a", "one", { now: 10_000 });
    expect(cache.get("a", 10_999)).toBe("one");
    expect(cache.get("a", 11_000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("a time limit of 0 stores nothing", () => {
    const cache = new IsolateCache<string>(0);
    cache.set("a", "one");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("configure changes the limit for entries stored afterwards", () => {
    const cache = new IsolateCache<string>(1_000);
    cache.set("a", "one", { now: 0 });
    cache.configure({ ttlMs: 5_000 });
    cache.set("b", "two", { now: 0 });
    expect(cache.get("a", 1_000)).toBeUndefined();
    expect(cache.get("b", 4_999)).toBe("two");
  });

  it("is emptied when a new entry would take it past its bound", () => {
    const cache = new IsolateCache<number>(1_000, 3);
    for (let i = 0; i < 3; i++) cache.set(`k${i}`, i);
    expect(cache.size()).toBe(3);
    cache.set("k3", 3);
    expect(cache.size()).toBe(1);
    expect(cache.get("k3")).toBe(3);
    expect(cache.get("k0")).toBeUndefined();
  });

  it("counts weights, not entries, and gives a replaced entry's weight back", () => {
    const cache = new IsolateCache<string>(1_000, 10);
    cache.set("a", "x", { weight: 6 });
    cache.set("a", "y", { weight: 6 }); // replaces: 6, not 12
    expect(cache.size()).toBe(1);
    cache.set("b", "z", { weight: 4 }); // 10: fits
    expect(cache.size()).toBe(2);
    cache.set("c", "w", { weight: 1 }); // 11: emptied first
    expect(cache.size()).toBe(1);
    expect(cache.get("a")).toBeUndefined();
  });

  it("gives an expired entry's weight back when it is read", () => {
    const cache = new IsolateCache<string>(1_000, 10);
    cache.set("a", "x", { weight: 10, now: 0 });
    expect(cache.get("a", 1_000)).toBeUndefined();
    cache.set("b", "y", { weight: 10, now: 1_000 });
    expect(cache.get("b", 1_500)).toBe("y");
  });

  it("does not store an entry heavier than the bound, and keeps the others", () => {
    const cache = new IsolateCache<string>(1_000, 10);
    cache.set("a", "x", { weight: 2 });
    cache.set("big", "y", { weight: 11 });
    expect(cache.get("big")).toBeUndefined();
    expect(cache.get("a")).toBe("x");
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays, so a write throws", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] }, n: null as null | number });
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
    expect(() => {
      (value.a.b as unknown[]).push(3);
    }).toThrow(TypeError);
    expect(() => {
      (value.a as { b: unknown }).b = 1;
    }).toThrow(TypeError);
  });

  it("returns primitives and null as they are", () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });
});
