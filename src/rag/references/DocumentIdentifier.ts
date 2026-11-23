import type { JSONSchema, LLMRequest, LLMResponse, ProviderProbe } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import { fromRoman } from '../legal/LegalProfile.js';
import type { LegalProfile } from '../legal/LegalProfile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options of {@link DocumentIdentifier}. */
export interface DocumentIdentifierOptions {
  /** Characters of the beginning of the text sent to the model. Default: 2000. */
  maxChars?: number;
  /** Reasoning effort of the call. Default `'low'`; `null` sends none. */
  reasoningEffort?: LLMRequest['reasoningEffort'] | null;
  /** Abort after this many milliseconds. Default: 20000. */
  timeoutMs?: number;
}

/** Result of {@link DocumentIdentifier.identify}. */
export interface ModelIdentityResult {
  /** The document's own designation, or undefined when it is not a norm or the model found none. */
  identity?: { key: string; label: string };
  /** Provider error, timeout or unreadable reply. */
  error?: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You identify which legal or administrative document a text is, from its title and its beginning: the document's OWN designation (its kind, number and year), as it names itself in its heading.
- Ignore norms the text only cites (in its preamble, recitals or body: "having regard to", "VISTO", "en uso de las facultades conferidas por la Ley…"). They are other documents.
- An annex or appendix is identified as the annex (kind "annex" and its number), not as the norm it belongs to.
- If the text is not a numbered norm, decree, law, regulation, resolution, circular, directive, ordinance or annex — for example a manual, a procedure, a form, a letter — or its number is not stated, answer with kind null.
- Never invent a number or a year. Copy them as written.`;

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    kind: { type: ['string', 'null'] },
    number: { type: ['string', 'null'] },
    year: { type: ['string', 'null'] },
    label: { type: ['string', 'null'] },
  },
  required: ['kind', 'number', 'year', 'label'],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// DocumentIdentifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asks a model for a document's own designation when its title and heading
 * give none (a scanned norm uploaded as "scan_0012.pdf", a heading the
 * language profile does not recognise). The kinds are limited to those of
 * the legal profile and the key is normalised by it, so a model identity
 * matches the keys of references and relations exactly.
 *
 * A model can be wrong: hosts should treat its identity as deduced — use it
 * to match and propose, not to confirm relations automatically. Never throws.
 */
export class DocumentIdentifier {
  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #profile: LegalProfile;
  readonly #maxChars: number;
  readonly #reasoningEffort: LLMRequest['reasoningEffort'] | null;
  readonly #timeoutMs: number;

  /**
   * @param router   - LLM router instance.
   * @param provider - Provider instance name registered in the router.
   * @param model    - Model identifier (a small model is enough).
   * @param profile  - Legal language profile: allowed kinds and key normalisation.
   */
  constructor(
    router: LLMRouter,
    provider: string,
    model: string,
    profile: LegalProfile,
    options: DocumentIdentifierOptions = {},
  ) {
    this.#router = router;
    this.#provider = provider;
    this.#model = model;
    this.#profile = profile;
    this.#maxChars = Math.max(300, options.maxChars ?? 2000);
    this.#reasoningEffort = options.reasoningEffort === undefined ? 'low' : options.reasoningEffort;
    this.#timeoutMs = Math.max(1000, options.timeoutMs ?? 20000);
  }

  get provider(): string {
    return this.#provider;
  }

  get model(): string {
    return this.#model;
  }

  /**
   * The document's own designation, as a key of the legal profile.
   *
   * @param title - Document title or file name.
   * @param text  - Document text (only its beginning is sent).
   */
  async identify(title: string, text: string): Promise<ModelIdentityResult> {
    const start = Date.now();
    const base = { model: this.#model };
    if (text.trim() === '' && title.trim() === '') return { ...base, latencyMs: 0 };
    let response: LLMResponse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        this.#router.call(this.#request(title, text), this.#provider),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`identification timed out after ${this.#timeoutMs} ms`)),
            this.#timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      return {
        ...base,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
    const raw = parse(response);
    if (raw === undefined) {
      return {
        ...base,
        error:
          `model '${this.#model}' did not return an identification` +
          (response.stopReason === 'max_tokens' ? ' (the reply hit the token limit)' : ''),
        latencyMs: Date.now() - start,
        ...usage,
      };
    }
    const identity = this.#toKey(raw);
    return {
      ...base,
      ...(identity !== undefined && { identity }),
      latencyMs: Date.now() - start,
      ...usage,
    };
  }

