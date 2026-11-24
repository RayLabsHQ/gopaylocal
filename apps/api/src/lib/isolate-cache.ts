/**
 * A small cache in the isolate's memory, with one time limit for all entries.
 *
 * For values that are looked up on every request, change rarely, and may be a
 * little old: an answer from memory needs no round trip. Plain data only,
 * never an I/O object or a promise (those belong to the request that made
 * them). A value from here is shared by every request of the isolate, so a
 * caller must not change it; deepFreeze() makes such a mistake throw.
 *
 * An isolate lives for as long as Cloudflare keeps it, so a hit is likely on a
 * busy key and unlikely on a quiet one; a miss does the lookup as before.
 * `ttlMs: 0` turns the cache off (every get misses), which is what the tests
 * use unless they test the cache itself.
 *
 * Size: every entry has a weight (1 unless given). When a new entry would take
 * the total past `maxWeight` the cache is emptied first (a bound, not an LRU),
 * and an entry heavier than `maxWeight` is not stored.
 */
export class IsolateCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number; weight: number }>();
  private totalWeight = 0;

  private ttlMs: number;
  private readonly maxWeight: number;

  constructor(ttlMs: number, maxWeight = 10_000) {
    this.ttlMs = ttlMs;
    this.maxWeight = maxWeight;
  }

  /** Change the time limit. Existing entries keep the limit they were stored with. */
  configure(options: { ttlMs: number }): void {
    this.ttlMs = options.ttlMs;
  }

  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.remove(key, entry.weight);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, options: { weight?: number; now?: number } = {}): void {
    if (this.ttlMs <= 0) return;
    const weight = Math.max(1, options.weight ?? 1);
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous.weight);
    if (weight > this.maxWeight) return;
    if (this.totalWeight + weight > this.maxWeight) this.clear();
    this.entries.set(key, { value, expiresAt: (options.now ?? Date.now()) + this.ttlMs, weight });
    this.totalWeight += weight;
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  /** Entries held, expired ones included until they are read or cleared (tests). */
  size(): number {
    return this.entries.size;
  }

  private remove(key: string, weight: number): void {
    this.entries.delete(key);
    this.totalWeight -= weight;
  }
}

/**
 * Freeze `value` and everything it holds (plain JSON data: no cycles). Used on
 * values that go into an IsolateCache, so that a request cannot change what
 * the next request reads.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
