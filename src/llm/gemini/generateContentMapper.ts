import { UnsupportedCapabilityError } from '../../errors/index.js';
import type { LLMMessage, LLMRequest, MediaBlock } from '../../types/index.js';
import type { ContentResolver, ResolvedContent } from '../ContentResolver.js';
import { describeOmitted, isMediaBlock } from '../../content/index.js';
import { THOUGHT_SIGNATURE_KEY } from './interactionsMapper.js';
import type { GeminiContent, GeminiPart, GenerateContentRequest } from './wire.js';

/**
 * Options that only the Interactions surface understands.
 *
 * The Batch API accepts `GenerateContentRequest` objects exclusively, so a
 * request carrying one of these cannot be batched. Rather than dropping it
 * silently — which would change the meaning of the job without telling anyone —
 * the mapper raises {@link UnsupportedCapabilityError} naming the option.
 */
const INTERACTIONS_ONLY_OPTIONS = ['serviceTier', 'labels'] as const;

/**
 * Builds a `GenerateContentRequest` from a normalised {@link LLMRequest}.
 *
 * This is the batch path: Gemini's Batch API runs `generateContent` only. The
 * content, tools and structured-output abstractions are the same ones a
 * synchronous call uses — only the wire format and the lifecycle differ.
 *
 * @param request  - The normalised request.
 * @param provider - Provider instance name (for errors).
 * @param resolver - Resolver that turns content sources into wire transports.
 */
export async function toGenerateContentRequest(
  request: LLMRequest,
  provider: string,
  resolver: ContentResolver,
): Promise<GenerateContentRequest> {
  const options = request.providerOptions?.gemini;

  for (const key of INTERACTIONS_ONLY_OPTIONS) {
    if (options?.[key] !== undefined) {
      throw new UnsupportedCapabilityError(
        provider,
        `batch.providerOptions.gemini.${key}`,
        `'${key}' is only available on synchronous calls. Gemini's Batch API ` +
          `accepts generateContent requests, which do not carry this option.`,
        request.model,
      );
    }
  }

  const generationConfig: Record<string, unknown> = {
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
    ...(options?.thinkingLevel !== undefined && {
      thinkingConfig: { thinkingLevel: options.thinkingLevel },
    }),
    ...(options?.mediaResolution !== undefined && {
      mediaResolution: options.mediaResolution,
    }),
    ...(request.responseFormat !== undefined && {
      responseMimeType: 'application/json',
      ...(request.responseFormat.type === 'json_schema' &&
        request.responseFormat.schema !== undefined && {
          responseJsonSchema: request.responseFormat.schema,
        }),
    }),
  };

  return {
    contents: await toContents(request, resolver),
    ...(request.systemPrompt !== '' && {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
    }),
    ...(request.tools !== undefined &&
      request.tools.length > 0 && {
        tools: [
          {
            functionDeclarations: request.tools.map((tool) => ({
              type: 'function' as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ],
      }),
    ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    ...(options?.safetySettings !== undefined && { safetySettings: options.safetySettings }),
  };
}

/** Converts the conversation into `contents[]`, merging consecutive same-role turns. */
async function toContents(
  request: LLMRequest,
  resolver: ContentResolver,
): Promise<GeminiContent[]> {
  const contents: GeminiContent[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      // Gemini carries function responses in a user turn, like Claude.
      appendParts(contents, 'user', [
        {
          functionResponse: {
            ...(msg.toolCallId !== undefined && { id: msg.toolCallId }),
            name: msg.name ?? 'tool',
            response: {
              output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            },
          },
        },
      ]);
      continue;
    }

    if (msg.role === 'assistant') {
      appendParts(contents, 'model', toModelParts(msg));
      continue;
    }

    appendParts(contents, 'user', await toUserParts(msg, request, resolver));
  }

  return contents;
}

/** Appends parts to the last turn of the same role, or starts a new turn. */
function appendParts(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  if (last !== undefined && last.role === role) {
    last.parts.push(...parts);
    return;
  }
  contents.push({ role, parts });
}

/** Converts an assistant turn into model parts, preserving thought signatures. */
function toModelParts(msg: LLMMessage): GeminiPart[] {
  if (typeof msg.content === 'string') {
    return msg.content === '' ? [] : [{ text: msg.content }];
  }

  const parts: GeminiPart[] = [];
  for (const block of msg.content) {
    const signature =
      block.type === 'text' || block.type === 'tool_use'
        ? block.providerData?.[THOUGHT_SIGNATURE_KEY]
        : undefined;

    if (block.type === 'text' && block.text !== '') {
      parts.push({
        text: block.text,
        ...(typeof signature === 'string' && { thoughtSignature: signature }),
      });
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          id: block.toolUseId,
          name: block.toolName,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
        ...(typeof signature === 'string' && { thoughtSignature: signature }),
      });
    }
  }
  return parts;
}

/** Converts a user turn into parts, resolving any media it carries. */
async function toUserParts(
  msg: LLMMessage,
  request: LLMRequest,
  resolver: ContentResolver,
): Promise<GeminiPart[]> {
  if (typeof msg.content === 'string') {
    return [{ text: msg.content }];
  }

  const parts: GeminiPart[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
      continue;
    }
    if (block.type === 'media_omitted') {
      parts.push({ text: describeOmitted(block) });
      continue;
    }
    if (!isMediaBlock(block)) continue;

    const resolved = await resolver.resolve(block, request.fileHandling ?? 'inline');
    parts.push(toMediaPart(block, resolved));
  }
  return parts;
}

/** Builds an `inlineData` or `fileData` part from resolved content. */
function toMediaPart(block: MediaBlock, resolved: ResolvedContent): GeminiPart {
  if (resolved.kind === 'inline') {
    return { inlineData: { mimeType: resolved.mimeType, data: resolved.base64 } };
  }
  if (resolved.kind === 'url') {
    return {
      fileData: {
        fileUri: resolved.url,
        ...(resolved.mimeType !== undefined && { mimeType: resolved.mimeType }),
      },
    };
  }
  return {
    fileData: {
      fileUri: resolved.ref.fileId,
      ...(resolved.ref.mimeType !== undefined && { mimeType: resolved.ref.mimeType }),
    },
  };
}
