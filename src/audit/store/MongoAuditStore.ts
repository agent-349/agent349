import type { Collection, Document, MongoClient, WriteConcern } from 'mongodb';
import type {
  AuditRecord,
  AuditQuery,
  AuditQueryResult,
  AggregateResult,
  AuditAggregateDimension,
  AuditCategory,
} from '../../types/index.js';
import { AuditStoreAdapter } from './AuditStoreAdapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link MongoAuditStore}.
 */
export interface MongoAuditStoreConfig {
  /** MongoDB connection URI (e.g. `mongodb://localhost:27017`). */
  uri: string;
  /** Database name. */
  database: string;
  /** Collection name. Default: `'audit_records'`. */
  collection?: string;
  /**
   * Number of days after which records expire automatically via a TTL index on
   * `timestamp`. Omit to disable automatic expiry (records are then only removed
   * by {@link MongoAuditStore.deleteOlderThan} / the retention policy).
   */
  retentionDays?: number;
  /**
   * Write concern for inserts. `'majority'` (default) trades a little latency
   * for durability — appropriate for compliance-grade audit data. Use a number
   * for an explicit `w` value.
   */
  writeConcern?: 'majority' | number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document shape
// ─────────────────────────────────────────────────────────────────────────────

interface AuditRecordDocument extends Document {
  _id: string;
  timestamp: Date;
  requestId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  category: AuditCategory;
  action: string;
  outcome: AuditRecord['outcome'];
  severity: AuditRecord['severity'];
  detail?: AuditRecord['detail'];
  resource?: AuditRecord['resource'];
  metrics?: AuditRecord['metrics'];
  security?: AuditRecord['security'];
  _integrityHash?: string;
}

/** Maps an {@link AuditAggregateDimension} to its document field for `$group`. */
const GROUP_FIELD: Record<Exclude<AuditAggregateDimension, 'hour' | 'day'>, string> = {
  category: '$category',
  action: '$action',
  outcome: '$outcome',
  severity: '$severity',
  user: '$userId',
  agent: '$agentId',
};

// ─────────────────────────────────────────────────────────────────────────────
// MongoAuditStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Production-grade {@link AuditStoreAdapter} backed by MongoDB.
 *
 * ### Key design decisions
 *
 * - **Append-only.** Only `insertMany`, `find`, aggregation, and `deleteMany`
 *   (retention) are used. Records are never updated, honouring the immutability
 *   contract of {@link AuditStoreAdapter}. Deploy with a DB user that lacks the
 *   `update` privilege for defence in depth.
 *
 * - **`{ ordered: false }` batch writes.** A single malformed record does not
 *   abort the whole batch; the rest still persist.
 *
 * - **`writeConcern: 'majority'`** by default — audit data is compliance-grade,
 *   so durability is preferred over a few milliseconds of latency.
 *
 * - **Optional TTL index.** When `retentionDays` is set, MongoDB expires
 *   documents automatically, complementing the explicit
 *   {@link AuditLogger.applyRetention} barrier.
 *
 * - **Private constructor + static {@link create}** — mirrors `MongoAdapter`
 *   and `MongoPendingActionStore`: the factory connects, ensures indexes, then
 *   returns a ready-to-use instance.
 *
 * @example
 * ```typescript
 * const store = await MongoAuditStore.create({
 *   uri: 'mongodb://localhost:27017',
 *   database: 'agent349',
 *   collection: 'audit_records',
 *   retentionDays: 365,
 * });
 * ```
 */
export class MongoAuditStore extends AuditStoreAdapter {
  override readonly name = 'mongo-audit';

  readonly #client: MongoClient;
  readonly #collection: Collection<AuditRecordDocument>;
  #closed = false;

  private constructor(client: MongoClient, collection: Collection<AuditRecordDocument>) {
    super();
    this.#client = client;
    this.#collection = collection;
  }

