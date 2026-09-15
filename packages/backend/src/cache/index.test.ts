import { describe, expect, it, vi } from 'vitest';

import { MemoryCache } from './index.js';

describe('MemoryCache', () => {
  it('stores and retrieves a value', async () => {
    const cache = new MemoryCache();
    await cache.set('a', { value: 1 }, 1_000);
    expect(await cache.get<{ value: number }>('a')).toEqual({ value: 1 });
  });

  it('returns null for a missing key', async () => {
    const cache = new MemoryCache();
    expect(await cache.get('nope')).toBeNull();
  });

  it('expires entries lazily', async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      await cache.set('a', 1, 1_000);

      vi.advanceTimersByTime(999);
      expect(await cache.get('a')).toBe(1);

      vi.advanceTimersByTime(2);
      expect(await cache.get('a')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a key explicitly', async () => {
    const cache = new MemoryCache();
    await cache.set('a', 1, 1_000);
    await cache.delete('a');
    expect(await cache.get('a')).toBeNull();
  });

  describe('increment', () => {
    it('counts from one and keeps counting', async () => {
      const cache = new MemoryCache();
      expect(await cache.increment('hits', 1_000)).toBe(1);
      expect(await cache.increment('hits', 1_000)).toBe(2);
      expect(await cache.increment('hits', 1_000)).toBe(3);
    });

    it('restarts after the window elapses', async () => {
      vi.useFakeTimers();
      try {
        const cache = new MemoryCache();
        expect(await cache.increment('hits', 1_000)).toBe(1);
        vi.advanceTimersByTime(1_001);
        expect(await cache.increment('hits', 1_000)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('bounded growth', () => {
    it('never exceeds the configured entry cap', async () => {
      // Without a cap, an attacker rotating source IPs could grow the map until
      // the process runs out of memory.
      const cache = new MemoryCache(50);
      for (let index = 0; index < 500; index += 1) {
        await cache.set(`key-${index}`, index, 60_000);
      }

      let present = 0;
      for (let index = 0; index < 500; index += 1) {
        if ((await cache.get(`key-${index}`)) !== null) present += 1;
      }

      expect(present).toBeLessThanOrEqual(50);
      expect(present).toBeGreaterThan(0);
    });

    it('drops expired entries before evicting live ones', async () => {
      vi.useFakeTimers();
      try {
        const cache = new MemoryCache(10);

        await cache.set('short-lived', 'x', 100);
        vi.advanceTimersByTime(200);

        for (let index = 0; index < 10; index += 1) {
          await cache.set(`live-${index}`, index, 60_000);
        }

        expect(await cache.get('short-lived')).toBeNull();
        expect(await cache.get('live-0')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reports its backend so callers can log which implementation is active', () => {
    expect(new MemoryCache().backend).toBe('memory');
  });
});
