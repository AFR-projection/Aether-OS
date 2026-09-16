import { createClient } from 'redis';

import { subsystemLogger } from '../utils/logger.js';

import type { Cache } from './index.js';
import type { RedisClientType } from 'redis';

const log = subsystemLogger('cache:redis');

/** Key prefix so an Aether instance can share a Redis database safely. */
const KEY_PREFIX = 'aether:cache:';

/**
 * Redis-backed cache.
 *
 * The in-process cache is correct for a single backend replica, but it is
 * per-process: two replicas behind the proxy would each keep their own
 * rate-limit counters, their own session-validation cache, and — critically —
 * their own WebSocket tickets, so a ticket minted by one replica could not be
 * redeemed on another. This backend removes that constraint by keeping the
 * shared state in Redis.
 *
 * Failure policy: this class is **best-effort**, matching the `Cache`
 * contract. Every command is wrapped, and a Redis outage degrades to a cache
 * miss rather than a failed request:
 *
 * - `get` returns `null`, so a session check falls through to the database.
 * - `set`/`delete` are dropped and logged.
 * - `increment` returns 1, which fails open for a rate-limit counter. The
 *   alternative — rejecting the request — would turn a cache outage into a
 *   total outage, which is the worse failure for a management plane.
 *
 * Values are JSON-encoded, so only JSON-representable values may be cached.
 * Every current call site (a boolean and a small record) satisfies that.
 */
export class RedisCache implements Cache {
  readonly backend = 'redis' as const;

  private readonly client: RedisClientType;
  private connected = false;

  constructor(url: string) {
    this.client = createClient({
      url,
      // node-redis rejects the connection attempt itself when the server is
      // gone; this keeps the retry cadence gentle instead of spinning.
      socket: {
        reconnectStrategy: (attempts) => Math.min(attempts * 100, 3_000),
        connectTimeout: 5_000,
      },
    });

    // node-redis emits `error` on the client, and an unhandled `error` event
    // on an EventEmitter throws. This listener is what keeps a Redis blip from
    // taking the process down.
    this.client.on('error', (error: unknown) => {
      log.warn({ err: error }, 'redis client error');
    });
  }

  /** Opens the connection. Rejects if Redis is unreachable within the timeout. */
  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
  }

  /** Closes the connection, ignoring a connection that never opened. */
  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.quit();
    } catch {
      // The socket is already gone; nothing left to close. `disconnect`
      // returns void here, but node-redis types it as possibly-promise.
      void this.client.disconnect();
    }
  }

  /** Round-trips a PING. Used by the readiness endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      log.warn({ err: error }, 'redis ping failed');
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(KEY_PREFIX + key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      log.warn({ err: error, key }, 'redis get failed; treating as a cache miss');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      // `PX` takes milliseconds, matching the interface's `ttlMs`.
      await this.client.set(KEY_PREFIX + key, JSON.stringify(value), { PX: Math.ceil(ttlMs) });
    } catch (error) {
      log.warn({ err: error, key }, 'redis set failed; entry not cached');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(KEY_PREFIX + key);
    } catch (error) {
      log.warn({ err: error, key }, 'redis delete failed');
    }
  }

  /**
   * Atomically increments a counter, setting the TTL only on creation.
   *
   * `INCR` then `PEXPIRE ... NX` is the correct pairing: applying the expiry
   * unconditionally on every call would slide the window forward on each hit,
   * so a steady stream of requests would keep a rate-limit window open
   * forever. `NX` sets the TTL only when the key has none.
   */
  async increment(key: string, ttlMs: number): Promise<number> {
    const prefixed = KEY_PREFIX + key;
    try {
      const count = await this.client.incr(prefixed);
      if (count === 1) {
        await this.client.pExpire(prefixed, Math.ceil(ttlMs), 'NX');
      }
      return count;
    } catch (error) {
      log.warn({ err: error, key }, 'redis increment failed; failing open');
      return 1;
    }
  }

  /** No-op: Redis expires keys itself, so there is nothing to sweep. */
  sweep(): void {}
}
