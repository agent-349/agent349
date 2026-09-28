import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/security/RateLimiter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RateLimiter', () => {
  // ── check() — basic allow / deny ──────────────────────────────────────────

  describe('check() — basic', () => {
    it('allows the first request within the limit', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 5, perHour: 100, perDay: 1000 } });
      const result = await rl.check('tenant:t1', 'minute');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 1
      expect(result.limit).toBe(5);
    });

    it('blocks when limit is exhausted', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 2, perHour: 100, perDay: 1000 } });
      await rl.check('tenant:t1', 'minute');
      await rl.check('tenant:t1', 'minute');
      const result = await rl.check('tenant:t1', 'minute'); // 3rd → over limit
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('does not consume a slot when blocking', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 1, perHour: 100, perDay: 1000 } });
      await rl.check('tenant:t1', 'minute'); // slot consumed
      await rl.check('tenant:t1', 'minute'); // blocked
      await rl.check('tenant:t1', 'minute'); // still blocked, not consuming
      const result = await rl.check('tenant:t1', 'minute');
      expect(result.allowed).toBe(false);
    });

    it('tracks different keys independently', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 1, perHour: 100, perDay: 1000 } });
      await rl.check('tenant:t1', 'minute'); // t1 exhausted
      const result = await rl.check('tenant:t2', 'minute'); // t2 fresh
      expect(result.allowed).toBe(true);
    });

    it('tracks minute and hour windows independently for the same key', async () => {
      const rl = new RateLimiter({
        perTenant: { perMinute: 1, perHour: 100, perDay: 1000 },
      });
      await rl.check('tenant:t1', 'minute');
      const hourResult = await rl.check('tenant:t1', 'hour');
      expect(hourResult.allowed).toBe(true); // hour window is separate
    });

    it('returns a resetAt Date in the future', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 10, perHour: 100, perDay: 1000 } });
      const before = Date.now();
      const result = await rl.check('tenant:t1', 'minute');
      expect(result.resetAt).toBeInstanceOf(Date);
      expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 5);
    });
  });

  // ── check() — tenant vs user limit resolution ──────────────────────────────

  describe('check() — limit resolution by key prefix', () => {
    it('uses perTenant limits for "tenant:" prefix keys', async () => {
      const rl = new RateLimiter({
        perTenant: { perMinute: 3, perHour: 100, perDay: 1000 },
        perUser: { perMinute: 1, perHour: 100, perDay: 1000 },
      });
      await rl.check('tenant:t1', 'minute');
      await rl.check('tenant:t1', 'minute');
      const r = await rl.check('tenant:t1', 'minute');
      expect(r.allowed).toBe(true); // tenant limit is 3, user would have been 1
    });

    it('uses perUser limits for "user:" prefix keys', async () => {
      const rl = new RateLimiter({
        perTenant: { perMinute: 100, perHour: 1000, perDay: 10000 },
        perUser: { perMinute: 2, perHour: 100, perDay: 1000 },
      });
      await rl.check('user:t1:u1', 'minute');
      await rl.check('user:t1:u1', 'minute');
      const r = await rl.check('user:t1:u1', 'minute');
      expect(r.allowed).toBe(false); // user limit is 2
    });

    it('uses perUser limits for keys without "tenant:" prefix', async () => {
      const rl = new RateLimiter({
        perUser: { perMinute: 1, perHour: 100, perDay: 1000 },
      });
      await rl.check('custom:key', 'minute');
      const r = await rl.check('custom:key', 'minute');
      expect(r.allowed).toBe(false);
    });
  });

  // ── check() — window expiry ────────────────────────────────────────────────

  describe('check() — window expiry', () => {
    it('resets count after window expires', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 1, perHour: 100, perDay: 1000 } });

      // Use fake timers to simulate window expiry
      const start = Date.now();
      vi.spyOn(Date, 'now').mockReturnValueOnce(start); // first check
      await rl.check('tenant:t1', 'minute'); // consume

      // Advance past 1 minute
      vi.spyOn(Date, 'now').mockReturnValue(start + 61_000);
      const result = await rl.check('tenant:t1', 'minute'); // new window
      expect(result.allowed).toBe(true);
    });
  });

  // ── peek() ────────────────────────────────────────────────────────────────

  describe('peek()', () => {
    it('returns full remaining without consuming a slot', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 5, perHour: 100, perDay: 1000 } });
      const p1 = await rl.peek('tenant:t1', 'minute');
      const p2 = await rl.peek('tenant:t1', 'minute');
      expect(p1.allowed).toBe(true);
      expect(p1.remaining).toBe(5);
      expect(p2.remaining).toBe(5); // unchanged
    });

    it('returns remaining = 0 and allowed = false when limit is exhausted', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 1, perHour: 100, perDay: 1000 } });
      await rl.check('tenant:t1', 'minute'); // consume the only slot
      const result = await rl.peek('tenant:t1', 'minute');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('peek then check: check still consumes', async () => {
      const rl = new RateLimiter({ perTenant: { perMinute: 2, perHour: 100, perDay: 1000 } });
      await rl.peek('tenant:t1', 'minute');
      await rl.check('tenant:t1', 'minute');
      const r = await rl.peek('tenant:t1', 'minute');
      expect(r.remaining).toBe(1);
    });
  });

  // ── default config ─────────────────────────────────────────────────────────

  describe('default config', () => {
    it('uses perTenant.perMinute=100 by default', async () => {
      const rl = new RateLimiter();
      const result = await rl.check('tenant:t1', 'minute');
      expect(result.limit).toBe(100);
    });

    it('uses perUser.perMinute=20 by default', async () => {
      const rl = new RateLimiter();
      const result = await rl.check('user:t1:u1', 'minute');
      expect(result.limit).toBe(20);
    });
  });
});
