import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  ExecutionContext,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  MediaBlock,
  TokenUsageRecord,
  TokenUsageSummary,
} from '../types/index.js';
import type { StorageAdapter } from '../memory/adapters/StorageAdapter.js';
import { InMemoryAdapter } from '../memory/adapters/InMemoryAdapter.js';
import { PricingTable } from './PricingTable.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Configurable daily/monthly token limits per tenant and user. */
export interface TokenLimits {
  perTenant: { daily: number; monthly: number };
  perUser: { daily: number; monthly: number };
}

export type TokenLimitMode = 'enforce' | 'observe' | 'disabled';
export type TokenLimitScope = 'tenant' | 'user';
export type TokenLimitWindow = 'daily' | 'monthly';

export interface TokenLimitCheck {
  scope: TokenLimitScope;
  window: TokenLimitWindow;
  used: number;
  projected: number;
  remaining: number;
  limit: number;
  exceeded: boolean;
  resetAt: Date;
}

export interface TokenLimitDecision {
  mode: TokenLimitMode;
  allowed: boolean;
  exceeded: boolean;
  estimatedTokens: number;
  checks: TokenLimitCheck[];
  violation?: TokenLimitCheck;
}

/** Default limits taken from the production defaults (section 15). */
const DEFAULT_LIMITS: TokenLimits = {
  perTenant: { daily: 1_000_000, monthly: 20_000_000 },
  perUser: { daily: 50_000, monthly: 1_000_000 },
};

/**
 * Extended usage data accepted by {@link TokenTracker.record}.
 *
 * The `provider` and `model` fields are optional additions on top of
 * `LLMResponse['usage']` so that callers can enrich stored records without
 * breaking compatibility with the `response.usage` object they already hold.
 */
export type UsageData = LLMResponse['usage'] & {
  provider?: string;
  model?: string;
  /** Skill that originated the call, when attributable. */
  skillId?: string;
  /** Tool that originated the call, when attributable (e.g. 'rag.search'). */
  toolName?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a `YYYY-MM-DD` string in UTC for the given date. */
function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns the start of the day (00:00:00.000 UTC) for `date`. */
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Returns the end of the day (23:59:59.999 UTC) for `date`. */
function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
}

function nextDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

function nextMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Rough token cost of one media block, used only for quota preflight.
 *
 * Measuring an attachment by the length of its serialised payload is wrong by
 * orders of magnitude: a 32 KB PDF is ~43 000 base64 characters, which the
 * four-characters-per-token rule would price at ~11 000 tokens against the ~500
 * a provider actually bills — enough to trip a tenant's budget on a document
 * that costs almost nothing. These per-modality estimates stay in the right
 * order of magnitude instead.
 *
 * @param block - The media block to price.
 */
function estimateMediaTokens(block: MediaBlock): number {
  const bytes = knownByteLength(block);

  switch (block.type) {
    case 'image':
      // Providers bill an image as a fixed-ish tile budget, not by file size.
      return 1_000;
    case 'document': {
      // ~258 tokens per page across current providers; ~60 KB per page is a
      // reasonable middle for a scanned-or-digital mix.
      const pages = bytes === undefined ? 4 : Math.max(1, Math.round(bytes / 60_000));
      return pages * 258;
    }
    case 'audio':
      // ~25 tokens per second, ~32 KB per second of compressed audio.
      return bytes === undefined ? 2_000 : Math.max(100, Math.round((bytes / 32_000) * 25));
    case 'video':
      // ~300 tokens per second, ~250 KB per second of compressed video.
      return bytes === undefined ? 10_000 : Math.max(300, Math.round((bytes / 250_000) * 300));
  }
}

/**
 * Narrows a content block to a media one.
 *
 * Duplicated from `llm/content.ts` on purpose: `tokens/` must not depend on
 * `llm/` (see the dependency rules in CLAUDE.md), and this is a three-line
 * discriminant check.
 */