  /**
   * Connects to MongoDB, ensures all required indexes exist, and returns a
   * ready-to-use `MongoAuditStore`.
   *
   * @throws If the `mongodb` package is not installed or the connection fails.
   */
  static async create(config: MongoAuditStoreConfig): Promise<MongoAuditStore> {
    const { MongoClient } = await import('mongodb');

    const writeConcern: WriteConcern =
      config.writeConcern === undefined || config.writeConcern === 'majority'
        ? { w: 'majority' }
        : { w: config.writeConcern };

    const client = new MongoClient(config.uri, { writeConcern });
    await client.connect();

    const db = client.db(config.database);
    const collectionName = config.collection ?? 'audit_records';
    const collection = db.collection<AuditRecordDocument>(collectionName);

    // Primary query pattern: a tenant's timeline by recency.
    await collection.createIndex({ tenantId: 1, timestamp: -1 }, { background: true });
    // Correlation: all records for one request, chronological.
    await collection.createIndex({ requestId: 1, timestamp: 1 }, { background: true });
    // Session timeline.
    await collection.createIndex({ sessionId: 1, timestamp: 1 }, { background: true });
    // Common compliance filters.
    await collection.createIndex({ tenantId: 1, category: 1, timestamp: -1 }, { background: true });
    await collection.createIndex({ tenantId: 1, severity: 1, timestamp: -1 }, { background: true });
    await collection.createIndex({ tenantId: 1, userId: 1, timestamp: -1 }, { background: true });

    // Automatic expiry (optional).
    if (config.retentionDays !== undefined && config.retentionDays > 0) {
      await collection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: config.retentionDays * 86_400, background: true },
      );
    }

    return new MongoAuditStore(client, collection);
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async writeBatch(records: AuditRecord[]): Promise<void> {
    if (records.length === 0) return;
    const docs = records.map((r) => this.#toDocument(r));
    await this.#collection.insertMany(docs, { ordered: false });
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async getById(id: string): Promise<AuditRecord | null> {
    const doc = await this.#collection.findOne({
      _id: id,
    } as unknown as Partial<AuditRecordDocument>);
    return doc === null ? null : this.#fromDocument(doc as unknown as AuditRecordDocument);
  }

  /** @inheritdoc */
  async getByRequestId(requestId: string): Promise<AuditRecord[]> {
    const docs = await this.#collection
      .find({ requestId } as unknown as Partial<AuditRecordDocument>)
      .sort({ timestamp: 1 })
      .toArray();
    return docs.map((d) => this.#fromDocument(d as unknown as AuditRecordDocument));
  }

  /** @inheritdoc */
  async query(q: AuditQuery): Promise<AuditQueryResult> {
    const filter = this.#buildFilter(q);

    const total = await this.#collection.countDocuments(
      filter as unknown as Partial<AuditRecordDocument>,
    );

    const sortBy = q.sortBy ?? 'timestamp';
    const dir: 1 | -1 = (q.sortOrder ?? 'desc') === 'asc' ? 1 : -1;
    const sort: Record<string, 1 | -1> =
      sortBy === 'severity' ? { severity: dir, timestamp: -1 } : { timestamp: dir };

    const limit = Math.min(q.limit ?? 50, 1000);
    const offset = q.offset ?? 0;

    const docs = await this.#collection
      .find(filter as unknown as Partial<AuditRecordDocument>)
      .sort(sort)
      .skip(offset)
      .limit(limit)
      .toArray();

    return {
      records: docs.map((d) => this.#fromDocument(d as unknown as AuditRecordDocument)),
      total,
      hasMore: offset + limit < total,
      query: q,
    };
  }

  // ─── Count ────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async count(q: Partial<AuditQuery>): Promise<number> {
    const filter = this.#buildFilter(q);
    return this.#collection.countDocuments(filter as unknown as Partial<AuditRecordDocument>);
  }

