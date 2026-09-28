/**
 * The Gemini provider speaks two Google surfaces — Interactions for
 * synchronous calls, generateContent for batch jobs — from a single
 * {@link LLMRequest}. These tests pin the semantics that must hold on both, so
 * a document processed one at a time and the same document processed in a batch
 * cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { ContentResolver } from '../../../src/llm/ContentResolver.js';
import { toInteractionBody } from '../../../src/llm/gemini/interactionsMapper.js';
import { toGenerateContentRequest } from '../../../src/llm/gemini/generateContentMapper.js';
import { documentFromBytes, text } from '../../../src/content/index.js';
import type { LLMRequest, ProviderCapabilities } from '../../../src/types/index.js';

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  input: { text: true, image: true, document: true, audio: true, video: true },
  sources: { url: true, providerFile: true },
  structuredOutput: 'jsonSchema',
  structuredOutputWithTools: true,
  files: true,
  batch: true,
};

function resolver(): ContentResolver {
  return new ContentResolver({
    provider: 'gemini',
    providerType: 'gemini',
    capabilities: CAPABILITIES,
    model: 'gemini-flash-latest',
  });
}

const SCHEMA = { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] };
const PDF = new Uint8Array([1, 2, 3]);
const PDF_B64 = Buffer.from(PDF).toString('base64');

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'gemini-flash-latest',
    systemPrompt: 'Extract invoice data.',
    messages: [
      {
        role: 'user',
        content: [text('extract'), documentFromBytes(PDF, 'application/pdf')],
      },
    ],
    responseFormat: { type: 'json_schema', schema: SCHEMA },
    temperature: 0,
    maxTokens: 1024,
    ...overrides,
  };
}

describe('surface parity', () => {
  it('carries the system prompt on both surfaces', async () => {
    const interaction = await toInteractionBody(request(), resolver());
    const generate = await toGenerateContentRequest(request(), 'gemini', resolver());

    expect(interaction.system_instruction).toBe('Extract invoice data.');
    expect(generate.systemInstruction).toEqual({ parts: [{ text: 'Extract invoice data.' }] });
  });

  it('carries the same document bytes on both surfaces', async () => {
    const interaction = await toInteractionBody(request(), resolver());
    const generate = await toGenerateContentRequest(request(), 'gemini', resolver());

    expect(interaction.input).toContainEqual({
      type: 'document',
      data: PDF_B64,
      mime_type: 'application/pdf',
    });
    expect(generate.contents[0]!.parts).toContainEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF_B64 },
    });
  });

  it('requests the same JSON schema on both surfaces', async () => {
    const interaction = await toInteractionBody(request(), resolver());
    const generate = await toGenerateContentRequest(request(), 'gemini', resolver());

    expect(interaction.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: SCHEMA,
    });
    expect(generate.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
    });
  });

  it('carries sampling parameters on both surfaces', async () => {
    const interaction = await toInteractionBody(request(), resolver());
    const generate = await toGenerateContentRequest(request(), 'gemini', resolver());

    expect(interaction.generation_config).toMatchObject({
      temperature: 0,
      max_output_tokens: 1024,
    });
    expect(generate.generationConfig).toMatchObject({
      temperature: 0,
      maxOutputTokens: 1024,
    });
  });

  it('declares tools on both surfaces', async () => {
    const withTools = request({
      tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }],
    });
    const interaction = await toInteractionBody(withTools, resolver());
    const generate = await toGenerateContentRequest(withTools, 'gemini', resolver());

    expect(interaction.tools).toEqual([
      { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' } },
    ]);
    expect(generate.tools?.[0]?.functionDeclarations).toEqual([
      { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' } },
    ]);
  });

  it('carries options both surfaces understand', async () => {
    const withOptions = request({ providerOptions: { gemini: { thinkingLevel: 'high' } } });
    const interaction = await toInteractionBody(withOptions, resolver());
    const generate = await toGenerateContentRequest(withOptions, 'gemini', resolver());

    expect(interaction.generation_config).toMatchObject({ thinking_level: 'high' });
    expect(generate.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'high' },
    });
  });
});

describe('surface differences are explicit, never silent', () => {
  it('accepts an Interactions-only option on the synchronous surface', async () => {
    const body = await toInteractionBody(
      request({ providerOptions: { gemini: { serviceTier: 'flex' } } }),
      resolver(),
    );
    expect(body.service_tier).toBe('flex');
  });

  it('refuses the same option on the batch surface, naming it', async () => {
    await expect(
      toGenerateContentRequest(
        request({ providerOptions: { gemini: { serviceTier: 'flex' } } }),
        'gemini',
        resolver(),
      ),
    ).rejects.toThrow(/serviceTier/);
  });

  it('refuses labels on the batch surface', async () => {
    await expect(
      toGenerateContentRequest(
        request({ providerOptions: { gemini: { labels: { a: 'b' } } } }),
        'gemini',
        resolver(),
      ),
    ).rejects.toThrow(/only available on synchronous calls/);
  });
});

describe('conversation shape', () => {
  it('never delegates state to the provider', async () => {
    const body = await toInteractionBody(request(), resolver());
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('previous_interaction_id');
  });

  it('replays prior user turns as user_input and the live turn as bare blocks', async () => {
    const body = await toInteractionBody(
      request({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'second' },
        ],
      }),
      resolver(),
    );

    expect(body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'first' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'answer' }] },
      { type: 'text', text: 'second' },
    ]);
  });

  it('maps a tool result to a function_result block', async () => {
    const body = await toInteractionBody(
      request({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', toolCallId: 'call_1', name: 'lookup', content: '{"ok":true}' },
        ],
      }),
      resolver(),
    );

    expect(body.input).toContainEqual({
      type: 'function_result',
      call_id: 'call_1',
      name: 'lookup',
      result: [{ type: 'text', text: '{"ok":true}' }],
    });
  });

  it('merges consecutive same-role turns on the generateContent surface', async () => {
    const generate = await toGenerateContentRequest(
      request({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      }),
      'gemini',
      resolver(),
    );

    expect(generate.contents).toHaveLength(1);
    expect(generate.contents[0]!.parts).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('puts a tool result in a user turn on the generateContent surface', async () => {
    const generate = await toGenerateContentRequest(
      request({
        messages: [
          { role: 'assistant', content: 'thinking' },
          { role: 'tool', toolCallId: 'c1', name: 'lookup', content: 'result' },
        ],
      }),
      'gemini',
      resolver(),
    );

    expect(generate.contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'lookup', response: { output: 'result' } } }],
    });
  });
});
