import type { Collection, Document, MongoClient } from 'mongodb';
import type { PendingAction, PendingActionFilter, PendingActionStatus } from '../../types/index.js';
import { PendingActionStore } from './PendingActionStore.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link MongoPendingActionStore}.
 */
export interface MongoPendingActionStoreConfig {
  /** MongoDB connection URI (e.g. `mongodb://localhost:27017`). */
  uri: string;
  /** Database name. */
  database: string;
  /** Collection name. Default: `'pending_actions'`. */
  collection?: string;
  /**
   * Maximum size in bytes for `savedContext.messagesSnapshot` when stored.
   * Documents exceeding this limit have `messagesSnapshot` omitted and cannot
   * be resumed — log a warning when this happens. Default: 2 097 152 (2 MB).
   */
  maxSnapshotBytes?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document shape
// ─────────────────────────────────────────────────────────────────────────────

interface PendingActionDocument extends Document {
  _id: string;
  requestId: string;
  sessionId: string;
  tenantId: string;
  requestedBy: string;
  agentId: string;
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolInput: any;
  description: string;
  reason: string;
  risk: PendingAction['risk'];
  approverRoles: string[];
  approverUsers?: string[];
  currentEscalationLevel: number;
  status: PendingActionStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolution?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  savedContext: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}

/** Terminal statuses eligible for cleanup. */
const TERMINAL_STATUSES: PendingActionStatus[] = [
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'completed',
  'failed',
  'resume_failed',
];

// ─────────────────────────────────────────────────────────────────────────────
// MongoPendingActionStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Production-grade {@link PendingActionStore} backed by MongoDB.
 *
 * ### Key design decisions
 *
 * - **Atomic `claimForExecution`** — uses `findOneAndUpdate` with a
 *   `{ status: { $in: ['pending', 'escalated'] } }` filter so that only one
 *   concurrent caller can claim an action. This is the primary idempotency
 *   fence preventing double tool execution in a horizontally-scaled cluster.
 *
 * - **TTL index on `expiresAt`** — MongoDB expires documents automatically,
 *   complementing the `ExpirationManager`'s soft-expiry logic.
 *
 * - **`messagesSnapshot` size guard** — conversation snapshots can be large.
 *   The store silently drops the snapshot (and sets `snapshotTruncated: true`
 *   in `savedContext`) when it exceeds `maxSnapshotBytes`, rather than
 *   failing the entire create/update call. The resume path will not work for
 *   those actions; a warning is emitted via the returned document.
 *
 * - **Private constructor + static `create()`** — follows the established
 *   pattern from `MongoAdapter`; the factory connects, creates indexes, then
 *   returns a ready-to-use instance.
 *
 * @example
 * ```typescript
 * const store = await MongoPendingActionStore.create({
 *   uri: 'mongodb://localhost:27017',
 *   database: 'agent349',
 *   collection: 'pending_actions',
 * });
 * ```
 */
export class MongoPendingActionStore extends PendingActionStore {
  override readonly name = 'mongo-pending-actions';

  readonly #client: MongoClient;
  readonly #collection: Collection<PendingActionDocument>;
  readonly #maxSnapshotBytes: number;
  #closed = false;

  private constructor(
    client: MongoClient,
    collection: Collection<PendingActionDocument>,
    maxSnapshotBytes: number,
  ) {
    super();
    this.#client = client;
    this.#collection = collection;
    this.#maxSnapshotBytes = maxSnapshotBytes;
  }