  /** Identifies a probe heading; succeeds when the model returns a reply. For startup checks. */
  async validate(): Promise<ProviderProbe> {
    const r = await this.identify(
      'probe.pdf',
      'DECREE No. 120/2015\nThe President of the Republic, having regard to Law 1234,\nDECREES:\nArticle 1. …',
    );
    return r.error !== undefined ? { ok: false, error: r.error } : { ok: true };
  }

  /** A model reply → a profile key, or undefined when it is not a valid designation. */
  #toKey(raw: RawIdentity): { key: string; label: string } | undefined {
    const kind = (raw.kind ?? '').trim().toLowerCase();
    const number = (raw.number ?? '').trim();
    if (kind === '' || number === '' || !this.#profile.kinds().includes(kind)) return undefined;
    let id: string | undefined;
    if (kind === 'annex') {
      const n = /^\d{1,4}$/.test(number) ? Number(number) : fromRoman(number);
      id = n !== undefined ? String(n) : undefined;
    } else {
      const year = (raw.year ?? '').trim();
      const written =
        /^\d{2,4}$/.test(year) && !new RegExp(`[/-]\\s*${year}$`).test(number)
          ? `${number}/${year}`
          : number;
      id = this.#profile.normaliseNumber(written.replace(/^(?:n[°º.]?|no\.?|nº)\s*/i, ''));
    }
    if (id === undefined || id === '') return undefined;
    const label = (raw.label ?? '').trim() || `${kind} ${number}`;
    return { key: `${kind}:${id}`, label: label.slice(0, 120) };
  }

  #request(title: string, text: string): LLMRequest {
    const structured = this.#structured();
    const kinds = this.#profile.kinds().join(', ');
    return {
      model: this.#model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Allowed kinds: ${kinds}.\n\nTITLE: ${title}\n\nBEGINNING OF THE TEXT:\n${text.slice(0, this.#maxChars)}` +
            (structured
              ? ''
              : '\n\nReply with ONLY a JSON object: {"kind","number","year","label"} (null when unknown).'),
        },
      ],
      temperature: 0,
      maxTokens:
        this.#reasoningEffort === 'minimal' || this.#reasoningEffort === 'none' ? 200 : 2000,
      ...(this.#reasoningEffort !== null &&
        this.#reasoningEffort !== undefined && { reasoningEffort: this.#reasoningEffort }),
      ...(structured && {
        responseFormat: {
          type: 'json_schema' as const,
          name: 'document_identity',
          schema: SCHEMA,
          strict: true,
        },
      }),
    };
  }

  #structured(): boolean {
    try {
      return (
        this.#router.getProvider(this.#provider)?.capabilities(this.#model).structuredOutput ===
        'jsonSchema'
      );
    } catch {
      return false;
    }
  }
}

interface RawIdentity {
  kind: string | null;
  number: string | null;
  year: string | null;
  label: string | null;
}

function parse(response: LLMResponse): RawIdentity | undefined {
  let value: unknown = response.structured?.parsed === true ? response.structured.value : undefined;
  if (value === undefined) {
    const match = response.content.trim().match(/\{[\s\S]*\}/);
    if (match === null) return undefined;
    try {
      value = JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string | null =>
    typeof x === 'string' ? x : typeof x === 'number' ? String(x) : null;
  return {
    kind: str(v['kind']),
    number: str(v['number']),
    year: str(v['year']),
    label: str(v['label']),
  };
}
