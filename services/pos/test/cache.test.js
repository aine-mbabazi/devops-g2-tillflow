import assert from 'node:assert/strict';
import test from 'node:test';
import { NoopCache, RedisCache } from '../src/cache.js';
import { CachingTenantStore } from '../src/caching-tenant-store.js';
import { InMemoryTenantStore } from '../src/tenant-store.js';

const CONFIG = {
  attendants: [{ attendant_id: 'a1', phone: '+254700000001' }],
  commission_rate_basis_points: 250,
};

// A cache that records what was asked of it, so the tests can assert on the
// access pattern rather than only on the returned value — "it returned the
// right config" is true whether or not the cache was consulted at all.
function recordingCache() {
  const store = new Map();
  const calls = [];
  return {
    calls,
    async get(key) { calls.push(['get', key]); return store.has(key) ? store.get(key) : null; },
    async set(key, value) { calls.push(['set', key]); store.set(key, value); },
    async del(key) { calls.push(['del', key]); store.delete(key); },
    async close() {},
  };
}

function storeWithCountingInner(cache) {
  const inner = new InMemoryTenantStore();
  let reads = 0;
  const counting = {
    configure: (tenantId, input) => inner.configure(tenantId, input),
    get: (tenantId) => { reads += 1; return inner.get(tenantId); },
    hasAttendant: (tenantId, attendantId) => inner.hasAttendant(tenantId, attendantId),
  };
  return {
    store: new CachingTenantStore({ inner: counting, cache, ttlSeconds: 60 }),
    reads: () => reads,
  };
}

test('a repeated read is served from the cache, not from the store', async () => {
  const cache = recordingCache();
  const { store, reads } = storeWithCountingInner(cache);
  await store.configure('t1', normalized(CONFIG));

  const first = await store.get('t1');
  const second = await store.get('t1');

  assert.deepEqual(second, first);
  assert.equal(reads(), 1, 'the second read must not reach the store');
  assert.deepEqual(
    cache.calls.map(([op]) => op),
    ['del', 'get', 'set', 'get'],
    'configure invalidates; the first read misses then populates; the second hits',
  );
});

test('reconfiguring a tenant invalidates the cached config', async () => {
  const cache = recordingCache();
  const { store } = storeWithCountingInner(cache);
  await store.configure('t1', normalized(CONFIG));
  await store.get('t1'); // populate

  await store.configure('t1', normalized({ ...CONFIG, commission_rate_basis_points: 500 }));
  const after = await store.get('t1');

  // The bug this guards against is the one that would be invisible in
  // production for a full TTL: an owner changes their commission rate, the
  // screen still shows the old one, and every payout for the next minute is
  // calculated from stale configuration.
  assert.equal(after.commissionRateBasisPoints, 500);
});

test('a tenant that does not exist is not negatively cached', async () => {
  const cache = recordingCache();
  const { store } = storeWithCountingInner(cache);

  assert.equal(await store.get('never-configured'), null);
  assert.ok(
    !cache.calls.some(([op]) => op === 'set'),
    'caching the absence would leave a brand-new tenant looking unconfigured for a full TTL',
  );
});

test('hasAttendant goes through the cache', async () => {
  const cache = recordingCache();
  const { store, reads } = storeWithCountingInner(cache);
  await store.configure('t1', normalized(CONFIG));

  assert.equal(await store.hasAttendant('t1', 'a1'), true);
  assert.equal(await store.hasAttendant('t1', 'a1'), true);
  assert.equal(await store.hasAttendant('t1', 'nobody'), false);
  assert.equal(reads(), 1, 'the daily close checks every attendant — this must not hit Postgres each time');
});

test('a cache outage degrades to the store instead of failing the request', async () => {
  const broken = {
    async get() { throw new Error('ECONNREFUSED'); },
    async set() { throw new Error('ECONNREFUSED'); },
    async del() { throw new Error('ECONNREFUSED'); },
    async quit() {},
  };
  const entries = [];
  const cache = new RedisCache(broken, (entry) => entries.push(entry));
  const { store, reads } = storeWithCountingInner(cache);

  await store.configure('t1', normalized(CONFIG));
  const config = await store.get('t1');

  // The whole point of cache-aside: Valkey being down costs latency, not
  // availability. A cache outage that takes POS down with it would be a
  // strictly worse system than having no cache at all.
  assert.equal(config.commissionRateBasisPoints, 250);
  assert.equal(reads(), 1);
  assert.ok(entries.some((entry) => entry.event === 'cache_get_failed'));
  // An invalidation that failed is the one case that can serve stale data, so
  // it is logged distinctly rather than lumped in with the harmless failures.
  assert.ok(entries.some((entry) => entry.event === 'cache_invalidation_failed' && entry.staleUntilTtl === true));
});

test('RedisCache round-trips through a client and sets the TTL', async () => {
  const commands = [];
  const fake = {
    store: new Map(),
    async get(key) { commands.push(['get', key]); return this.store.get(key) ?? null; },
    async set(key, value, options) { commands.push(['set', key, options]); this.store.set(key, value); },
    async del(key) { commands.push(['del', key]); this.store.delete(key); },
    async quit() {},
  };
  const cache = new RedisCache(fake);

  assert.equal(await cache.get('missing'), null);
  await cache.set('k', { a: 1 }, 60);
  assert.deepEqual(await cache.get('k'), { a: 1 });
  assert.deepEqual(commands[1], ['set', 'k', { EX: 60 }]);
});

test('the no-op cache satisfies the interface and caches nothing', async () => {
  const cache = new NoopCache();
  await cache.set('k', { a: 1 }, 60);
  assert.equal(await cache.get('k'), null);
});

// CachingTenantStore delegates to the inner store, which expects the shape
// validateTenantConfig produces, not the wire shape.
function normalized({ attendants, commission_rate_basis_points: rate }) {
  return {
    attendants: attendants.map((a) => ({ id: a.attendant_id, phone: a.phone })),
    commissionRateBasisPoints: rate,
    tills: [],
    roles: {},
  };
}
