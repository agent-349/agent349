import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../../src/rag/fusion/RRF.js';
import type { Passage } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePassage(id: string, score = 0.5): Passage {
  return {
    id,
    content: `Content of ${id}`,
    score,
    metadata: { documentId: id },
    collection: 'test',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  describe('output ordering', () => {
    it('returns passages sorted by combined RRF score descending', () => {
      // p1 ranks #1 in both lists — should win
      const vectorResults = [makePassage('p1'), makePassage('p2'), makePassage('p3')];
      const keywordResults = [makePassage('p1'), makePassage('p3'), makePassage('p2')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.5);
      expect(result[0].id).toBe('p1');
    });

    it('returns all unique passages (union, not intersection)', () => {
      const vectorResults = [makePassage('v1'), makePassage('shared')];
      const keywordResults = [makePassage('k1'), makePassage('shared')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.5);
      const ids = result.map((p) => p.id);
      expect(ids).toContain('v1');
      expect(ids).toContain('k1');
      expect(ids).toContain('shared');
      expect(ids).toHaveLength(3);
    });

    it('deduplicates passages present in both lists', () => {
      const vectorResults = [makePassage('shared'), makePassage('a')];
      const keywordResults = [makePassage('shared'), makePassage('b')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.5);
      const ids = result.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  describe('alpha weighting', () => {
    it('alpha=1 means only vector results influence scores', () => {
      // Only in vector list; absent from keyword list
      const vectorResults = [makePassage('v-only')];
      const keywordResults = [makePassage('k-only')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 1.0);

      const vScore = result.find((p) => p.id === 'v-only')!.score;
      const kScore = result.find((p) => p.id === 'k-only')!.score;
      // alpha=1 → keyword weight = 0 → k-only gets 0 contribution
      expect(vScore).toBeGreaterThan(0);
      expect(kScore).toBe(0);
    });

    it('alpha=0 means only keyword results influence scores', () => {
      const vectorResults = [makePassage('v-only')];
      const keywordResults = [makePassage('k-only')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.0);

      const vScore = result.find((p) => p.id === 'v-only')!.score;
      const kScore = result.find((p) => p.id === 'k-only')!.score;
      expect(kScore).toBeGreaterThan(0);
      expect(vScore).toBe(0);
    });

    it('alpha=0.7 gives more weight to vector than keyword', () => {
      // p1 is rank #1 only in vector list
      // p2 is rank #1 only in keyword list
      const vectorResults = [makePassage('p1')];
      const keywordResults = [makePassage('p2')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.7);

      const p1Score = result.find((p) => p.id === 'p1')!.score;
      const p2Score = result.find((p) => p.id === 'p2')!.score;
      // p1 gets 0.7 * rrf; p2 gets 0.3 * rrf — same rank, so p1 > p2
      expect(p1Score).toBeGreaterThan(p2Score);
    });
  });

  describe('score computation', () => {
    it('a passage ranked first in both lists scores higher than one ranked second in one', () => {
      // top1 is rank 0 in both lists; top2 is rank 1 in vector only
      const vectorResults = [makePassage('top1'), makePassage('top2')];
      const keywordResults = [makePassage('top1'), makePassage('top3')];

      const result = reciprocalRankFusion(vectorResults, keywordResults, 0.5);

      const s1 = result.find((p) => p.id === 'top1')!.score;
      const s2 = result.find((p) => p.id === 'top2')!.score;
      const s3 = result.find((p) => p.id === 'top3')!.score;
      expect(s1).toBeGreaterThan(s2);
      expect(s1).toBeGreaterThan(s3);
    });

    it('the RRF score overwrites the original passage score', () => {
      const p = makePassage('a', 0.99); // high original score
      const result = reciprocalRankFusion([p], [], 0.5);
      // RRF score is 0.5 * 1/(60+0+1) = ~0.0082, not 0.99
      expect(result[0].score).toBeLessThan(0.5);
    });

    it('uses custom k constant correctly', () => {
      // k=0 means rank 0 contributes 1/(0+0+1) = 1, rank 1 contributes 1/(0+1+1) = 0.5
      const vectorResults = [makePassage('first'), makePassage('second')];
      const result = reciprocalRankFusion(vectorResults, [], 1.0, 0);
      expect(result[0].score).toBeCloseTo(1.0, 5);
      expect(result[1].score).toBeCloseTo(0.5, 5);
    });
  });

  describe('edge cases', () => {
    it('returns empty array when both lists are empty', () => {
      expect(reciprocalRankFusion([], [], 0.5)).toEqual([]);
    });

    it('handles empty vector list (alpha still applied)', () => {
      const keywordResults = [makePassage('k1'), makePassage('k2')];
      const result = reciprocalRankFusion([], keywordResults, 0.7);
      // All contribution from keyword side (weight = 0.3)
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('k1'); // rank 0 > rank 1
    });

    it('handles empty keyword list', () => {
      const vectorResults = [makePassage('v1'), makePassage('v2')];
      const result = reciprocalRankFusion(vectorResults, [], 0.7);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('v1');
    });

    it('preserves full Passage shape (content, metadata, collection)', () => {
      const p = makePassage('a');
      const result = reciprocalRankFusion([p], [], 1.0);
      expect(result[0].id).toBe('a');
      expect(result[0].content).toBe('Content of a');
      expect(result[0].metadata.documentId).toBe('a');
      expect(result[0].collection).toBe('test');
    });

    it('uses vector result data when passage appears in both lists', () => {
      const vectorPassage: Passage = {
        id: 'shared',
        content: 'vector version',
        score: 0.9,
        metadata: { documentId: 'shared' },
        collection: 'vector-col',
      };
      const keywordPassage: Passage = {
        id: 'shared',
        content: 'keyword version',
        score: 0.3,
        metadata: { documentId: 'shared' },
        collection: 'keyword-col',
      };
      const result = reciprocalRankFusion([vectorPassage], [keywordPassage], 0.5);
      expect(result[0].content).toBe('vector version');
    });
  });
});
