import { describe, it, expect } from 'vitest';
import { estimateLLMRequestTokens } from '../../../src/tokens/TokenTracker.js';
import { documentFromBytes, fromBase64, imageFromBytes, text } from '../../../src/content/index.js';
import type { LLMRequest } from '../../../src/types/index.js';

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: '',
    messages: [],
    model: 'test',
    ...overrides,
  };
}

describe('estimateLLMRequestTokens — text', () => {
  it('approximates text at four characters per token', () => {
    const estimate = estimateLLMRequestTokens(
      request({ messages: [{ role: 'user', content: 'a'.repeat(400) }] }),
    );
    expect(estimate).toBeGreaterThanOrEqual(100);
    expect(estimate).toBeLessThan(120);
  });

  it('includes the output budget, which the provider may consume in full', () => {
    const withBudget = estimateLLMRequestTokens(request({ maxTokens: 4_096 }));
    expect(withBudget).toBeGreaterThanOrEqual(4_096);
  });
});

describe('estimateLLMRequestTokens — media', () => {
  it('does not price a document by the length of its base64 payload', () => {
    // A 32 KB PDF is ~43 000 base64 characters. Charging 4 chars/token would
    // estimate ~11 000 tokens for a document providers bill at a few hundred —
    // enough to trip a tenant budget on an almost-free request.
    const pdf = new Uint8Array(32 * 1024);
    const estimate = estimateLLMRequestTokens(
      request({
        messages: [{ role: 'user', content: [documentFromBytes(pdf, 'application/pdf')] }],
      }),
    );

    expect(estimate).toBeLessThan(1_500);
  });

  it('scales a document estimate with its page count, not its byte count directly', () => {
    const small = estimateLLMRequestTokens(
      request({
        messages: [
          { role: 'user', content: [documentFromBytes(new Uint8Array(60_000), 'application/pdf')] },
        ],
      }),
    );
    const large = estimateLLMRequestTokens(
      request({
        messages: [
          {
            role: 'user',
            content: [documentFromBytes(new Uint8Array(600_000), 'application/pdf')],
          },
        ],
      }),
    );

    expect(large).toBeGreaterThan(small * 5);
  });

  it('prices an image as a flat tile budget regardless of file size', () => {
    const small = estimateLLMRequestTokens(
      request({
        messages: [{ role: 'user', content: [imageFromBytes(new Uint8Array(1_000), 'image/png')] }],
      }),
    );
    const large = estimateLLMRequestTokens(
      request({
        messages: [
          { role: 'user', content: [imageFromBytes(new Uint8Array(5_000_000), 'image/png')] },
        ],
      }),
    );

    expect(small).toBe(large);
  });

  it('estimates a base64 source from its decoded size', () => {
    const data = Buffer.alloc(120_000).toString('base64');
    const estimate = estimateLLMRequestTokens(
      request({ messages: [{ role: 'user', content: [fromBase64(data, 'application/pdf')] }] }),
    );

    // ~2 pages at ~258 tokens, not ~40 000 from the encoded string length.
    expect(estimate).toBeLessThan(1_000);
  });

  it('adds up text and media in the same turn', () => {
    const estimate = estimateLLMRequestTokens(
      request({
        messages: [
          {
            role: 'user',
            content: [text('a'.repeat(400)), imageFromBytes(new Uint8Array(10), 'image/png')],
          },
        ],
      }),
    );

    expect(estimate).toBeGreaterThan(1_000);
  });

  it('still produces an estimate for a path source of unknown size', () => {
    const estimate = estimateLLMRequestTokens(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'document', source: { kind: 'path', path: '/a.pdf' } }],
          },
        ],
      }),
    );

    expect(estimate).toBeGreaterThan(0);
  });
});