function isMediaBlock(block: ContentBlock): block is MediaBlock {
  return (
    block.type === 'image' ||
    block.type === 'document' ||
    block.type === 'audio' ||
    block.type === 'video'
  );
}

/** Size of a block's content when it is knowable without reading anything. */
function knownByteLength(block: MediaBlock): number | undefined {
  switch (block.source.kind) {
    case 'bytes':
      return block.source.bytes.byteLength;
    case 'base64':
      return Math.floor((block.source.data.length * 3) / 4);
    case 'providerFile':
      return block.source.ref.byteLength;
    default:
      return undefined;
  }
}

/** Estimated token cost of one message's content. */
function estimateMessageTokens(content: LLMMessage['content']): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);

  let tokens = 0;
  for (const block of content) {
    if (isMediaBlock(block)) {
      tokens += estimateMediaTokens(block);
    } else {
      tokens += Math.ceil(textLength(block) / 4);
    }
  }
  return tokens;
}

/**
 * Conservative provider-agnostic estimate used only for quota preflight.
 *
 * Text is approximated at four characters per token; media is estimated per
 * modality (see {@link estimateMediaTokens}) rather than by payload size;
 * `maxTokens` is included because providers may consume the whole configured
 * output budget.
 */
export function estimateLLMRequestTokens(request: LLMRequest): number {
  let tokens = Math.ceil(textLength(request.systemPrompt) / 4);
  for (const message of request.messages) {
    tokens += estimateMessageTokens(message.content) + 4;
  }
  tokens += Math.ceil(textLength(request.tools) / 4);
  return tokens + Math.max(0, request.maxTokens ?? 0);
}

/**
 * Yields one `YYYY-MM-DD` UTC string for every calendar day between
 * `from` and `to` (inclusive).
 */
