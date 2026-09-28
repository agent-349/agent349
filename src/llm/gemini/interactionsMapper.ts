import { UnsupportedCapabilityError } from '../../errors/index.js';
import type {
  ContentBlock,
  ContentSource,
  LLMMessage,
  LLMRequest,
  MediaBlock,
  ToolDescriptor,
} from '../../types/index.js';
import type { ContentResolver, ResolvedContent } from '../ContentResolver.js';
import { describeOmitted, isMediaBlock } from '../../content/index.js';
import type {
  InteractionBlock,
  InteractionCreateBody,
  InteractionFunctionTool,
  InteractionMediaContent,
  InteractionResponseFormat,
  InteractionTextContent,
} from './wire.js';

/**
 * Key under which a Gemini thought signature travels inside a block's
 * `providerData`, so a stateless multi-turn conversation can replay it.
 */
export const THOUGHT_SIGNATURE_KEY = 'geminiThoughtSignature';

/**
 * Builds the body of an Interactions request from a normalised
 * {@link LLMRequest}.
 *
 * Conversation state is never delegated to Google: `store` is hard-wired to
 * `false` and the full history is replayed as `input` blocks, so Agent349's
 * own memory, audit and governance stay authoritative. That replay includes the
 * `thought` steps the model returned earlier — Gemini rejects a stateless
 * tool-calling history whose thought signatures are missing.
 *
 * @param request  - The normalised request.
 * @param resolver - Resolver that turns content sources into wire transports.
 * @returns The request body, ready to POST.
 */
export async function toInteractionBody(
  request: LLMRequest,
  resolver: ContentResolver,
): Promise<InteractionCreateBody> {
  const options = request.providerOptions?.gemini;

  const generationConfig: Record<string, unknown> = {
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxTokens !== undefined && { max_output_tokens: request.maxTokens }),
    ...(options?.thinkingLevel !== undefined && { thinking_level: options.thinkingLevel }),
    ...(options?.mediaResolution !== undefined && { media_resolution: options.mediaResolution }),
  };

  const body: InteractionCreateBody = {
    model: request.model,
    input: await toInteractionInput(request, resolver),
    store: false,
    ...(request.systemPrompt !== '' && { system_instruction: request.systemPrompt }),
    ...(request.tools !== undefined &&
      request.tools.length > 0 && { tools: toInteractionTools(request.tools) }),
    ...(request.responseFormat !== undefined && {
      response_format: toInteractionResponseFormat(request.responseFormat),
    }),
    ...(Object.keys(generationConfig).length > 0 && { generation_config: generationConfig }),
    ...(options?.safetySettings !== undefined && { safety_settings: options.safetySettings }),
    ...(options?.serviceTier !== undefined && { service_tier: options.serviceTier }),
    ...(options?.labels !== undefined && { labels: options.labels }),
  };

  // Escape hatch, merged last so it can reach fields the SDK does not model
  // yet. Deliberately unvalidated — `store` stays false regardless.
  return { ...body, ...(options?.raw ?? {}), store: false };
}

/** Maps the SDK's {@link ResponseFormat} onto an Interactions `response_format`. */
export function toInteractionResponseFormat(
  format: NonNullable<LLMRequest['responseFormat']>,
): InteractionResponseFormat {
  return {
    type: 'text',
    mime_type: 'application/json',
    ...(format.type === 'json_schema' && format.schema !== undefined && { schema: format.schema }),
  };
}

/** Maps SDK tool descriptors onto Interactions function declarations. */
export function toInteractionTools(tools: ToolDescriptor[]): InteractionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

/**
 * Flattens the conversation into the `input` block list.
 *
 * Gemini's stateless mode takes one flat sequence rather than role-tagged
 * messages: past user turns become `user_input`, past assistant turns become
 * `model_output` (plus their `thought` and `function_call` steps), and tool
 * results become `function_result`.
 */
