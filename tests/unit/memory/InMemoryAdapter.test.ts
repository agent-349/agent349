import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { StorageAdapter } from '../../../src/memory/adapters/StorageAdapter.js';

let adapter: InMemoryAdapter;

beforeEach(() => {
  adapter = new InMemoryAdapter();
});

afterEach(() => {
  adapter.clear();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('extends StorageAdapter', () => {
    expect(adapter).toBeInstanceOf(StorageAdapter);
  });

  it('name is "memory"', () => {
    expect(adapter.name).toBe('memory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get / set / exists / delete — basic operations (no TTL)
// ─────────────────────────────────────────────────────────────────────────────

describe('get / set / exists / delete', () => {
  it('get returns null for a missing key', async () => {
    expect(await adapter.get('missing')).toBeNull();
  });

  it('set + get round-trips a primitive value', async () => {
    await adapter.set('k', 42);
    expect(await adapter.get('k')).toBe(42);
  });

  it('set + get round-trips a string', async () => {
    await adapter.set('k', 'hello');
    expect(await adapter.get('k')).toBe('hello');
  });

  it('set + get round-trips an object', async () => {
    const obj = { a: 1, b: [2, 3] };
    await adapter.set('k', obj);
    expect(await adapter.get('k')).toEqual(obj);
  });

  it('set + get round-trips null as a stored value', async () => {
    await adapter.set('k', null);
    // null is a valid stored value, distinct from "key not found"
    expect(await adapter.get('k')).toBeNull();
    expect(await adapter.exists('k')).toBe(true);
  });

  it('overwriting a key replaces the value', async () => {
    await adapter.set('k', 'first');
    await adapter.set('k', 'second');
    expect(await adapter.get('k')).toBe('second');
  });

  it('exists returns true for a present key', async () => {
    await adapter.set('k', 'v');
    expect(await adapter.exists('k')).toBe(true);
  });

  it('exists returns false for a missing key', async () => {
    expect(await adapter.exists('missing')).toBe(false);
  });

  it('delete removes the key', async () => {
    await adapter.set('k', 'v');
    await adapter.delete('k');
    expect(await adapter.get('k')).toBeNull();
    expect(await adapter.exists('k')).toBe(false);
  });

  it('delete on a missing key is a no-op', async () => {
    await expect(adapter.delete('nope')).resolves.toBeUndefined();
  });

  it('multiple keys are stored and retrieved independently', async () => {
    await adapter.set('a', 1);
    await adapter.set('b', 2);
    await adapter.set('c', 3);

    expect(await adapter.get('a')).toBe(1);
    expect(await adapter.get('b')).toBe(2);
    expect(await adapter.get('c')).toBe(3);
  });

  it('deleting one key does not affect others', async () => {
    await adapter.set('a', 1);
    await adapter.set('b', 2);
    await adapter.delete('a');

    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.get('b')).toBe(2);
  });

  it('size reflects the number of stored entries', async () => {
    expect(adapter.size).toBe(0);
    await adapter.set('x', 1);
    await adapter.set('y', 2);
    expect(adapter.size).toBe(2);
    await adapter.delete('x');
    expect(adapter.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TTL — time-based expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('key is accessible before the TTL expires', async () => {
    await adapter.set('k', 'alive', 10); // 10 s TTL
    vi.advanceTimersByTime(9_999); // just before expiry

    expect(await adapter.get('k')).toBe('alive');
    expect(await adapter.exists('k')).toBe(true);
  });

  it('key is gone after the TTL expires', async () => {
    await adapter.set('k', 'alive', 10);
    vi.advanceTimersByTime(10_000); // exactly at expiry

    expect(await adapter.get('k')).toBeNull();
    expect(await adapter.exists('k')).toBe(false);
  });

  it('key is gone well after the TTL expires', async () => {
    await adapter.set('k', 'alive', 1); // 1 s TTL
    vi.advanceTimersByTime(60_000);

    expect(await adapter.get('k')).toBeNull();
  });

  it('overwriting a key resets the TTL', async () => {
    await adapter.set('k', 'v1', 5);
    vi.advanceTimersByTime(4_000); // 4 s in — still alive

    await adapter.set('k', 'v2', 5); // reset with a fresh 5 s TTL
    vi.advanceTimersByTime(4_000); // 4 s after reset — still alive

    expect(await adapter.get('k')).toBe('v2');
    expect(await adapter.exists('k')).toBe(true);
  });

  it('old TTL timer does not fire after a key is overwritten', async () => {
    await adapter.set('k', 'old', 2); // expires in 2 s
    vi.advanceTimersByTime(1_000); // 1 s in

    await adapter.set('k', 'new', 60); // replace with 60 s TTL
    vi.advanceTimersByTime(2_000); // original timer would have fired here

    // Key must still be present — the old timer was cancelled
    expect(await adapter.get('k')).toBe('new');
  });

  it('deleting a key before its TTL fires cancels the timer', async () => {
    await adapter.set('k', 'v', 5);
    await adapter.delete('k');
    vi.advanceTimersByTime(10_000); // timer would have fired

    // Key was deleted — still absent, no double-delete side effects
    expect(await adapter.get('k')).toBeNull();
    expect(adapter.size).toBe(0);
  });

  it('setting a key without TTL after one with TTL removes the timer', async () => {
    await adapter.set('k', 'v1', 5); // has a timer
    await adapter.set('k', 'v2'); // no TTL — timer should be cancelled

    vi.advanceTimersByTime(10_000); // old timer would have fired

    expect(await adapter.get('k')).toBe('v2');
  });

  it('independent keys have independent TTLs', async () => {
    await adapter.set('short', 'a', 1);
    await adapter.set('long', 'b', 100);

    vi.advanceTimersByTime(1_000); // 'short' expires, 'long' survives

    expect(await adapter.get('short')).toBeNull();
    expect(await adapter.get('long')).toBe('b');
  });

  it('size decrements automatically when TTL expires', async () => {
    await adapter.set('k', 'v', 1);
    expect(adapter.size).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(adapter.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clear()
// ─────────────────────────────────────────────────────────────────────────────

describe('clear()', () => {
  it('removes all stored entries', async () => {
    await adapter.set('a', 1);
    await adapter.set('b', 2);
    adapter.clear();

    expect(adapter.size).toBe(0);
    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.get('b')).toBeNull();
  });

  it('cancels pending TTL timers so they do not fire after clear', async () => {
    vi.useFakeTimers();

    await adapter.set('k', 'v', 5);
    adapter.clear(); // must cancel the timer
    vi.advanceTimersByTime(10_000); // timer would have fired

    // No side effects from the cancelled timer
    expect(adapter.size).toBe(0);
  });

  it('adapter is reusable after clear', async () => {
    await adapter.set('old', 'gone');
    adapter.clear();

    await adapter.set('new', 'here');
    expect(await adapter.get('new')).toBe('here');
    expect(adapter.size).toBe(1);
  });
});
