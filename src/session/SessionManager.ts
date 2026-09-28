import { randomUUID } from 'node:crypto';
import type { Session } from '../types/index.js';
import type { StorageAdapter } from '../memory/adapters/StorageAdapter.js';
import type { EventBus } from '../events/EventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Storage key for an individual session record. */
function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Storage key for the per-(tenant, user) list of session IDs. */
function userIndexKey(tenantId: string, userId: string): string {
  return `session:index:${tenantId}:${userId}`;
}

/** Storage key for the global list of all session IDs (used by cleanup). */
const ALL_INDEX_KEY = 'session:all';

/**
 * Normalises a raw `Session` object read from storage.
 *
 * JSON-based adapters (Redis, Mongo) serialise `Date` values as ISO strings.
 * This function always reconstructs proper `Date` objects so callers never
 * see strings.
 */
function normalizeSession(raw: unknown): Session {
  const s = raw as Session;
  return {
    ...s,
    createdAt:
      s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt as unknown as string),
    lastActivityAt:
      s.lastActivityAt instanceof Date
        ? s.lastActivityAt
        : new Date(s.lastActivityAt as unknown as string),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of agent sessions across tenants and users.
 *
 * Sessions are stored in a key-value {@link StorageAdapter} using three
 * complementary key spaces:
 *
 * - `session:{sessionId}` — the full {@link Session} record.
 * - `session:index:{tenantId}:{userId}` — ordered list of session IDs for
 *   a specific user, used by {@link listActive}.
 * - `session:all` — global list of all session IDs, used by {@link cleanup}
 *   to iterate without a key-scan capability.
 *
 * @example
 * ```typescript
 * const sessions = new SessionManager(new InMemoryAdapter());
 *
 * const session = await sessions.create('acme', 'user-42', 'agent-finance');
 * const fetched = await sessions.get(session.sessionId);
 * await sessions.close(session.sessionId);
 * ```
 */
export class SessionManager {
  readonly #store: StorageAdapter;
  readonly #bus: EventBus | undefined;

  /**
   * @param store    - Storage backend.
   * @param eventBus - Optional EventBus. When provided, `session.created` and
   *                   `session.closed` events are emitted for the audit/logging
   *                   planes.
   */
  constructor(store: StorageAdapter, eventBus?: EventBus) {
    this.#store = store;
    this.#bus = eventBus;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates and persists a new session with `status = 'active'`.
   *
   * The session is automatically registered in both the per-user index
   * (for {@link listActive}) and the global index (for {@link cleanup}).
   *
   * @param tenantId - Tenant that owns the session.
   * @param userId   - User initiating the session.
   * @param agentId  - Agent that will handle the session.
   * @returns The newly created {@link Session}.
   */
  async create(tenantId: string, userId: string, agentId: string): Promise<Session> {
    const now = new Date();
    const session: Session = {
      sessionId: randomUUID(),
      tenantId,
      userId,
      agentId,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    };

    await this.#store.set(sessionKey(session.sessionId), session);
    await this.#appendToIndex(userIndexKey(tenantId, userId), session.sessionId);
    await this.#appendToIndex(ALL_INDEX_KEY, session.sessionId);

    this.#bus?.emit('session.created', {
      sessionId: session.sessionId,
      _context: { tenantId, userId, agentId, sessionId: session.sessionId },
    });

    return session;
  }

  /**
   * Retrieves a session by its ID.
   *
   * @param sessionId - The session identifier returned by {@link create}.
   * @returns The {@link Session}, or `null` if not found.
   */
  async get(sessionId: string): Promise<Session | null> {
    const raw = await this.#store.get(sessionKey(sessionId));
    if (raw === undefined || raw === null) return null;
    return normalizeSession(raw);
  }

  /**
   * Transitions a session to `status = 'closed'` and updates `lastActivityAt`.
   *
   * If the session does not exist the call is a silent no-op.
   *
   * @param sessionId - The session to close.
   */
  async close(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (session === null) return;

    const updated: Session = {
      ...session,
      status: 'closed',
      lastActivityAt: new Date(),
    };
    await this.#store.set(sessionKey(sessionId), updated);

    this.#bus?.emit('session.closed', {
      sessionId,
      _context: {
        tenantId: session.tenantId,
        userId: session.userId,
        agentId: session.agentId,
        sessionId,
      },
    });
  }

  /**
   * Returns all sessions with `status = 'active'` for the given tenant and user.
   *
   * Sessions from other tenants or users are never returned, even if their IDs
   * happen to be in the index.
   *
   * @param tenantId - Tenant to filter by.
   * @param userId   - User to filter by.
   * @returns Array of active {@link Session} objects (may be empty).
   */
  async listActive(tenantId: string, userId: string): Promise<Session[]> {
    const ids = await this.#readIndex(userIndexKey(tenantId, userId));
    const active: Session[] = [];

    for (const id of ids) {
      const session = await this.get(id);
      if (session !== null && session.status === 'active') {
        active.push(session);
      }
    }

    return active;
  }

  /**
   * Removes all sessions whose `lastActivityAt` is strictly before `olderThan`.
   *
   * Cleaned sessions are deleted from primary storage and from all indexes.
   * After cleanup, {@link get} returns `null` for those sessions and they no
   * longer appear in {@link listActive}.
   *
   * @param olderThan - Cutoff date. Sessions last active before this are removed.
   * @returns The number of sessions that were cleaned up.
   */
  async cleanup(olderThan: Date): Promise<number> {
    const allIds = await this.#readIndex(ALL_INDEX_KEY);
    let count = 0;
    const remaining: string[] = [];

    for (const id of allIds) {
      const session = await this.get(id);

      if (session === null) {
        // Already gone — don't re-add to the global index.
        continue;
      }

      if (session.lastActivityAt < olderThan) {
        await this.#store.delete(sessionKey(id));
        await this.#removeFromIndex(userIndexKey(session.tenantId, session.userId), id);
        count++;
      } else {
        remaining.push(id);
      }
    }

    await this.#store.set(ALL_INDEX_KEY, remaining);
    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async #readIndex(key: string): Promise<string[]> {
    const raw = await this.#store.get(key);
    return Array.isArray(raw) ? (raw as string[]) : [];
  }

  async #appendToIndex(key: string, id: string): Promise<void> {
    const existing = await this.#readIndex(key);
    await this.#store.set(key, [...existing, id]);
  }

  async #removeFromIndex(key: string, id: string): Promise<void> {
    const existing = await this.#readIndex(key);
    await this.#store.set(
      key,
      existing.filter((existing_id) => existing_id !== id),
    );
  }
}
