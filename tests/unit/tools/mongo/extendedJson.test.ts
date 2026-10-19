import { describe, it, expect } from 'vitest';
import { reviveExtendedJson } from '../../../../src/tools/builtin/mongo/extendedJson.js';
import { QueryRejectedError } from '../../../../src/errors/index.js';

/** Stand-ins for the `mongodb` constructors, so the test needs no driver. */
class FakeObjectId {
  constructor(readonly hex: string) {}
}
const BSON = {
  ObjectId: FakeObjectId,
  Decimal128: { fromString: (v: string) => ({ decimal: v }) },
  Long: { fromString: (v: string) => ({ long: v }) },
};

describe('reviveExtendedJson', () => {
  it('turns $date into a Date, inside an operator', () => {
    const out = reviveExtendedJson({ createdAt: { $gte: { $date: '2026-03-01' } } }, BSON) as {
      createdAt: { $gte: Date };
    };
    expect(out.createdAt.$gte).toBeInstanceOf(Date);
    expect(out.createdAt.$gte.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('accepts the canonical { $date: { $numberLong } } form', () => {
    const out = reviveExtendedJson({ $date: { $numberLong: '0' } }, BSON) as Date;
    expect(out.getTime()).toBe(0);
  });

  it('turns $oid into an ObjectId built by the given library', () => {
    const out = reviveExtendedJson({ _id: { $oid: '6a9eab37069759df92004a14' } }, BSON) as {
      _id: FakeObjectId;
    };
    expect(out._id).toBeInstanceOf(FakeObjectId);
    expect(out._id.hex).toBe('6a9eab37069759df92004a14');
  });

  it('walks pipelines', () => {
    const out = reviveExtendedJson(
      [{ $match: { at: { $lt: { $date: '2026-01-01T00:00:00Z' } } } }, { $group: { _id: '$a' } }],
      BSON,
    ) as [{ $match: { at: { $lt: Date } } }, unknown];
    expect(out[0].$match.at.$lt).toBeInstanceOf(Date);
    expect(out[1]).toEqual({ $group: { _id: '$a' } });
  });

  it('converts $numberDecimal and $numberLong', () => {
    expect(reviveExtendedJson({ $numberDecimal: '10.5' }, BSON)).toEqual({ decimal: '10.5' });
    expect(reviveExtendedJson({ $numberLong: '42' }, BSON)).toEqual({ long: '42' });
  });

  // Only a single-key wrapper is converted: an operator is never mistaken for one.
  it('leaves objects with more keys alone', () => {
    const value = { $date: '2026-03-01', other: 1 };
    expect(reviveExtendedJson(value, BSON)).toEqual(value);
  });

  it('does not mutate its input', () => {
    const value = { at: { $date: '2026-03-01' } };
    reviveExtendedJson(value, BSON);
    expect(value.at).toEqual({ $date: '2026-03-01' });
  });

  it.each([
    [{ $oid: 'nope' }],
    [{ $date: 'not a date' }],
    [{ $date: true }],
    [{ $numberDecimal: 'abc' }],
  ])('refuses an unusable wrapper %j', (value) => {
    expect(() => reviveExtendedJson(value, BSON)).toThrow(QueryRejectedError);
  });

  it('returns Dates and non-plain objects untouched', () => {
    const date = new Date(0);
    const id = new FakeObjectId('x');
    expect(reviveExtendedJson({ a: date, b: id }, BSON)).toEqual({ a: date, b: id });
  });
});
