import { describe, it, expect } from 'vitest';
import { SlidingWindow } from '../../../src/memory/strategies/SlidingWindow.js';
import type { LLMMessage } from '../../../src/types/index.js';

function makeMessages(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as LLMMessage['role'],
    content: `msg ${i}`,
  }));
}

describe('SlidingWindow', () => {
  describe('shouldCompress()', () => {
    it('returns false when messages.length <= maxMessages', () => {
      const strategy = new SlidingWindow({ maxMessages: 5 });
      expect(strategy.shouldCompress(makeMessages(5))).toBe(false);
    });

    it('returns false for fewer messages than max', () => {
      const strategy = new SlidingWindow({ maxMessages: 10 });
      expect(strategy.shouldCompress(makeMessages(3))).toBe(false);
    });

    it('returns true when messages.length > maxMessages', () => {
      const strategy = new SlidingWindow({ maxMessages: 5 });
      expect(strategy.shouldCompress(makeMessages(6))).toBe(true);
    });

    it('uses default maxMessages of 20', () => {
      const strategy = new SlidingWindow();
      expect(strategy.shouldCompress(makeMessages(20))).toBe(false);
      expect(strategy.shouldCompress(makeMessages(21))).toBe(true);
    });
  });

  describe('compress()', () => {
    it('returns the last maxMessages messages', async () => {
      const strategy = new SlidingWindow({ maxMessages: 3 });
      const messages = makeMessages(6);

      const result = await strategy.compress(messages);

      expect(result).toHaveLength(3);
      expect(result).toEqual(messages.slice(-3));
    });

    it('does not mutate the original array', async () => {
      const strategy = new SlidingWindow({ maxMessages: 3 });
      const messages = makeMessages(5);
      const original = [...messages];

      await strategy.compress(messages);

      expect(messages).toEqual(original);
    });

    it('returns all messages when messages.length <= maxMessages', async () => {
      const strategy = new SlidingWindow({ maxMessages: 10 });
      const messages = makeMessages(4);

      const result = await strategy.compress(messages);

      expect(result).toEqual(messages);
    });

    it('returns empty array when input is empty', async () => {
      const strategy = new SlidingWindow({ maxMessages: 5 });
      expect(await strategy.compress([])).toEqual([]);
    });

    it('keeps the most recent messages (not the oldest)', async () => {
      const strategy = new SlidingWindow({ maxMessages: 2 });
      const messages: LLMMessage[] = [
        { role: 'user', content: 'old-1' },
        { role: 'assistant', content: 'old-2' },
        { role: 'user', content: 'recent-1' },
        { role: 'assistant', content: 'recent-2' },
      ];

      const result = await strategy.compress(messages);

      expect(result.map((m) => m.content)).toEqual(['recent-1', 'recent-2']);
    });
  });

  describe('type', () => {
    it('is "sliding_window"', () => {
      expect(new SlidingWindow().type).toBe('sliding_window');
    });
  });

  describe('maxMessages getter', () => {
    it('returns the configured value', () => {
      expect(new SlidingWindow({ maxMessages: 7 }).maxMessages).toBe(7);
    });

    it('returns 20 as the default', () => {
      expect(new SlidingWindow().maxMessages).toBe(20);
    });
  });
});
