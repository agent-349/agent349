/**
 * Answer verification: the verifier call and its parsing, the figures check,
 * the policy decisions, the repair instruction and notice, and the pipeline
 * method (token accounting, audit event).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  AnswerVerifier,
  buildRepairInstruction,
  decideVerification,
  unmatchedNumbers,
  verificationNotice,
} from '../../../src/rag/verification/AnswerVerifier.js';
import type { VerificationResult } from '../../../src/rag/verification/AnswerVerifier.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { LLMResponse, ExecutionContext } from '../../../src/types/index.js';
import type { Passage } from '../../../src/rag/types.js';

const passage = (id: string, content: string): Passage => ({
  id,
  content,
  score: 1,
  collection: 'docs',
  metadata: { documentId: id, title: `Doc ${id}` },
});
const PASSAGES = [
  passage('p1', 'Claims are filed at the branch within thirty days, with the receipt.'),
  passage('p2', 'Refunds over 500 require the approval of the branch manager.'),
];

function routerReplying(reply: Partial<LLMResponse> | Error | (() => Promise<never>)) {
  const call = vi.fn(async () => {
    if (typeof reply === 'function') return reply();
    if (reply instanceof Error) throw reply;
    return {
      content: '',
      stopReason: 'end',
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
      ...reply,
    };
  });
  return { call, getProvider: vi.fn(() => undefined) } as unknown as LLMRouter & {
    call: ReturnType<typeof vi.fn>;
  };
}

const json = (v: unknown): Partial<LLMResponse> => ({ content: JSON.stringify(v) });

describe('unmatchedNumbers', () => {
  it('compares figures by their digits and ignores single digits', () => {
    expect(
      unmatchedNumbers('File within 30 days; refunds over 500 (or 1.500) need approval; step 2.', [
        passage('a', 'Within 30 days. Refunds over 500.'),
      ]),
    ).toEqual(['1.500']);
    expect(unmatchedNumbers('Due 29/01/2020', [passage('a', 'due 29-01-2020')])).toEqual([]);
  });
});

describe('AnswerVerifier', () => {
  const question = 'How do I file a claim?';

  it('sends the whole passage by default, so a rule past the first 1,500 characters is seen', async () => {
    const router = routerReplying(
      json({ claims: [], applicability: { verdict: 'applies', reason: '' } }),
    );
    const long = passage(
      'p9',
      'Intro. '.repeat(300) +
        'Footage may not be handed to anyone until the security advisers arrive.',
    );
    await new AnswerVerifier(router, 'p', 'm').verify({
      question,
      answer: 'Wait for the advisers.',
      passages: [long],
    });
    const sent = (router.call.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0]!
      .content;
    expect(long.content.length).toBeGreaterThan(2000);
    expect(sent).toContain('until the security advisers arrive');
    const capped = routerReplying(
      json({ claims: [], applicability: { verdict: 'applies', reason: '' } }),
    );
    await new AnswerVerifier(capped, 'p', 'm', { maxPassageChars: 500 }).verify({
      question,
      answer: 'x',
      passages: [long],
    });
    const sentCapped = (capped.call.mock.calls[0]![0] as { messages: { content: string }[] })
      .messages[0]!.content;
    expect(sentCapped).not.toContain('until the security advisers arrive');
  });

  it('passes when every claim is supported and the passages apply', async () => {
    const router = routerReplying(
      json({
        claims: [
          {
            text: 'Claims are filed at the branch.',
            verdict: 'supported',
            passages: [1],
            note: '',
          },
        ],
        applicability: { verdict: 'applies', reason: '' },
      }),
    );
    const r = await new AnswerVerifier(router, 'p', 'm').verify({
      question,
      answer: 'File it at the branch.',
      passages: PASSAGES,
    });
    expect(r).toMatchObject({
      verdict: 'pass',
      claims: [
        { text: 'Claims are filed at the branch.', verdict: 'supported', passageIds: ['p1'] },
      ],
      applicability: { verdict: 'applies' },
      inputTokens: 300,
      outputTokens: 80,
    });
  });

  it('fails on an unsupported claim or a case the passages do not cover, and passes the figures as a hint', async () => {
    const router = routerReplying(
      json({
        claims: [
          {
            text: 'You have 15 days.',
            verdict: 'unsupported',
            passages: [],
            note: 'The passage says thirty days.',
          },
          { text: 'Bring the receipt.', verdict: 'supported', passages: [1, 9], note: '' },
        ],
        applicability: { verdict: 'applies', reason: '' },
      }),
    );
    const r = await new AnswerVerifier(router, 'p', 'm').verify({
      question,
      answer: 'You have 15 days and must bring the receipt.',
      passages: PASSAGES,
    });
    expect(r.verdict).toBe('fail');
    expect(r.unmatchedNumbers).toEqual(['15']);
    expect(r.claims[1]!.passageIds).toEqual(['p1']); // out-of-range passage numbers are dropped
    const prompt = router.call.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).toContain('not found literally in the passages');
    expect(prompt).toContain('[2] Doc p2');

    const notApplicable = await new AnswerVerifier(
      routerReplying(
        json({
          claims: [],
          applicability: { verdict: 'does_not_apply', reason: 'The passage is about refunds.' },
        }),
      ),
      'p',
      'm',
    ).verify({ question, answer: 'Ask the manager.', passages: PASSAGES });
    expect(notApplicable.verdict).toBe('fail');
  });

  it('a partial claim with a figure no passage contains is unsupported', async () => {
    const r = await new AnswerVerifier(
      routerReplying(
        json({
          claims: [
            {
              text: 'Refunds over 300 need approval.',
              verdict: 'partial',
              passages: [2],
              note: '500 in the passage',
            },
          ],
          applicability: { verdict: 'applies', reason: '' },
        }),
      ),
      'p',
      'm',
    ).verify({ question: 'q', answer: 'Refunds over 300 need approval.', passages: PASSAGES });
    expect(r.claims[0]!.verdict).toBe('unsupported');
    expect(r.verdict).toBe('fail');
  });

  it('reports partial support and uncertain applicability as uncertain', async () => {
    const r = await new AnswerVerifier(
      routerReplying(
        json({
          claims: [
            {
              text: 'Any refund needs approval.',
              verdict: 'partial',
              passages: [2],
              note: 'Only over 500.',
            },
          ],
          applicability: { verdict: 'applies', reason: '' },
        }),
      ),
      'p',
      'm',
    ).verify({ question, answer: 'Any refund needs approval.', passages: PASSAGES });
    expect(r.verdict).toBe('uncertain');
  });

  it('never throws: provider errors, unreadable replies and timeouts are errors', async () => {
    const v = (reply: Parameters<typeof routerReplying>[0], timeoutMs?: number) =>
      new AnswerVerifier(routerReplying(reply), 'p', 'm', {
        ...(timeoutMs !== undefined && { timeoutMs }),
      }).verify({
        question,
        answer: 'x',
        passages: PASSAGES,
      });
    expect((await v(new Error('boom'))).error).toBe('boom');
    expect((await v({ content: 'no json here' })).verdict).toBe('error');
    const slow = await v(() => new Promise<never>(() => {}), 1000);
    expect(slow).toMatchObject({ verdict: 'error', error: 'verification timed out after 1000 ms' });
  });

  it('does not call the model for an empty answer or without passages', async () => {
    const router = routerReplying(json({}));
    const r = await new AnswerVerifier(router, 'p', 'm').verify({
      question,
      answer: '',
      passages: PASSAGES,
    });
    expect(r.verdict).toBe('pass');
    expect(router.call).not.toHaveBeenCalled();
  });
});

describe('policy, repair and notice', () => {
  const result = (over: Partial<VerificationResult>): VerificationResult => ({
    verdict: 'fail',
    claims: [
      { text: 'You have 15 days.', verdict: 'unsupported', passageIds: [], note: 'thirty days' },
    ],
    applicability: { verdict: 'applies' },
    unmatchedNumbers: [],
    model: 'm',
    latencyMs: 1,
    ...over,
  });

  it('decides with the policy defaults and after a repair', () => {
    expect(decideVerification(result({ verdict: 'pass', claims: [] }))).toBe('deliver');
    expect(decideVerification(result({}))).toBe('repair');
    expect(decideVerification(result({}), {}, true)).toBe('annotate');
    expect(decideVerification(result({}), { afterRepair: 'abstain' }, true)).toBe('abstain');
    expect(decideVerification(result({}), { onUnsupported: 'abstain' })).toBe('abstain');
    expect(
      decideVerification(
        result({ claims: [], applicability: { verdict: 'does_not_apply', reason: 'x' } }),
      ),
    ).toBe('annotate');
    expect(
      decideVerification(result({ verdict: 'uncertain', claims: [] }), { onUncertain: 'annotate' }),
    ).toBe('annotate');
    expect(decideVerification(result({ verdict: 'error', claims: [] }))).toBe('deliver');
  });

  it('builds the repair instruction and the user notice, in the host language if given', () => {
    expect(buildRepairInstruction(result({}))).toContain(
      '- (unsupported) You have 15 days. — thirty days',
    );
    expect(verificationNotice(result({}))).toBe(
      'Part of this answer could not be confirmed in the documents:\n- You have 15 days.',
    );
    expect(verificationNotice(result({}), { noticeUnsupported: 'No pude confirmar:' })).toMatch(
      /^No pude confirmar:/,
    );
    expect(verificationNotice(result({ verdict: 'pass', claims: [] }))).toBe('');
  });
});

describe('RAGPipeline.verifyAnswer', () => {
  const CONTEXT: ExecutionContext = {
    tenantId: 't',
    userId: 'u',
    roles: [],
    sessionId: 's',
    agentId: 'a',
    requestId: 'q',
  };

  it('records the tokens and emits the audit event; without a verifier it is an error', async () => {
    const router = routerReplying(
      json({
        claims: [{ text: 'c', verdict: 'supported', passages: [1], note: '' }],
        applicability: { verdict: 'applies', reason: '' },
      }),
    );
    const tokens = new TokenTracker();
    const record = vi.spyOn(tokens, 'record');
    const bus = new EventBus();
    const events: Record<string, unknown>[] = [];
    bus.on('rag.verification.end', (e) =>
      events.push((e as unknown as { data: Record<string, unknown> }).data),
    );
    const pipeline = new RAGPipeline(
      new EmbeddingRouter(),
      new InMemoryVectorStore(),
      undefined,
      bus,
      tokens,
      undefined,
      'require',
      {
        verification: {
          mode: 'blocking',
          verifier: new AnswerVerifier(router, 'prov', 'small'),
          policy: { onUnsupported: 'abstain' },
        },
      },
    );
    expect(pipeline.verification.mode).toBe('blocking');
    const r = await pipeline.verifyAnswer(
      { question: 'q', answer: 'a', passages: PASSAGES },
      CONTEXT,
    );
    expect(r.verdict).toBe('pass');
    expect(record).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ toolName: 'rag.verify', totalTokens: 380, model: 'small' }),
    );
    expect(events[0]).toMatchObject({ verdict: 'pass', claims: 1, unsupported: 0 });

    const bare = new RAGPipeline(
      new EmbeddingRouter(),
      new InMemoryVectorStore(),
      undefined,
      bus,
      tokens,
    );
    expect(
      (await bare.verifyAnswer({ question: 'q', answer: 'a', passages: PASSAGES }, CONTEXT))
        .verdict,
    ).toBe('error');
  });

  it('validates rag.verification', () => {
    expect(() =>
      ConfigLoader.from({ rag: { verification: { mode: 'sometimes' } } } as never),
    ).toThrow(/rag.verification.mode/);
    expect(() =>
      ConfigLoader.from({ rag: { verification: { onUnsupported: 'ignore' } } } as never),
    ).toThrow(/onUnsupported/);
  });
});
