import { QueryRejectedError } from '../../../errors/index.js';

/**
 * Operators that run JavaScript on the database server.
 *
 * The Mongo equivalent of letting a query execute code: `$where` and friends
 * take a function body, which is remote code execution wearing a filter's
 * clothes.
 */
const CODE_OPERATORS = ['$where', '$function', '$accumulator', '$expr.$function'];

/**
 * Aggregation stages that write.
 *
 * These are the reason "an aggregation pipeline is read-only" is false:
 * `$out` replaces a collection and `$merge` writes into one, both from inside
 * what otherwise looks like a query.
 */
const WRITE_STAGES = ['$out', '$merge'];

/**
 * Stages that read the server rather than a collection.
 *
 * None of them reads data the allowlist names: they report sessions, running
 * operations, storage and index statistics, query plans and change streams.
 * That is information about the deployment — other users' queries included —
 * and a model analysing business data has no use for it.
 */
const SERVER_STAGES = [
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$collStats',
  '$indexStats',
  '$planCacheStats',
  '$listSearchIndexes',
  '$listSampledQueries',
  '$shardedDataDistribution',
  '$querySettings',
  '$changeStream',
  '$changeStreamSplitLargeEvent',
];

/** Options for the Mongo guard chain. */
export interface MongoGuardOptions {
  /** Collections the query may touch. Empty means no allowlist. */
  allowedCollections?: string[];
}

/**
 * Checks a model-authored filter for operators that execute code.
 *
 * @param filter  - The filter document.
 * @param options - Unused today; kept for symmetry with the pipeline guard.
 * @throws {@link QueryRejectedError} when a code operator appears anywhere.
 */
export function guardFilter(filter: unknown, options: MongoGuardOptions = {}): void {
  void options;
  assertNoCodeOperators(filter);
}

/**
 * Checks a model-authored aggregation pipeline.
 *
 * Beyond code operators, this refuses write stages, stages that inspect the
 * server instead of a collection, and every way a pipeline can reach another
 * collection — `$lookup`, `$graphLookup` and `$unionWith` — when the target is
 * outside the allowlist. Without that last check, any of the three is a way to
 * read a collection the query was never allowed to name.
 *
 * The walk is recursive: `$facet`, `$lookup.pipeline` and `$unionWith.pipeline`
 * hold whole sub-pipelines, and checking only the top level would let one of
 * those stages through one level down.
 *
 * @param pipeline - The pipeline stages.
 * @param options  - The collection allowlist.
 * @throws {@link QueryRejectedError} naming the guard that fired.
 */
export function guardPipeline(pipeline: unknown, options: MongoGuardOptions = {}): void {
  assertNoCodeOperators(pipeline);
  checkStages(pipeline, options);
}

/** Walks one pipeline (top level or nested) stage by stage. */
function checkStages(pipeline: unknown, options: MongoGuardOptions): void {
  if (!Array.isArray(pipeline)) {
    throw new QueryRejectedError('pipeline-shape', 'The pipeline must be an array of stages.');
  }

  for (const stage of pipeline as unknown[]) {
    if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
      throw new QueryRejectedError('pipeline-shape', 'Every pipeline stage must be an object.');
    }

    for (const [operator, value] of Object.entries(stage)) {
      if (WRITE_STAGES.includes(operator)) {
        throw new QueryRejectedError(
          'read-only',
          `The stage ${operator} writes to the database and is not allowed. ` +
            'Only read pipelines are permitted.',
        );
      }

      if (SERVER_STAGES.includes(operator)) {
        throw new QueryRejectedError(
          'server-stage',
          `The stage ${operator} inspects the database server, not a collection, and is ` +
            'not allowed. Read only the collections you were given.',
        );
      }

      const spec = isRecord(value) ? value : undefined;

      if (operator === '$lookup' || operator === '$graphLookup') {
        // `from` may be omitted by a `$lookup` whose sub-pipeline starts with
        // `$documents`; that reads nothing stored, so there is nothing to check.
        if (spec?.['from'] !== undefined) assertReachable(spec['from'], operator, options);
        if (spec?.['pipeline'] !== undefined) checkStages(spec['pipeline'], options);
      }

      if (operator === '$unionWith') {
        if (typeof value === 'string') {
          assertReachable(value, operator, options);
        } else {
          assertReachable(spec?.['coll'], operator, options);
          if (spec?.['pipeline'] !== undefined) checkStages(spec['pipeline'], options);
        }
      }

      if (operator === '$facet' && spec !== undefined) {
        for (const branch of Object.values(spec)) checkStages(branch, options);
      }
    }
  }
}

/**
 * Checks the collection a cross-collection stage reaches.
 *
 * A target that is not a plain collection name — `{ db, coll }` — reaches
 * another database, which no allowlist of this connection can describe, so it
 * is refused even when no allowlist is configured.
 */
function assertReachable(target: unknown, operator: string, options: MongoGuardOptions): void {
  if (typeof target !== 'string' || target === '') {
    throw new QueryRejectedError(
      'allowed-collections',
      `${operator} must name a collection of this database by its plain name.`,
    );
  }

  const allowed = options.allowedCollections ?? [];
  if (allowed.length === 0) return;

  if (!allowed.some((name) => name.toLowerCase() === target.toLowerCase())) {
    throw new QueryRejectedError(
      'allowed-collections',
      `${operator} reaches '${target}', which is not available. ` +
        `You can query: ${allowed.join(', ')}.`,
    );
  }
}

/** Whether `value` is a plain object rather than an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks that a collection is on the allowlist.
 *
 * @param collection - Collection the model asked for.
 * @param options    - The allowlist.
 * @throws {@link QueryRejectedError} when it is not allowed.
 */
export function guardCollection(collection: string, options: MongoGuardOptions = {}): void {
  const allowed = options.allowedCollections ?? [];
  if (allowed.length === 0) return;

  if (!allowed.some((name) => name.toLowerCase() === collection.toLowerCase())) {
    throw new QueryRejectedError(
      'allowed-collections',
      `Collection '${collection}' is not available. You can query: ${allowed.join(', ')}.`,
    );
  }
}

/** Walks a document looking for operators that would execute code. */
function assertNoCodeOperators(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoCodeOperators(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (CODE_OPERATORS.includes(key)) {
      throw new QueryRejectedError(
        'code-operator',
        `The operator ${key} runs code on the database server and is not allowed. ` +
          'Express the condition with ordinary query operators instead.',
      );
    }
    assertNoCodeOperators(child, path === '' ? key : `${path}.${key}`);
  }
}

/**
 * Replaces `:name` markers in a filter or pipeline template with values.
 *
 * Substitution happens **after** the template is parsed and **by value**, so a
 * supplied value lands as data. A model-supplied object where a string was
 * declared is what turns `{ status: ':s' }` into `{ status: { $ne: null } }`,
 * and the schema check upstream is what prevents it; this walk never splices
 * text.
 *
 * @param template - The declared filter or pipeline.
 * @param values   - Resolved parameter values.
 * @returns A new structure with markers replaced.
 */
export function fillMongoTemplate(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const marker = /^:([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(template);
    return marker?.[1] !== undefined ? (values[marker[1]] ?? null) : template;
  }
  if (Array.isArray(template)) return template.map((item) => fillMongoTemplate(item, values));
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      out[key] = fillMongoTemplate(value, values);
    }
    return out;
  }
  return template;
}
