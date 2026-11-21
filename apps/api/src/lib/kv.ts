/**
 * Get a typed value from KV, returning null if not found.
 */
export async function kvGet<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key, "text");
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Set a value in KV, optionally with a TTL in seconds.
 */
export async function kvSet(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const options: KVNamespacePutOptions = {};
  if (ttlSeconds !== undefined && ttlSeconds > 0) {
    options.expirationTtl = ttlSeconds;
  }
  await kv.put(key, JSON.stringify(value), options);
}

/**
 * Delete a key from KV.
 */
export async function kvDelete(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
