import { config } from '../config.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('cache');

/**
 * Small cache interface used for rate-limit counters and short-lived lookups.
 *
 * The only implementation shipped today is in-process. A Redis-backed
 * implementation is planned for multi-replica deployments; see
 * `KNOWN-LIMITATIONS.md`. Because the interface is asynchronous, swapping the
 * implementation will not change any call site.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomically increments a counter, setting the TTL on first creation. */
  increment(key: string, ttlMs: number): Promise<number>;
  /** Removes expired entries. Called periodically by the owner. */
  sweep(): void;
  readonly backend: 'memory';
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

export const cache: Cache = new MemoryCache();

if (config.REDIS_URL) {
  log.warn(
    'REDIS_URL is configured but the Redis cache backend is not implemented in this release; ' +
      'falling back to the in-process cache. Rate-limit counters are therefore per-process.'
  );
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