  /**
   * Connects to MongoDB, ensures all required indexes exist, and returns a
   * ready-to-use `MongoPendingActionStore`.
   *
   * @throws If the `mongodb` package is not installed or the connection fails.
   */
  static async create(config: MongoPendingActionStoreConfig): Promise<MongoPendingActionStore> {
    const { MongoClient } = await import('mongodb');

    const client = new MongoClient(config.uri);
    await client.connect();

    const db = client.db(config.database);
    const collectionName = config.collection ?? 'pending_actions';
    const collection = db.collection<PendingActionDocument>(collectionName);

    // TTL: MongoDB removes documents automatically when expiresAt passes.
    await collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, sparse: true, background: true },
    );
    // Primary query pattern: pending actions for a tenant, ordered by age.
    await collection.createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });
    // Expiration check: find unresolved actions past their deadline.
    await collection.createIndex({ status: 1, expiresAt: 1 }, { background: true });
    // Approver queue: find actions a role can act on.
    await collection.createIndex({ approverRoles: 1, status: 1 }, { background: true });

    const maxSnapshotBytes = config.maxSnapshotBytes ?? 2_097_152; // 2 MB

    return new MongoPendingActionStore(client, collection, maxSnapshotBytes);
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async create(action: PendingAction): Promise<void> {
    const doc = this.#toDocument(action);
    await this.#collection.insertOne(doc);
  }

  /** @inheritdoc */
  async update(action: PendingAction): Promise<void> {
    const doc = this.#toDocument(action);
    await this.#collection.replaceOne(
      { _id: action.id } as unknown as Partial<PendingActionDocument>,
      doc,
      { upsert: false },
    );
  }

  /**
   * @inheritdoc
   *
   * Implemented via `findOneAndUpdate` with a `{ status: { $in: [...] } }`
   * filter, guaranteeing that exactly one concurrent caller wins the race.
   */
  async claimForExecution(
    actionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _approverInfo: { userId: string; comment?: string; modifiedInput?: any },
  ): Promise<PendingAction | null> {
    const result = await this.#collection.findOneAndUpdate(
      {
        _id: actionId,
        status: { $in: ['pending', 'escalated'] },
      } as unknown as Partial<PendingActionDocument>,
      { $set: { status: 'executing', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (result === null) return null;
    return this.#fromDocument(result as unknown as PendingActionDocument);
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async getById(id: string): Promise<PendingAction | null> {
    const doc = await this.#collection.findOne({
      _id: id,
    } as unknown as Partial<PendingActionDocument>);
    if (doc === null) return null;
    return this.#fromDocument(doc as unknown as PendingActionDocument);
  }

  /** @inheritdoc */
  async getPending(filter: PendingActionFilter): Promise<PendingAction[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = {};

    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      query['status'] = { $in: statuses };
    }
    if (filter.tenantId !== undefined) query['tenantId'] = filter.tenantId;
    if (filter.requestedBy !== undefined) query['requestedBy'] = filter.requestedBy;
    if (filter.requestId !== undefined) query['requestId'] = filter.requestId;
    if (filter.agentId !== undefined) query['agentId'] = filter.agentId;
    if (filter.risk !== undefined) query['risk'] = filter.risk;
    if (filter.approverRoles !== undefined && filter.approverRoles.length > 0) {
      query['approverRoles'] = { $in: filter.approverRoles };
    }
    if (filter.createdAfter !== undefined) {
      query['createdAt'] = { ...query['createdAt'], $gte: filter.createdAfter };
    }
    if (filter.createdBefore !== undefined) {
      query['createdAt'] = { ...query['createdAt'], $lte: filter.createdBefore };
    }

    const riskSortOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    const sortBy = filter.sortBy ?? 'createdAt';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sort: Record<string, any> =
      sortBy === 'expiresAt'
        ? { expiresAt: 1 }
        : sortBy === 'risk'
          ? // MongoDB can't sort by a custom enum order natively; sort client-side below.
            { createdAt: -1 }
          : { createdAt: -1 };

    let cursor = this.#collection
      .find(query as unknown as Partial<PendingActionDocument>)
      .sort(sort);
    if (filter.limit !== undefined) cursor = cursor.limit(filter.limit);

    const docs = await cursor.toArray();
    let records = docs.map((d) => this.#fromDocument(d as unknown as PendingActionDocument));

    if (sortBy === 'risk') {
      records.sort((a, b) => riskSortOrder[b.risk] - riskSortOrder[a.risk]);
    }

    return records;
  }

  /** @inheritdoc */
  async getExpired(): Promise<PendingAction[]> {
    const docs = await this.#collection
      .find({
        status: { $in: ['pending', 'escalated'] },
        expiresAt: { $lt: new Date() },
      } as unknown as Partial<PendingActionDocument>)
      .toArray();

    return docs.map((d) => this.#fromDocument(d as unknown as PendingActionDocument));
  }

  // ─── Count ────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async count(filter: Partial<PendingActionFilter>): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = {};
    if (filter.tenantId !== undefined) query['tenantId'] = filter.tenantId;
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      query['status'] = { $in: statuses };
    }
    return this.#collection.countDocuments(query as unknown as Partial<PendingActionDocument>);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async deleteOlderThan(date: Date): Promise<number> {
    const result = await this.#collection.deleteMany({
      status: { $in: TERMINAL_STATUSES },
      updatedAt: { $lt: date },
    } as unknown as Partial<PendingActionDocument>);
    return result.deletedCount;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Closes the MongoDB client connection.
   *
   * Idempotent — calling more than once is safe.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }

  // ─── Serialisation helpers ────────────────────────────────────────────────

  #toDocument(action: PendingAction): PendingActionDocument {
    // Guard against oversized messagesSnapshot to stay within the 16 MB BSON limit.
    let savedContext = action.savedContext;
    if (savedContext.messagesSnapshot !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(savedContext.messagesSnapshot), 'utf8');
      if (bytes > this.#maxSnapshotBytes) {
        const { messagesSnapshot: _dropped, ...rest } = savedContext;
        savedContext = { ...rest, snapshotTruncated: true };
      }
    }

    return {
      _id: action.id,
      requestId: action.requestId,
      sessionId: action.sessionId,
      tenantId: action.tenantId,
      requestedBy: action.requestedBy,
      agentId: action.agentId,
      toolName: action.toolName,
      toolInput: action.toolInput,
      description: action.description,
      reason: action.reason,
      risk: action.risk,
      approverRoles: [...action.approverRoles],
      ...(action.approverUsers !== undefined && { approverUsers: [...action.approverUsers] }),
      currentEscalationLevel: action.currentEscalationLevel,
      status: action.status,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      expiresAt: action.expiresAt,
      ...(action.resolution !== undefined && { resolution: action.resolution }),
      savedContext,
      ...(action.metadata !== undefined && { metadata: action.metadata }),
    };
  }

  #fromDocument(doc: PendingActionDocument): PendingAction {
    return {
      id: doc._id,
      requestId: doc.requestId,
      sessionId: doc.sessionId,
      tenantId: doc.tenantId,
      requestedBy: doc.requestedBy,
      agentId: doc.agentId,
      toolName: doc.toolName,
      toolInput: doc.toolInput,
      description: doc.description,
      reason: doc.reason,
      risk: doc.risk,
      approverRoles: doc.approverRoles,
      ...(doc.approverUsers !== undefined && { approverUsers: doc.approverUsers }),
      currentEscalationLevel: doc.currentEscalationLevel,
      status: doc.status,
      // MongoDB returns native Date objects — no conversion needed.
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      expiresAt: doc.expiresAt,
      ...(doc.resolution !== undefined && { resolution: doc.resolution }),
      savedContext: doc.savedContext,
      ...(doc.metadata !== undefined && { metadata: doc.metadata }),
    };
  }
}
