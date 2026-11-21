/**
 * A small cache in the isolate's memory, with one time limit for all entries.
 *
 * For values that are read from KV on every request, change rarely, and may be
 * a little old: each KV read is billed, memory is not. Plain data only, never
 * an I/O object or a promise (those belong to the request that made them).
 *
 * An isolate lives for as long as Cloudflare keeps it, so a hit is likely on a
 * busy key and unlikely on a quiet one; a miss costs what it cost before.
 * `ttlMs: 0` turns the cache off (every get misses), which is what the tests
 * use unless they test the cache itself.
 */
export class IsolateCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    /** At this many entries the cache is emptied (a bound, not an LRU). */
    private readonly maxEntries = 10_000,
  ) {}

  /** Change the time limit. Existing entries keep the limit they were stored with. */
  configure(options: { ttlMs: number }): void {
    this.ttlMs = options.ttlMs;
  }

  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
