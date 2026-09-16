import { RedisCache } from './redis.js';
import { config } from '../config.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('cache');

/**
 * Small cache interface used for rate-limit counters and short-lived lookups.
 *
 * Two implementations ship: `MemoryCache` (in-process, the fallback) and
 * `RedisCache` (shared across replicas). Because the interface is
 * asynchronous, `initCache()` can select either at startup without any call
 * site knowing which one it got.
 *
 * Every method is best-effort: a cache failure is a miss, never a thrown
 * error. Callers must be able to rebuild the value from the database.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomically increments a counter, setting the TTL on first creation. */
  increment(key: string, ttlMs: number): Promise<number>;
  /** Removes expired entries. Called periodically by the owner. */
  sweep(): void;
  readonly backend: 'memory' | 'redis';
  /** Round-trips the backend. Only the Redis implementation can fail. */
  ping?(): Promise<boolean>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-process cache with lazy expiry and a hard entry cap.
 *
 * The cap matters: without one, an attacker who can trigger unique cache keys
 * (for example by rotating source IPs) could grow the map without bound.
 */
export class MemoryCache implements Cache {
  readonly backend = 'memory' as const;

  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      this.evict();
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  increment(key: string, ttlMs: number): Promise<number> {
    const existing = this.entries.get(key);
    const now = Date.now();

    if (!existing || existing.expiresAt <= now) {
      if (this.entries.size >= this.maxEntries) this.evict();
      this.entries.set(key, { value: 1, expiresAt: now + ttlMs });
      return Promise.resolve(1);
    }

    const next = (existing.value as number) + 1;
    existing.value = next;
    return Promise.resolve(next);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** Drops expired entries first; if none are expired, drops oldest-first. */
  private evict(): void {
    this.sweep();
    if (this.entries.size < this.maxEntries) return;

    const overflow = this.entries.size - this.maxEntries + 1;
    let removed = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      if (++removed >= overflow) break;
    }
  }
}

/**
 * The active backend. Swapped once by `initCache()` before the server listens,
 * so no call site ever has to care which implementation is in use.
 */
let active: Cache = new MemoryCache();

/**
 * Stable facade over the active backend.
 *
 * Call sites import `cache` directly, so this object must keep its identity
 * for the lifetime of the process. A facade — rather than reassigning the
 * export — is what lets `initCache()` swap the implementation without
 * invalidating the module bindings every importer already holds.
 */
export const cache: Cache = {
  get backend() {
    return active.backend;
  },
  get: <T>(key: string) => active.get<T>(key),
  set: <T>(key: string, value: T, ttlMs: number) => active.set<T>(key, value, ttlMs),
  delete: (key: string) => active.delete(key),
  increment: (key: string, ttlMs: number) => active.increment(key, ttlMs),
  sweep: () => active.sweep(),
  ping: () => (active.ping ? active.ping() : Promise.resolve(true)),
};

/**
 * Selects the cache backend.
 *
 * Runs before the HTTP listener opens. When `REDIS_URL` is set the Redis
 * backend is tried first; if Redis cannot be reached the process keeps
 * running on the in-process cache and logs the degradation loudly, because a
 * cache outage must not become a total outage. In that state the deployment
 * is single-replica-safe only: WebSocket tickets and rate-limit counters are
 * per-process.
 */
export async function initCache(): Promise<void> {
  if (!config.REDIS_URL) {
    log.info({ backend: 'memory' }, 'no REDIS_URL configured; using the in-process cache');
    return;
  }

  const redisCache = new RedisCache(config.REDIS_URL);
  try {
    await redisCache.connect();
    active = redisCache;
    log.info({ backend: 'redis' }, 'redis cache backend active');
  } catch (error) {
    log.error(
      { err: error },
      'REDIS_URL is set but Redis is unreachable; falling back to the in-process cache. ' +
        'WebSocket tickets and rate-limit counters are now per-process — run a single ' +
        'backend replica until Redis is reachable.'
    );
    await redisCache.close().catch(() => undefined);
  }
}

/** Releases the cache backend's resources. Safe to call when never connected. */
export async function closeCache(): Promise<void> {
  const current = active;
  active = new MemoryCache();
  if (current.backend === 'redis' && current instanceof RedisCache) {
    await current.close();
  }
}

/** Reports whether the active cache backend is answering. Drives the readiness probe. */
export async function checkCacheHealth(): Promise<{ ok: boolean; backend: 'memory' | 'redis' }> {
  if (active.backend === 'memory') {
    return { ok: true, backend: 'memory' };
  }
  const ok = active.ping ? await active.ping() : true;
  return { ok, backend: active.backend };
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Starts periodic expiry sweeping. Safe to call more than once. */
export function startCacheSweeper(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => cache.sweep(), intervalMs);
  sweepTimer.unref();
}

/** Stops the sweeper. Used during graceful shutdown and in tests. */
export function stopCacheSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