function* iterateDays(from: Date, to: Date): IterableIterator<string> {
  const current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (current <= end) {
    yield toDateKey(current);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

/** Adds a record's tokens/cost into a keyed breakdown bucket (mutates `target`). */
function accumulate(
  target: Record<string, { tokens: number; cost: number }>,
  key: string,
  tokens: number,
  cost: number,
): void {
  const entry = target[key] ?? { tokens: 0, cost: 0 };
  entry.tokens += tokens;
  entry.cost += cost;
  target[key] = entry;
}

/** Aggregates an array of records into a {@link TokenUsageSummary}. */
function buildSummary(records: TokenUsageRecord[]): TokenUsageSummary {
  const byModel: Record<string, { tokens: number; cost: number }> = {};
  const byProvider: Record<string, { tokens: number; cost: number }> = {};
  const byAgent: Record<string, { tokens: number; cost: number }> = {};
  const bySkill: Record<string, { tokens: number; cost: number }> = {};
  const byTool: Record<string, { tokens: number; cost: number }> = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const r of records) {
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCostUsd += r.estimatedCostUsd;

    const modelTotal = r.inputTokens + r.outputTokens;
    accumulate(byModel, r.model, modelTotal, r.estimatedCostUsd);
    accumulate(byProvider, r.provider, modelTotal, r.estimatedCostUsd);
    accumulate(byAgent, r.agentId, modelTotal, r.estimatedCostUsd);
    // Skill/tool breakdowns only include attributed records.
    if (r.skillId !== undefined) accumulate(bySkill, r.skillId, modelTotal, r.estimatedCostUsd);
    if (r.toolName !== undefined) accumulate(byTool, r.toolName, modelTotal, r.estimatedCostUsd);
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    byModel,
    byProvider,
    byAgent,
    bySkill,
    byTool,
    recordCount: records.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TokenTracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks LLM token consumption per tenant and user.
 *
 * Records are stored in daily buckets using two complementary key spaces:
 * - `token:tenant:{tenantId}:{YYYY-MM-DD}` — all records for the tenant on a day.
 * - `token:user:{tenantId}:{userId}:{YYYY-MM-DD}` — per-user slice for the same day.
 *
 * This design keeps queries efficient: retrieving a date range only requires
 * one `get` call per calendar day, regardless of record volume.
 *
 * @example
 * ```typescript
 * const tracker = new TokenTracker();
 *
 * await tracker.record(context, {
 *   ...response.usage,
 *   provider: response.provider,
 *   model: response.model,
 * });
 *
 * const summary = await tracker.getByTenant('acme', {
 *   from: new Date('2026-01-01'),
 *   to: new Date('2026-01-31'),
 * });
 * ```
 */
export class TokenTracker {
  readonly #store: StorageAdapter;
  readonly #limits: TokenLimits;
  readonly #pricing: PricingTable;
  readonly #limitMode: TokenLimitMode;

  /**
   * @param store   - Storage backend.
   * @param limits  - Override token limits. Defaults to production values:
   *                  1M tokens/day per tenant, 50K tokens/day per user.
   * @param pricing - Price list used to estimate cost when the LLM provider does
   *                  not report one. Defaults to an empty table (cost 0).
   */
  constructor(
    store: StorageAdapter = new InMemoryAdapter(),
    limits: Partial<TokenLimits> = {},
    pricing: PricingTable = new PricingTable(),
    limitMode: TokenLimitMode = 'enforce',
  ) {
    this.#store = store;
    this.#limits = {
      perTenant: { ...DEFAULT_LIMITS.perTenant, ...limits.perTenant },
      perUser: { ...DEFAULT_LIMITS.perUser, ...limits.perUser },
    };
    this.#pricing = pricing;
    this.#limitMode = limitMode;
  }

  /**
   * Estimates the USD cost of a call from the configured price list.
   * Returns `0` for models without a configured price.
   */
  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.#pricing.cost(model, inputTokens, outputTokens);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Records a single LLM call's token consumption.
   *
   * The record is written into both the tenant-level and user-level daily
   * buckets so that both {@link getByTenant} and {@link getByUser} can query
   * efficiently without full scans.
   *
   * **Concurrency note:** each bucket write uses a read-modify-write pattern
   * (`get` → append → `set`) which is not atomic. Under high concurrency on
   * the same tenant/user/day bucket, concurrent `record()` calls may overwrite
   * each other and lose records. For exact quota enforcement, use a backend
   * adapter that supports atomic increment semantics (e.g. Redis `INCR`) and
   * implements the append at the adapter level.
   *
   * @param context - Execution context that identifies the tenant, user, agent,
   *                  session and request.
   * @param usage   - Token usage returned by the LLM provider. Optionally
   *                  includes `provider` and `model` to enrich the stored record.
   */
  async record(context: ExecutionContext, usage: UsageData): Promise<void> {
    if (this.#limitMode === 'disabled') return;
    const model = usage.model ?? 'unknown';
    const record: TokenUsageRecord = {
      recordId: randomUUID(),
      tenantId: context.tenantId,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      requestId: context.requestId,
      provider: usage.provider ?? 'unknown',
      model,
      ...(usage.skillId !== undefined && { skillId: usage.skillId }),
      ...(usage.toolName !== undefined && { toolName: usage.toolName }),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // Prefer the provider-reported cost; fall back to the configured price list.
      estimatedCostUsd:
        usage.cost ?? this.#pricing.cost(model, usage.inputTokens, usage.outputTokens),
      timestamp: new Date(),
    };

    const day = toDateKey(record.timestamp);
    const tenantKey = `token:tenant:${context.tenantId}:${day}`;
    const userKey = `token:user:${context.tenantId}:${context.userId}:${day}`;
    const agentKey = `token:agent:${context.tenantId}:${context.agentId}:${day}`;
    const sessionKey = `token:session:${context.sessionId}`;
    const requestKey = `token:request:${context.requestId}`;

    // Each consultable dimension gets its own bucket for O(1) lookups.
    // Note: read-modify-write is not atomic (see class-level concurrency note);
    // adding dimensions widens that window. Use an adapter with atomic appends
    // for exact accounting under high concurrency.
    await this.#appendRecord(tenantKey, record);
    await this.#appendRecord(userKey, record);
    await this.#appendRecord(agentKey, record);
    await this.#appendRecord(sessionKey, record);
    await this.#appendRecord(requestKey, record);
  }

  /**
   * Returns an aggregated {@link TokenUsageSummary} for all records belonging
   * to `tenantId` within the given date range (inclusive on both ends).
   *
   * @param tenantId  - Tenant to query.
   * @param dateRange - UTC date range. Both `from` and `to` are inclusive.
   */
  async getByTenant(
    tenantId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<TokenUsageSummary> {
    const records = await this.#loadRecords((day) => `token:tenant:${tenantId}:${day}`, dateRange);
    return buildSummary(records);
  }

  /**
   * Returns an aggregated {@link TokenUsageSummary} for all records belonging
   * to a specific user within the given date range (inclusive on both ends).
   *
   * @param tenantId  - Tenant to query.
   * @param userId    - User to filter by.
   * @param dateRange - UTC date range. Both `from` and `to` are inclusive.
   */
  async getByUser(
    tenantId: string,
    userId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<TokenUsageSummary> {
    const records = await this.#loadRecords(
      (day) => `token:user:${tenantId}:${userId}:${day}`,
      dateRange,
    );
    return buildSummary(records);
  }

  /**
   * Returns an aggregated {@link TokenUsageSummary} for a specific agent within
   * the given date range (inclusive on both ends).
   *
   * @param tenantId  - Tenant to query.
   * @param agentId   - Agent to filter by.
   * @param dateRange - UTC date range. Both `from` and `to` are inclusive.
   */
  async getByAgent(
    tenantId: string,
    agentId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<TokenUsageSummary> {
    const records = await this.#loadRecords(
      (day) => `token:agent:${tenantId}:${agentId}:${day}`,
      dateRange,
    );
    return buildSummary(records);
  }

  /**
   * Returns the aggregated usage for a single session, with full breakdown by
   * model, provider, agent, skill and tool. Not date-scoped: a session bucket
   * holds every call made within that conversation.
   *
   * @param sessionId - Session to query.
   */
  async getBySession(sessionId: string): Promise<TokenUsageSummary> {
    return buildSummary(await this.#loadKey(`token:session:${sessionId}`));
  }

  /**
   * Returns the aggregated usage for a single request — i.e. the cost of one
   * `chat()` / agent-loop call, including any tool- or RAG-triggered LLM calls.
   *
   * @param requestId - Request to query.
   */
  async getByRequest(requestId: string): Promise<TokenUsageSummary> {
    return buildSummary(await this.#loadKey(`token:request:${requestId}`));
  }

  /**
   * Checks whether the tenant (or a specific user within the tenant) is within
   * their configured daily token limit.
   *
   * - When `userId` is omitted the **tenant-level** daily limit is evaluated.
   * - When `userId` is provided the **user-level** daily limit is evaluated.
   *
   * @param tenantId - Tenant to check.
   * @param userId   - Optional user to check. When omitted, tenant limit applies.
   * @returns `{ allowed, remaining, limit }` where `remaining` is always ≥ 0.
   */
  async checkLimit(
    tenantId: string,
    userId?: string,
  ): Promise<{ allowed: boolean; remaining: number; limit: number }> {
    const today = new Date();
    const range = { from: startOfDay(today), to: endOfDay(today) };

    if (userId !== undefined) {
      const summary = await this.getByUser(tenantId, userId, range);
      const used = summary.totalInputTokens + summary.totalOutputTokens;
      const limit = this.#limits.perUser.daily;
      const remaining = Math.max(0, limit - used);
      return { allowed: remaining > 0, remaining, limit };
    }

    const summary = await this.getByTenant(tenantId, range);
    const used = summary.totalInputTokens + summary.totalOutputTokens;
    const limit = this.#limits.perTenant.daily;
    const remaining = Math.max(0, limit - used);
    return { allowed: remaining > 0, remaining, limit };
  }

  /**
   * Evaluates all applicable daily and monthly limits at once. In observe mode
   * violations are returned but do not block; disabled mode performs no reads.
   */
  async checkLimits(
    tenantId: string,
    userId?: string,
    estimatedTokens = 0,
  ): Promise<TokenLimitDecision> {
    const estimate = Math.max(0, Math.ceil(estimatedTokens));
    if (this.#limitMode === 'disabled') {
      return {
        mode: this.#limitMode,
        allowed: true,
        exceeded: false,
        estimatedTokens: estimate,
        checks: [],
      };
    }

    const now = new Date();
    const dailyRange = { from: startOfDay(now), to: endOfDay(now) };
    const monthlyRange = { from: startOfMonth(now), to: endOfMonth(now) };
    const [tenantDaily, tenantMonthly, userDaily, userMonthly] = await Promise.all([
      this.getByTenant(tenantId, dailyRange),
      this.getByTenant(tenantId, monthlyRange),
      userId === undefined ? undefined : this.getByUser(tenantId, userId, dailyRange),
      userId === undefined ? undefined : this.getByUser(tenantId, userId, monthlyRange),
    ]);

    const total = (summary: TokenUsageSummary): number =>
      summary.totalInputTokens + summary.totalOutputTokens;
    const makeCheck = (
      scope: TokenLimitScope,
      window: TokenLimitWindow,
      used: number,
      limit: number,
    ): TokenLimitCheck => {
      const projected = used + estimate;
      return {
        scope,
        window,
        used,
        projected,
        remaining: Math.max(0, limit - used),
        limit,
        exceeded: used >= limit || projected > limit,
        resetAt: window === 'daily' ? nextDay(now) : nextMonth(now),
      };
    };

    const checks: TokenLimitCheck[] = [];
    if (userDaily !== undefined && userMonthly !== undefined) {
      checks.push(
        makeCheck('user', 'daily', total(userDaily), this.#limits.perUser.daily),
        makeCheck('user', 'monthly', total(userMonthly), this.#limits.perUser.monthly),
      );
    }
    checks.push(
      makeCheck('tenant', 'daily', total(tenantDaily), this.#limits.perTenant.daily),
      makeCheck('tenant', 'monthly', total(tenantMonthly), this.#limits.perTenant.monthly),
    );

    const violation = checks.find((check) => check.exceeded);
    return {
      mode: this.#limitMode,
      allowed: this.#limitMode !== 'enforce' || violation === undefined,
      exceeded: violation !== undefined,
      estimatedTokens: estimate,
      checks,
      ...(violation !== undefined && { violation }),
    };
  }

  get limitMode(): TokenLimitMode {
    return this.#limitMode;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Loads and normalises all records stored under a single (non-dated) key. */
  async #loadKey(key: string): Promise<TokenUsageRecord[]> {
    const raw = await this.#store.get(key);
    if (!Array.isArray(raw)) return [];
    return (raw as TokenUsageRecord[]).map((r) => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }));
  }

  async #appendRecord(key: string, record: TokenUsageRecord): Promise<void> {
    const raw = await this.#store.get(key);
    const existing: TokenUsageRecord[] = Array.isArray(raw) ? (raw as TokenUsageRecord[]) : [];
    await this.#store.set(key, [...existing, record]);
  }

  async #loadRecords(
    keyFor: (day: string) => string,
    dateRange: { from: Date; to: Date },
  ): Promise<TokenUsageRecord[]> {
    const records: TokenUsageRecord[] = [];

    for (const day of iterateDays(dateRange.from, dateRange.to)) {
      const raw = await this.#store.get(keyFor(day));
      if (!Array.isArray(raw)) continue;

      for (const r of raw as TokenUsageRecord[]) {
        // Normalise: Date objects survive in InMemoryAdapter, strings come
        // from JSON-based adapters (Redis, Mongo). Always reconstruct.
        const ts = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
        if (ts >= dateRange.from && ts <= dateRange.to) {
          records.push({ ...r, timestamp: ts });
        }
      }
    }

    return records;
  }
}