async function toInteractionInput(
  request: LLMRequest,
  resolver: ContentResolver,
): Promise<InteractionBlock[]> {
  const blocks: InteractionBlock[] = [];
  const messages = request.messages;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      blocks.push(toFunctionResult(msg));
      continue;
    }

    if (msg.role === 'assistant') {
      blocks.push(...toAssistantBlocks(msg));
      continue;
    }

    // user
    const contentBlocks = await toContentBlocks(msg, request, resolver);
    if (i === messages.length - 1) {
      // The live turn is passed as bare content blocks.
      blocks.push(...contentBlocks);
    } else {
      blocks.push({ type: 'user_input', content: contentBlocks });
    }
  }

  return blocks;
}

/** Converts a tool-result message into a `function_result` block. */
function toFunctionResult(msg: LLMMessage): InteractionBlock {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return {
    type: 'function_result',
    call_id: msg.toolCallId ?? '',
    ...(msg.name !== undefined && { name: msg.name }),
    result: [{ type: 'text', text: content }],
  };
}

/**
 * Converts an assistant turn into the steps Gemini expects back.
 *
 * Thought signatures captured on the previous response are replayed first: they
 * are opaque to the SDK but mandatory for the model to accept the history.
 */
function toAssistantBlocks(msg: LLMMessage): InteractionBlock[] {
  if (typeof msg.content === 'string') {
    return [{ type: 'model_output', content: [{ type: 'text', text: msg.content }] }];
  }

  const out: InteractionBlock[] = [];
  const textParts: InteractionTextContent[] = [];

  for (const block of msg.content) {
    const signature = readThoughtSignature(block);
    if (signature !== undefined) {
      out.push({ type: 'thought', signature });
    }
    if (block.type === 'text' && block.text !== '') {
      textParts.push({ type: 'text', text: block.text });
    }
  }

  if (textParts.length > 0) {
    out.push({ type: 'model_output', content: textParts });
  }

  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      out.push({
        type: 'function_call',
        id: block.toolUseId,
        name: block.toolName,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return out;
}

/** Reads a stored Gemini thought signature from a block, if present. */
function readThoughtSignature(block: ContentBlock): string | undefined {
  if (block.type !== 'text' && block.type !== 'tool_use') return undefined;
  const value = block.providerData?.[THOUGHT_SIGNATURE_KEY];
  return typeof value === 'string' ? value : undefined;
}

/** Converts one message's body into Interactions content blocks. */
async function toContentBlocks(
  msg: LLMMessage,
  request: LLMRequest,
  resolver: ContentResolver,
): Promise<Array<InteractionTextContent | InteractionMediaContent>> {
  if (typeof msg.content === 'string') {
    return [{ type: 'text', text: msg.content }];
  }

  const out: Array<InteractionTextContent | InteractionMediaContent> = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'media_omitted') {
      out.push({ type: 'text', text: describeOmitted(block) });
      continue;
    }
    if (!isMediaBlock(block)) continue;

    const resolved = await resolver.resolve(block, request.fileHandling ?? 'inline');
    out.push(toMediaContent(block, resolved));
  }
  return out;
}

/** Builds an Interactions media block from resolved content. */
function toMediaContent(block: MediaBlock, resolved: ResolvedContent): InteractionMediaContent {
  const resolution = block.options?.mediaResolution;
  const base = {
    type: block.type,
    ...(resolution !== undefined && block.type === 'image' && { resolution }),
  };

  if (resolved.kind === 'inline') {
    return { ...base, data: resolved.base64, mime_type: resolved.mimeType };
  }
  if (resolved.kind === 'url') {
    return {
      ...base,
      uri: resolved.url,
      ...(resolved.mimeType !== undefined && { mime_type: resolved.mimeType }),
    };
  }
  return {
    ...base,
    uri: resolved.ref.fileId,
    ...(resolved.ref.mimeType !== undefined && { mime_type: resolved.ref.mimeType }),
  };
}

/**
 * Rejects a content source Gemini cannot serve with a message that says what to
 * do instead. Used by the batch mapper, where fewer sources are available.
 *
 * @param provider - Provider instance name.
 * @param source   - The offending source.
 * @param model    - Model the request targets.
 */
export function rejectSource(provider: string, source: ContentSource, model: string): never {
  throw new UnsupportedCapabilityError(
    provider,
    `sources.${source.kind}`,
    `this content source cannot be used here`,
    model,
  );
}
