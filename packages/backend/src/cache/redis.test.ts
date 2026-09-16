import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisCache } from './redis.js';

/**
 * These tests cover the cache's contract and, more importantly, its failure
 * policy. A Redis cache fronts session validation and WebSocket tickets, so
 * the behaviour that matters most is what happens when Redis misbehaves: the
 * call must degrade to a miss, never propagate an exception into a request.
 */

const { client, createClientMock } = vi.hoisted(() => {
  const client = {
    on: vi.fn(),
    connect: vi.fn(() => Promise.resolve(undefined)),
    quit: vi.fn(() => Promise.resolve(undefined)),
    disconnect: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    pExpire: vi.fn(),
    ping: vi.fn(),
  };
  return { client, createClientMock: vi.fn(() => client) };
});

vi.mock('redis', () => ({ createClient: createClientMock }));

describe('RedisCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.connect.mockResolvedValue(undefined);
    client.quit.mockResolvedValue(undefined);
    client.get.mockResolvedValue(null);
    client.set.mockResolvedValue('OK');
    client.del.mockResolvedValue(1);
    client.incr.mockResolvedValue(1);
    client.pExpire.mockResolvedValue(1);
    client.ping.mockResolvedValue('PONG');
  });

  it('reports its backend so callers can log which implementation is active', () => {
    expect(new RedisCache('redis://localhost:6379').backend).toBe('redis');
  });

  it('passes the connection URL to the redis client', () => {
    new RedisCache('redis://:secret@redis:6379');
    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'redis://:secret@redis:6379' })
    );
  });

  it('attaches an error listener so a redis blip cannot crash the process', () => {
    // node-redis emits `error` on the client; an unhandled `error` event on an
    // EventEmitter throws and would take the backend down.
    new RedisCache('redis://localhost:6379');
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  describe('connect and close', () => {
    it('connects on demand', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.connect();
      expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it('quits the connection it opened', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.connect();
      await cache.close();
      expect(client.quit).toHaveBeenCalledTimes(1);
    });

    it('does not quit a connection that was never opened', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.close();
      expect(client.quit).not.toHaveBeenCalled();
    });

    it('disconnects instead of throwing when the socket is already gone', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.connect();
      client.quit.mockRejectedValueOnce(new Error('socket closed'));
      await expect(cache.close()).resolves.toBeUndefined();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('returns the parsed value', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.get.mockResolvedValueOnce(JSON.stringify({ sessionId: 'abc' }));

      await expect(cache.get('ticket')).resolves.toEqual({ sessionId: 'abc' });
    });

    it('namespaces keys so instances can share a database', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.get('session:abc');
      expect(client.get).toHaveBeenCalledWith('aether:cache:session:abc');
    });

    it('returns null for a missing key', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.get.mockResolvedValueOnce(null);
      await expect(cache.get('nope')).resolves.toBeNull();
    });

    it('degrades to a miss when redis is unreachable', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // The caller then falls through to the database. Throwing here would
      // turn a cache outage into an authentication outage.
      await expect(cache.get('session:abc')).resolves.toBeNull();
    });
  });

  describe('set', () => {
    it('serializes the value and applies a millisecond TTL', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.set('session:abc', true, 5_000);

      expect(client.set).toHaveBeenCalledWith('aether:cache:session:abc', 'true', { PX: 5_000 });
    });

    it('rounds a fractional TTL up so the entry never expires early', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.set('k', 1, 1_500.4);
      expect(client.set).toHaveBeenCalledWith('aether:cache:k', '1', { PX: 1_501 });
    });

    it('swallows a write failure', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(cache.set('k', 1, 1_000)).resolves.toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes the key', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await cache.delete('ticket');
      expect(client.del).toHaveBeenCalledWith('aether:cache:ticket');
    });

    it('swallows a delete failure', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.del.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(cache.delete('ticket')).resolves.toBeUndefined();
    });
  });

  describe('increment', () => {
    it('increments and sets the window TTL on the first call only', async () => {
      const cache = new RedisCache('redis://localhost:6379');

      client.incr.mockResolvedValueOnce(1);
      expect(await cache.increment('hits', 60_000)).toBe(1);
      expect(client.pExpire).toHaveBeenCalledWith('aether:cache:hits', 60_000, 'NX');

      client.incr.mockResolvedValueOnce(2);
      expect(await cache.increment('hits', 60_000)).toBe(2);
      // A second pExpire would slide the window forward on every request, so a
      // steady stream of traffic would keep the window open forever.
      expect(client.pExpire).toHaveBeenCalledTimes(1);
    });

    it('fails open when redis is unreachable', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.incr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(cache.increment('hits', 1_000)).resolves.toBe(1);
    });
  });

  describe('sweep', () => {
    it('is a no-op because redis expires keys itself', () => {
      const cache = new RedisCache('redis://localhost:6379');
      expect(() => cache.sweep()).not.toThrow();
    });
  });

  describe('ping', () => {
    it('reports true when redis answers', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      await expect(cache.ping()).resolves.toBe(true);
    });

    it('reports false when redis does not answer', async () => {
      const cache = new RedisCache('redis://localhost:6379');
      client.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(cache.ping()).resolves.toBe(false);
    });
  });
});