  // ─── Aggregate ──────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async aggregate(
    tenantId: string,
    dateRange: { from: Date; to: Date },
    groupBy: AuditAggregateDimension,
  ): Promise<AggregateResult[]> {
    let groupId: string | Record<string, unknown>;
    if (groupBy === 'hour') {
      groupId = {
        $dateToString: { format: '%Y-%m-%dT%H', date: '$timestamp', timezone: 'UTC' },
      };
    } else if (groupBy === 'day') {
      groupId = {
        $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' },
      };
    } else {
      groupId = GROUP_FIELD[groupBy];
    }

    const pipeline = [
      {
        $match: {
          tenantId,
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        },
      },
      {
        $group: {
          _id: groupId,
          count: { $sum: 1 },
          totalDuration: { $sum: { $ifNull: ['$metrics.durationMs', 0] } },
          durationCount: {
            $sum: { $cond: [{ $ifNull: ['$metrics.durationMs', false] }, 1, 0] },
          },
          totalTokensInput: { $sum: { $ifNull: ['$metrics.tokensInput', 0] } },
          totalTokensOutput: { $sum: { $ifNull: ['$metrics.tokensOutput', 0] } },
          totalCost: { $sum: { $ifNull: ['$metrics.estimatedCostUsd', 0] } },
        },
      },
      { $sort: { count: -1 } },
    ];

    const rows = await this.#collection.aggregate(pipeline).toArray();

    return rows.map((row) => {
      const r = row as {
        _id: string | null;
        count: number;
        totalDuration: number;
        durationCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalCost: number;
      };
      const totalTokens = r.totalTokensInput + r.totalTokensOutput;
      const result: AggregateResult = { key: r._id ?? '', count: r.count };
      if (r.durationCount > 0) result.avgDurationMs = r.totalDuration / r.durationCount;
      if (totalTokens > 0) result.totalTokens = totalTokens;
      if (r.totalTokensInput > 0) result.totalTokensInput = r.totalTokensInput;
      if (r.totalTokensOutput > 0) result.totalTokensOutput = r.totalTokensOutput;
      if (r.totalCost > 0) result.totalCostUsd = r.totalCost;
      return result;
    });
  }

  // ─── Retention ──────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async deleteOlderThan(date: Date, tenantId?: string): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = { timestamp: { $lt: date } };
    if (tenantId !== undefined) filter['tenantId'] = tenantId;
    const result = await this.#collection.deleteMany(
      filter as unknown as Partial<AuditRecordDocument>,
    );
    return result.deletedCount;
  }

  // ─── Health ───────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async healthCheck(): Promise<boolean> {
    try {
      await this.#client.db().command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Closes the MongoDB client connection. Idempotent.
   */
  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }

  // ─── Filter builder ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #buildFilter(q: Partial<AuditQuery>): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {};

    if (q.tenantId !== undefined) filter['tenantId'] = q.tenantId;
    if (q.userId !== undefined) filter['userId'] = q.userId;
    if (q.agentId !== undefined) filter['agentId'] = q.agentId;
    if (q.sessionId !== undefined) filter['sessionId'] = q.sessionId;
    if (q.requestId !== undefined) filter['requestId'] = q.requestId;

    if (q.category !== undefined) {
      filter['category'] = Array.isArray(q.category) ? { $in: q.category } : q.category;
    }
    if (q.action !== undefined) filter['action'] = q.action;
    if (q.outcome !== undefined) {
      filter['outcome'] = Array.isArray(q.outcome) ? { $in: q.outcome } : q.outcome;
    }
    if (q.severity !== undefined) {
      filter['severity'] = Array.isArray(q.severity) ? { $in: q.severity } : q.severity;
    }

    if (q.dateRange !== undefined) {
      filter['timestamp'] = { $gte: q.dateRange.from, $lte: q.dateRange.to };
    }

    if (q.resourceType !== undefined) filter['resource.type'] = q.resourceType;
    if (q.resourceId !== undefined) filter['resource.id'] = q.resourceId;

    if (q.searchText !== undefined) {
      const safe = q.searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      filter['$or'] = [{ 'detail.summary': rx }, { 'detail.error': rx }, { action: rx }];
    }

    return filter;
  }

  // ─── Serialisation helpers ────────────────────────────────────────────────

  #toDocument(record: AuditRecord): AuditRecordDocument {
    return {
      _id: record.id,
      timestamp: record.timestamp,
      requestId: record.requestId,
      sessionId: record.sessionId,
      tenantId: record.tenantId,
      userId: record.userId,
      agentId: record.agentId,
      category: record.category,
      action: record.action,
      outcome: record.outcome,
      severity: record.severity,
      ...(record.detail !== undefined && { detail: record.detail }),
      ...(record.resource !== undefined && { resource: record.resource }),
      ...(record.metrics !== undefined && { metrics: record.metrics }),
      ...(record.security !== undefined && { security: record.security }),
      ...(record._integrityHash !== undefined && { _integrityHash: record._integrityHash }),
    };
  }

  #fromDocument(doc: AuditRecordDocument): AuditRecord {
    return {
      id: doc._id,
      // MongoDB returns native Date objects — no conversion needed.
      timestamp: doc.timestamp,
      requestId: doc.requestId,
      sessionId: doc.sessionId,
      tenantId: doc.tenantId,
      userId: doc.userId,
      agentId: doc.agentId,
      category: doc.category,
      action: doc.action,
      outcome: doc.outcome,
      severity: doc.severity,
      ...(doc.detail !== undefined && { detail: doc.detail }),
      ...(doc.resource !== undefined && { resource: doc.resource }),
      ...(doc.metrics !== undefined && { metrics: doc.metrics }),
      ...(doc.security !== undefined && { security: doc.security }),
      ...(doc._integrityHash !== undefined && { _integrityHash: doc._integrityHash }),
    };
  }
}
