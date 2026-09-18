// Cache clients. Two implementations behind one three-method interface, so
// every caller — and every test — is written against the same shape whether a
// cache exists or not.

// The default. POS runs with no cache at all unless one is configured, and
// nothing above this layer knows the difference.
export class NoopCache {
  async get() { return null; }
  async set() {}
  async del() {}
  async close() {}
}

// Thin wrapper over a node-redis-compatible client. The client is injected
// rather than constructed here so the tests can drive the failure paths —
// which is most of what is worth testing about a cache.
export class RedisCache {
  #client;
  #log;

  constructor(client, log = () => {}) {
    if (!client) throw new Error('A Redis-compatible client is required');
    this.#client = client;
    this.#log = log;
  }

  // Every method fails open. A cache is an optimisation; if it is unreachable
  // the correct behaviour is to serve the request slightly slower from the
  // database, not to fail it. A cache outage that takes POS down with it is a
  // strictly worse system than no cache.
  async get(key) {
    try {
      const raw = await this.#client.get(key);
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (error) {
      this.#log({ event: 'cache_get_failed', key, message: error.message });
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    try {
      await this.#client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.#log({ event: 'cache_set_failed', key, message: error.message });
    }
  }

  // The one method whose failure is NOT harmless: a delete that silently fails
  // leaves a stale config being served until the TTL expires. It still must not
  // throw — the write it follows has already succeeded — but it is logged at a
  // level that says so, because it is the one path that can serve wrong data.
  async del(key) {
    try {
      await this.#client.del(key);
    } catch (error) {
      this.#log({ event: 'cache_invalidation_failed', key, message: error.message, staleUntilTtl: true });
    }
  }

  async close() {
    try { await this.#client.quit(); } catch { /* shutting down anyway */ }
  }
}
