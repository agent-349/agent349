import type { Passage } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reciprocal Rank Fusion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges two ranked passage lists using Reciprocal Rank Fusion (RRF).
 *
 * RRF assigns each passage a combined score based on its rank position in each
 * list. Passages that rank highly in both lists receive the highest scores.
 * The `alpha` parameter controls the relative weight of each list:
 * - `alpha = 1.0` → pure vector (keyword results have zero contribution)
 * - `alpha = 0.0` → pure keyword (vector results have zero contribution)
 * - `alpha = 0.7` → typical hybrid (recommended default)
 *
 * Passages present in only one list still receive a partial score from that
 * list. Passages absent from both lists are not included in the output.
 *
 * The returned list is sorted by combined RRF score descending. No `topK`
 * slicing is applied — callers are responsible for truncating.
 *
 * @param vectorResults  - Passages from semantic (vector) search, rank-ordered.
 * @param keywordResults - Passages from keyword (full-text) search, rank-ordered.
 * @param alpha          - Weight for vector results in [0, 1]. `1 - alpha` is
 *                         applied to keyword results.
 * @param k              - RRF smoothing constant. Default: 60. Higher values
 *                         reduce the penalty for lower-ranked items.
 * @returns Merged, deduplicated passage list sorted by combined RRF score.
 *
 * @example
 * ```typescript
 * const merged = reciprocalRankFusion(vectorHits, keywordHits, 0.7);
 * const topK = merged.slice(0, 10);
 * ```
 */
export function reciprocalRankFusion(
  vectorResults: Passage[],
  keywordResults: Passage[],
  alpha: number,
  k = 60,
): Passage[] {
  // Build a lookup so we can reconstruct full Passage objects after scoring.
  // Vector results take precedence in the lookup; keyword fills the rest.
  const byId = new Map<string, Passage>();
  for (const p of keywordResults) byId.set(p.id, p);
  for (const p of vectorResults) byId.set(p.id, p);

  const scores = new Map<string, number>();

  vectorResults.forEach((p, rank) => {
    const rrf = alpha * (1 / (k + rank + 1));
    scores.set(p.id, (scores.get(p.id) ?? 0) + rrf);
  });

  keywordResults.forEach((p, rank) => {
    const rrf = (1 - alpha) * (1 / (k + rank + 1));
    scores.set(p.id, (scores.get(p.id) ?? 0) + rrf);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id)!, score }));
}

/**
 * Reciprocal Rank Fusion of any number of ranked lists: each passage scores
 * `Σ 1 / (k + rank)` over the lists that contain it. Used to merge the results
 * of a query and its expansion variants, whose raw scores are not comparable.
 *
 * The returned passages are the first occurrence of each id (earlier lists win,
 * so the original query's copy is kept) with `score` set to the fused score
 * normalised to [0, 1] by the best one.
 *
 * @param lists - Ranked passage lists, best first.
 * @param k     - Rank damping constant. Default: 60.
 * @returns The fused list, best first.
 */
export function fuseRankedLists(lists: Passage[][], k = 60): Passage[] {
  const byId = new Map<string, Passage>();
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((p, rank) => {
      if (!byId.has(p.id)) byId.set(p.id, p);
      scores.set(p.id, (scores.get(p.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  const best = Math.max(0, ...scores.values()) || 1;
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id)!, score: score / best }));
}
