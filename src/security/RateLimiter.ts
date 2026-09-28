import type { RateLimitConfig, RateLimitResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  windowStart: number; // epoch ms when current window began
}

type WindowName = 'minute' | 'hour' | 'day';

// Window durations in milliseconds
const WINDOW_MS: Record<WindowName, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Default config
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RateLimitConfig = {
  perTenant: { perMinute: 100, perHour: 2_000, perDay: 20_000 },
  perUser: { perMinute: 20, perHour: 200, perDay: 2_000 },
};

// ─────────────────────────────────────────────────────────────────────────────
// RateLimiter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed-window in-memory rate limiter for tenant and user request throttling.
 *
 * Tracks request counts per `(key, window)` pair using a fixed-window algorithm:
 * each window starts when the first request in that period arrives, and resets
 * once the window duration has elapsed.
 *
 * ### Key conventions
 *
 * The `key` parameter in {@link check} and {@link peek} encodes the entity and
 * identity so that the limiter can determine which limit thresholds to apply:
 *
 * - `'tenant:<tenantId>'`           → `config.perTenant` limits
 * - `'user:<tenantId>:<userId>'`    → `config.perUser` limits
 *
 * Keys with any other prefix are treated as user-level limits.
 *
 * ### Thread-safety
 *
 * This implementation is single-threaded (Node.js event loop) and requires no
 * locking. For distributed deployments, replace with a Redis-backed adapter.
 */
export class RateLimiter {
  readonly #config: RateLimitConfig;
  // Map key: `${key}::${window}` → WindowEntry
  readonly #store = new Map<string, WindowEntry>();

  /**
   * @param config - Optional rate limit thresholds. Defaults are applied per
   *   missing sub-key: `perTenant.perMinute=100`, `perUser.perMinute=20`, etc.
   */
  constructor(config: Partial<RateLimitConfig> = {}) {
    this.#config = {
      perTenant: { ...DEFAULT_CONFIG.perTenant, ...config.perTenant },
      perUser: { ...DEFAULT_CONFIG.perUser, ...config.perUser },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks whether `key` is within its rate limit for `window`, **consuming**
   * one slot if allowed.
   *
   * - If the current window has expired a new window is started (count reset to 1).
   * - If the key is over its limit the slot is NOT consumed and `allowed` is `false`.
   *
   * @param key    - Rate-limit key (see class docs for key conventions).
   * @param window - Time window to check against.
   * @returns Decision including remaining slots and window reset time.
   */
  async check(key: string, window: WindowName): Promise<RateLimitResult> {
    const limit = this.#getLimit(key, window);
    const storeKey = `${key}::${window}`;
    const now = Date.now();
    const windowMs = WINDOW_MS[window];

    const entry = this.#store.get(storeKey);

    if (entry === undefined || now - entry.windowStart >= windowMs) {
      // New or expired window — start fresh and consume one slot
      const windowStart = now;
      this.#store.set(storeKey, { count: 1, windowStart });
      return {
        allowed: true,
        remaining: limit - 1,
        limit,
        resetAt: new Date(windowStart + windowMs),
      };
    }

    if (entry.count >= limit) {
      // Over limit — do not increment
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt: new Date(entry.windowStart + windowMs),
      };
    }

    // Within limit — consume one slot
    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      limit,
      resetAt: new Date(entry.windowStart + windowMs),
    };
  }

  /**
   * Checks whether `key` is within its rate limit for `window` **without**
   * consuming a slot. Useful for introspection and pre-flight checks.
   *
   * @param key    - Rate-limit key.
   * @param window - Time window to inspect.
   * @returns Current window state without modifying counters.
   */
  async peek(key: string, window: WindowName): Promise<RateLimitResult> {
    const limit = this.#getLimit(key, window);
    const storeKey = `${key}::${window}`;
    const now = Date.now();
    const windowMs = WINDOW_MS[window];

    const entry = this.#store.get(storeKey);

    if (entry === undefined || now - entry.windowStart >= windowMs) {
      // No entry yet or expired — would start fresh
      return {
        allowed: true,
        remaining: limit,
        limit,
        resetAt: new Date(now + windowMs),
      };
    }

    const remaining = Math.max(0, limit - entry.count);
    return {
      allowed: remaining > 0,
      remaining,
      limit,
      resetAt: new Date(entry.windowStart + windowMs),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns the configured limit for `key` and `window`. */
  #getLimit(key: string, window: WindowName): number {
    const limits = key.startsWith('tenant:') ? this.#config.perTenant : this.#config.perUser;
    switch (window) {
      case 'minute':
        return limits.perMinute;
      case 'hour':
        return limits.perHour;
      case 'day':
        return limits.perDay;
    }
  }
}
