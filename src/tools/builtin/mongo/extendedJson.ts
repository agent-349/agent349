import { QueryRejectedError } from '../../../errors/index.js';

/**
 * The BSON constructors {@link reviveExtendedJson} needs.
 *
 * They must come from the same `mongodb` package that serialises the query:
 * BSON 5+ refuses values built by another copy of the library ("Unsupported
 * BSON version"), so the driver passes its own module rather than this file
 * importing one.
 */
export interface ExtendedJsonBson {
  ObjectId: new (hex: string) => unknown;
  Decimal128?: { fromString(value: string): unknown };
  Long?: { fromString(value: string): unknown };
}

/** Wrappers this file understands. Anything else is left untouched. */
const WRAPPERS = ['$oid', '$date', '$numberDecimal', '$numberLong'];

/** 24 hexadecimal characters: the only text an ObjectId is built from. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Turns MongoDB Extended JSON wrappers into the BSON values a query needs.
 *
 * A model writes JSON, and JSON has no dates and no ObjectIds. Without this a
 * free-form filter can never say "created after March" (`{ $gte: '2026-03-01' }`
 * compares a Date field with a string and matches nothing, silently) nor select
 * a document by its `_id`. Extended JSON is the notation the model already
 * knows for that: `{ "$date": "2026-03-01" }`, `{ "$oid": "…" }`.
 *
 * Only an object whose **single** key is one of the wrappers is converted, so a
 * query operator is never mistaken for one. A wrapper with a value it cannot
 * convert is refused with a message the model can act on — leaving it as an
 * object would run a query that silently matches nothing.
 *
 * @param value - A filter, pipeline, sort or projection, as the model wrote it.
 * @param bson  - Constructors from the `mongodb` package that will serialise it.
 * @returns A new structure with the wrappers replaced; the input is not mutated.
 * @throws {@link QueryRejectedError} for a wrapper with an unusable value.
 */
export function reviveExtendedJson(value: unknown, bson: ExtendedJsonBson): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveExtendedJson(item, bson));
  if (!isPlainObject(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && WRAPPERS.includes(keys[0] as string)) {
    return revive(keys[0] as string, value[keys[0] as string], bson);
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = reviveExtendedJson(child, bson);
  }
  return out;
}

/** Converts one wrapper. */
function revive(wrapper: string, raw: unknown, bson: ExtendedJsonBson): unknown {
  if (wrapper === '$oid') {
    if (typeof raw !== 'string' || !OBJECT_ID.test(raw)) {
      throw rejected('$oid needs 24 hexadecimal characters.');
    }
    return new bson.ObjectId(raw);
  }

  if (wrapper === '$date') {
    // Canonical Extended JSON writes a number as { $numberLong: "…" }.
    const source =
      isPlainObject(raw) && typeof raw['$numberLong'] === 'string'
        ? Number(raw['$numberLong'])
        : raw;
    const date =
      typeof source === 'string' || typeof source === 'number' ? new Date(source) : undefined;
    if (date === undefined || Number.isNaN(date.getTime())) {
      throw rejected('$date needs an ISO-8601 date ("2026-03-01" or "2026-03-01T10:00:00Z").');
    }
    return date;
  }

  if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw rejected(`${wrapper} needs a number written as a string.`);
  }
  if (wrapper === '$numberDecimal' && bson.Decimal128 !== undefined) {
    return bson.Decimal128.fromString(raw);
  }
  if (wrapper === '$numberLong' && bson.Long !== undefined) {
    return bson.Long.fromString(raw);
  }
  return Number(raw);
}

function rejected(message: string): QueryRejectedError {
  return new QueryRejectedError('extended-json', `Invalid Extended JSON value: ${message}`);
}

/**
 * Whether `value` is a plain JSON object. Instances that are already BSON or
 * Dates (a host may pass them) are returned untouched by the walk.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
