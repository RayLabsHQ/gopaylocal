import { describe, it, expect } from "vitest";
import { kvGet, kvSet, kvDelete } from "./kv";
import { createMockKV } from "../test/helpers";

describe("kvGet", () => {
  it("returns parsed JSON value for an existing key", async () => {
    const kv = createMockKV();
    await kv.put("test-key", JSON.stringify({ foo: "bar", count: 42 }));

    const result = await kvGet<{ foo: string; count: number }>(kv, "test-key");
    expect(result).toEqual({ foo: "bar", count: 42 });
  });

  it("returns null for a missing key", async () => {
    const kv = createMockKV();

    const result = await kvGet(kv, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const kv = createMockKV();
    await kv.put("bad-json", "not-valid-json{{{");

    const result = await kvGet(kv, "bad-json");
    expect(result).toBeNull();
  });

  it("returns primitive values", async () => {
    const kv = createMockKV();
    await kv.put("str", JSON.stringify("hello"));
    await kv.put("num", JSON.stringify(123));
    await kv.put("bool", JSON.stringify(true));

    expect(await kvGet<string>(kv, "str")).toBe("hello");
    expect(await kvGet<number>(kv, "num")).toBe(123);
    expect(await kvGet<boolean>(kv, "bool")).toBe(true);
  });

  it("returns arrays", async () => {
    const kv = createMockKV();
    await kv.put("arr", JSON.stringify([1, 2, 3]));

    expect(await kvGet<number[]>(kv, "arr")).toEqual([1, 2, 3]);
  });
});

describe("kvSet", () => {
  it("stores JSON-serialized value", async () => {
    const kv = createMockKV();
    await kvSet(kv, "my-key", { hello: "world" });

    const raw = await kv.get("my-key", "text");
    expect(raw).toBe('{"hello":"world"}');
  });

  it("stores value with TTL", async () => {
    const kv = createMockKV();
    await kvSet(kv, "ttl-key", "value", 3600);

    const result = await kvGet<string>(kv, "ttl-key");
    expect(result).toBe("value");
  });

  it("stores value without TTL when ttlSeconds is undefined", async () => {
    const kv = createMockKV();
    await kvSet(kv, "no-ttl", { data: true });

    const result = await kvGet<{ data: boolean }>(kv, "no-ttl");
    expect(result).toEqual({ data: true });
  });

  it("overwrites existing value", async () => {
    const kv = createMockKV();
    await kvSet(kv, "key", "first");
    await kvSet(kv, "key", "second");

    const result = await kvGet<string>(kv, "key");
    expect(result).toBe("second");
  });

  it("ignores TTL of 0 or negative", async () => {
    const kv = createMockKV();
    // Should not throw and should store the value
    await kvSet(kv, "zero-ttl", "val", 0);
    expect(await kvGet<string>(kv, "zero-ttl")).toBe("val");

    await kvSet(kv, "neg-ttl", "val", -1);
    expect(await kvGet<string>(kv, "neg-ttl")).toBe("val");
  });
});

describe("kvDelete", () => {
  it("removes an existing key", async () => {
    const kv = createMockKV();
    await kvSet(kv, "to-delete", "value");
    expect(await kvGet(kv, "to-delete")).toBe("value");

    await kvDelete(kv, "to-delete");
    expect(await kvGet(kv, "to-delete")).toBeNull();
  });

  it("does not throw when deleting a nonexistent key", async () => {
    const kv = createMockKV();
    await expect(kvDelete(kv, "nonexistent")).resolves.toBeUndefined();
  });
});
