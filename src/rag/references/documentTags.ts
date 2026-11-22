import type { ReferenceExtractor } from './ReferenceExtractor.js';
import type { RelationExtractor } from './RelationExtractor.js';

/** Tag prefix of a document's identity keys (`ref:annex:14`). */
export const REF_TAG = 'ref:';
/** Tag prefix of a document's stated relations (`rel:derogates:decree:732/19`). */
export const REL_TAG = 'rel:';

/**
 * Tags that let the index answer reference and relation lookups by itself:
 * `ref:<key>` for each key that identifies the document (from its title, or
 * the beginning of its text) and `rel:<type>:<key>` for each relation its
 * text states toward another document.
 */
export function documentTags(
  references: ReferenceExtractor,
  relations: RelationExtractor,
  title: string,
  text: string,
): string[] {
  const own = references.identify(title, text);
  const ownSet = new Set(own);
  const rel = relations
    .extract(text)
    .filter((r) => !ownSet.has(r.target))
    .map((r) => `${REL_TAG}${r.type}:${r.target}`);
  return [...own.map((k) => `${REF_TAG}${k}`), ...new Set(rel)];
}
