// Cache-aside over the tenant config store.
//
// A decorator rather than caching inside PostgresTenantStore: the in-memory
// store must stay cache-free for tests, and mixing a caching policy into a
// persistence class means neither can be reasoned about alone. This also keeps
// the read path honest — `#inner` is always the source of truth, and the cache
// is never consulted for anything but a read.

const KEY_PREFIX = 'tenant-config:';

export class CachingTenantStore {
  #inner;
  #cache;
  #ttlSeconds;
  #log;

  constructor({ inner, cache, ttlSeconds = 60, log = () => {} }) {
    if (!inner) throw new Error('An inner tenant store is required');
    if (!cache) throw new Error('A cache is required');
    this.#inner = inner;
    this.#cache = cache;
    this.#ttlSeconds = ttlSeconds;
    this.#log = log;
  }

  // Write-through-then-invalidate, in that order. Writing the new value into
  // the cache instead would be faster, but the value the database actually
  // stored is the one that must be served — `configure` normalises its input
  // (trimming, de-duplicating roles), so the stored config is not always
  // byte-identical to what was submitted. Deleting and letting the next read
  // repopulate cannot serve a value the database never had.
  async configure(tenantId, input) {
    const config = await this.#inner.configure(tenantId, input);
    await this.#cache.del(KEY_PREFIX + tenantId);
    return config;
  }

  async get(tenantId) {
    const key = KEY_PREFIX + tenantId;
    const cached = await this.#cache.get(key);
    if (cached !== null) {
      this.#log({ event: 'cache_hit', key });
      return cached;
    }

    const config = await this.#inner.get(tenantId);
    this.#log({ event: 'cache_miss', key });

    // A missing tenant is deliberately not cached. Negative caching would mean
    // that configuring a brand-new tenant leaves it looking unconfigured for a
    // full TTL — the exact moment a new customer is watching.
    if (config) await this.#cache.set(key, config, this.#ttlSeconds);
    return config;
  }

  // Routed through this.get so the lookup it performs is the cached one. Going
  // straight to #inner here would leave the hottest call in the Commission
  // daily close hitting Postgres on every attendant.
  async hasAttendant(tenantId, attendantId) {
    const config = await this.get(tenantId);
    return config ? config.attendants.some((attendant) => attendant.id === attendantId) : false;
  }
}
