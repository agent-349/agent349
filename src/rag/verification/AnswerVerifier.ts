import type { JSONSchema, LLMRequest, LLMResponse, ProviderProbe } from '../../types/index.js';
import type { LLMRouter } from '../../llm/LLMRouter.js';
import type { Passage } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** What to do with an answer, after verification. */
export type VerificationAction = 'deliver' | 'repair' | 'annotate' | 'abstain';

/** How a host reacts to each verification outcome (`rag.verification`). */
export interface VerificationPolicy {
  /** Claims without support, or contradicted. Default: `'repair'`. */
  onUnsupported?: 'repair' | 'annotate' | 'abstain';
  /** The passages cover a different case than the one asked. Default: `'annotate'`. */
  onNotApplicable?: 'annotate' | 'abstain';
  /** Partial support or uncertain applicability. Default: `'deliver'`. */
  onUncertain?: 'deliver' | 'annotate' | 'abstain';
  /** The verifier failed (provider error, timeout, unreadable reply). Default: `'deliver'`. */
  onError?: 'deliver' | 'annotate' | 'abstain';
  /** A repaired answer that still fails. Default: `'annotate'`. */
  afterRepair?: 'annotate' | 'abstain';
}

/** Options of {@link AnswerVerifier}. */
export interface AnswerVerifierOptions {
  /** Most claims checked per answer. Default: 12. */
  maxClaims?: number;
  /**
   * Characters of each passage sent to the verifier. Default: the whole
   * passage — the verifier must see the same text the synthesis saw, or it
   * flags as unsupported what is in the part it did not receive. Set it only
   * to cap very long passages.
   */
  maxPassageChars?: number;
  /** Reasoning effort of the verification call. Default `'low'`; `null` sends none. */
  reasoningEffort?: LLMRequest['reasoningEffort'] | null;
  /** Abort the verification after this many milliseconds (then `verdict: 'error'`). Default: 20000. */
  timeoutMs?: number;
}

/** What is verified: the question, the answer and the passages it was based on. */
export interface VerificationInput {
  question: string;
  answer: string;
  passages: Passage[];
}

/** One claim of the answer and what the passages say about it. */
export interface VerifiedClaim {
  text: string;
  verdict: 'supported' | 'partial' | 'unsupported' | 'contradicted';
  /** Ids of the passages that support (or contradict) it. */
  passageIds: string[];
  /** Short explanation (English), for diagnostics. */
  note?: string;
}

/** Result of a verification. */
export interface VerificationResult {
  /**
   * `pass` — every claim is supported and the passages apply to the case;
   * `fail` — a claim is unsupported or contradicted, or the passages do not
   * apply; `uncertain` — partial support or uncertain applicability;
   * `error` — the verifier could not decide.
   */
  verdict: 'pass' | 'fail' | 'uncertain' | 'error';
  claims: VerifiedClaim[];
  applicability: { verdict: 'applies' | 'does_not_apply' | 'uncertain'; reason?: string };
  /** Figures of the answer (numbers, amounts, dates) not found literally in the passages. */
  unmatchedNumbers: string[];
  /** Provider error, timeout or parse failure (`verdict: 'error'`). */
  error?: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You check an answer against the source passages it was based on. You never rewrite or improve the answer.

1. Split the answer into its factual claims: every statement a reader could rely on or act on — facts, figures, amounts, dates, deadlines, steps, conditions, obligations, prohibitions, who does what. Skip greetings, citations of sources, and statements that only say some information is not available.
2. For each claim, decide:
   - supported: a passage states it, or it follows directly from a passage. Paraphrase, summary and translation are fine.
   - partial: a passage supports part of it, but the claim adds, generalises or strengthens something (a condition, a step, a scope, a figure).
   - unsupported: no passage states it.
   - contradicted: a passage states otherwise.
   An added number, deadline, condition, step or scope that no passage contains makes a claim partial or unsupported, however plausible it is. A figure that differs from the passage's figure for the same thing (an amount, a size, a deadline, a percentage) makes the claim contradicted.
3. Applicability: decide whether what the passages describe applies to the situation of the question — the same kind of case, operation, person or period. If the passages describe a different case than the one asked (another product, another kind of operation, another role, a rule no longer in force), it does not apply.

Passages are numbered [1], [2]…; cite them by number. Write each claim in the language of the answer, close to its wording. Write notes and reasons briefly, in English.`;

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['supported', 'partial', 'unsupported', 'contradicted'],
          },
          passages: { type: 'array', items: { type: 'integer' } },
          note: { type: 'string' },
        },
        required: ['text', 'verdict', 'passages', 'note'],
        additionalProperties: false,
      },
    },
    applicability: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['applies', 'does_not_apply', 'uncertain'] },
        reason: { type: 'string' },
      },
      required: ['verdict', 'reason'],
      additionalProperties: false,
    },
  },
  required: ['claims', 'applicability'],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Figures in a text: "15", "32 mm", "1.500", "29/01/2020", "3,5%" → digit strings ("15", "1500", "29012020", "35"). */
function figures(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\d[\d.,/:-]*\d|\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    // Single digits are too common (list markers, "1 vez") to be a useful signal.
    if (digits.length < 2) continue;
    if (!out.has(digits)) out.set(digits, m[0]);
  }
  return out;
}

/**
 * Figures of the answer that do not appear in any passage (compared by their
 * digits, so "1.500" matches "1500" and "29/01/2020" matches "29-01-2020").
 * A signal for the verifier, not a verdict: passages may spell numbers out.
 */
export function unmatchedNumbers(answer: string, passages: Passage[]): string[] {
  const known = new Set<string>();
  for (const p of passages) for (const d of figures(p.content).keys()) known.add(d);
  return [...figures(answer)].filter(([d]) => !known.has(d)).map(([, raw]) => raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// AnswerVerifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks a generated answer against the passages it was based on: whether
 * each claim is supported, whether the passages apply to the case asked, and
 * whether the figures of the answer appear in the passages.
 *
 * Retrieval can bring the right passage and the answer still add a figure,
 * a condition or a step the passage does not contain, or apply a rule to a
 * case it does not cover. A second, cheaper model call catches most of it;
 * the host decides what to do with each outcome ({@link decideVerification}).
 * Never throws: a failed check returns `verdict: 'error'`.
 */
export class AnswerVerifier {
  readonly #router: LLMRouter;
  readonly #provider: string;
  readonly #model: string;
  readonly #maxClaims: number;
  readonly #maxPassageChars: number | undefined;
  readonly #reasoningEffort: LLMRequest['reasoningEffort'] | null;
  readonly #timeoutMs: number;

  /**
   * @param router   - LLM router instance.
   * @param provider - Provider instance name registered in the router.
   * @param model    - Model identifier (a small model is usually enough).
   */
  constructor(
    router: LLMRouter,
    provider: string,
    model: string,
    options: AnswerVerifierOptions = {},
  ) {
    this.#router = router;
    this.#provider = provider;
    this.#model = model;
    this.#maxClaims = Math.min(30, Math.max(1, Math.floor(options.maxClaims ?? 12)));
    this.#maxPassageChars =
      options.maxPassageChars === undefined ? undefined : Math.max(200, options.maxPassageChars);
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
   * Verifies `input.answer`. An empty answer or one without passages is not
   * checked (`pass`, no claims).
   */
  async verify(input: VerificationInput): Promise<VerificationResult> {
    const start = Date.now();
    const base = { model: this.#model, claims: [] as VerifiedClaim[] };
    const numbers = unmatchedNumbers(input.answer, input.passages);
    if (input.answer.trim() === '' || input.passages.length === 0) {
      return {
        ...base,
        verdict: 'pass',
        applicability: { verdict: 'applies' },
        unmatchedNumbers: [],
        latencyMs: 0,
      };
    }
    let response: LLMResponse;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        this.#router.call(this.#request(input, numbers), this.#provider),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`verification timed out after ${this.#timeoutMs} ms`)),
            this.#timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      return {
        ...base,
        verdict: 'error',
        applicability: { verdict: 'uncertain' },
        unmatchedNumbers: numbers,
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
    const parsed = parse(response);
    if (parsed === undefined) {
      return {
        ...base,
        verdict: 'error',
        applicability: { verdict: 'uncertain' },
        unmatchedNumbers: numbers,
        error:
          `model '${this.#model}' did not return a verification` +
          (response.stopReason === 'max_tokens' ? ' (the reply hit the token limit)' : ''),
        latencyMs: Date.now() - start,
        ...usage,
      };
    }
    // A partial claim with a figure that no passage contains is not partly
    // right: the figure is invented or wrong ("20 mm" where the passage says 32).
    const missing = new Set(numbers.map((n) => n.replace(/\D/g, '')));
    const hasMissingFigure = (text: string): boolean =>
      [...text.matchAll(/\d[\d.,/:-]*\d|\d/g)].some((m) => missing.has(m[0].replace(/\D/g, '')));
    const claims: VerifiedClaim[] = parsed.claims.slice(0, this.#maxClaims).map((c) => ({
      text: c.text,
      verdict: c.verdict === 'partial' && hasMissingFigure(c.text) ? 'unsupported' : c.verdict,
      passageIds: c.passages
        .filter((i) => Number.isInteger(i) && i >= 1 && i <= input.passages.length)
        .map((i) => input.passages[i - 1]!.id),
      ...(c.note !== '' && { note: c.note }),
    }));
    const applicability = {
      verdict: parsed.applicability.verdict,
      ...(parsed.applicability.reason !== '' && { reason: parsed.applicability.reason }),
    };
    const failed =
      claims.some((c) => c.verdict === 'unsupported' || c.verdict === 'contradicted') ||
      applicability.verdict === 'does_not_apply';
    const doubtful =
      claims.some((c) => c.verdict === 'partial') || applicability.verdict === 'uncertain';
    return {
      ...base,
      verdict: failed ? 'fail' : doubtful ? 'uncertain' : 'pass',
      claims,
      applicability,
      unmatchedNumbers: numbers,
      latencyMs: Date.now() - start,
      ...usage,
    };
  }

  /** Verifies a probe answer; succeeds when the verifier returns a decision. For startup checks. */
  async validate(): Promise<ProviderProbe> {
    const r = await this.verify({
      question: 'How many days do I have to file a claim?',
      answer: 'You have 30 days to file a claim.',
      passages: [
        {
          id: 'p',
          content: 'Claims must be filed within 30 days.',
          score: 1,
          collection: 'probe',
          metadata: { documentId: 'probe' },
        },
      ],
    });
    return r.verdict === 'error'
      ? { ok: false, error: r.error ?? 'no verification returned' }
      : { ok: true };
  }

  #request(input: VerificationInput, numbers: string[]): LLMRequest {
    const structured = this.#structured();
    const passages = input.passages
      .map((p, i) => {
        const section = (p.metadata.custom?.['section'] as { label?: string } | undefined)?.label;
        const head = [p.metadata.title ?? p.metadata.documentId, section]
          .filter(Boolean)
          .join(' — ');
        const body =
          this.#maxPassageChars === undefined
            ? p.content
            : p.content.slice(0, this.#maxPassageChars);
        return `[${i + 1}] ${head}\n${body}`;
      })
      .join('\n\n');
    const hint =
      numbers.length > 0
        ? `\n\nFigures in the answer not found literally in the passages (check them; passages may write them in words): ${numbers.join(', ')}`
        : '';
    return {
      model: this.#model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `QUESTION:\n${input.question}\n\nANSWER:\n${input.answer}\n\nPASSAGES:\n${passages}${hint}\n\n` +
            `Check at most ${this.#maxClaims} claims.` +
            (structured
              ? ''
              : ' Reply with ONLY a JSON object: {"claims":[{"text","verdict","passages":[n],"note"}],"applicability":{"verdict","reason"}}.'),
        },
      ],
      temperature: 0,
      maxTokens:
        this.#maxClaims * 120 +
        (this.#reasoningEffort === 'minimal' || this.#reasoningEffort === 'none' ? 400 : 3000),
      ...(this.#reasoningEffort !== null &&
        this.#reasoningEffort !== undefined && { reasoningEffort: this.#reasoningEffort }),
      ...(structured && {
        responseFormat: {
          type: 'json_schema' as const,
          name: 'answer_verification',
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

interface RawVerification {
  claims: { text: string; verdict: VerifiedClaim['verdict']; passages: number[]; note: string }[];
  applicability: { verdict: VerificationResult['applicability']['verdict']; reason: string };
}

const CLAIM_VERDICTS = ['supported', 'partial', 'unsupported', 'contradicted'];
const APPLICABILITY = ['applies', 'does_not_apply', 'uncertain'];

function parse(response: LLMResponse): RawVerification | undefined {
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
  const v = value as {
    claims?: unknown;
    applicability?: { verdict?: unknown; reason?: unknown };
  } | null;
  if (v === null || typeof v !== 'object' || !Array.isArray(v.claims)) return undefined;
  const claims = v.claims
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .filter((c) => typeof c['text'] === 'string' && CLAIM_VERDICTS.includes(c['verdict'] as string))
    .map((c) => ({
      text: c['text'] as string,
      verdict: c['verdict'] as VerifiedClaim['verdict'],
      passages: Array.isArray(c['passages'])
        ? (c['passages'] as unknown[]).filter((n): n is number => typeof n === 'number')
        : [],
      note: typeof c['note'] === 'string' ? c['note'] : '',
    }));
  const av = v.applicability?.verdict;
  return {
    claims,
    applicability: {
      verdict: APPLICABILITY.includes(av as string)
        ? (av as RawVerification['applicability']['verdict'])
        : 'uncertain',
      reason: typeof v.applicability?.reason === 'string' ? v.applicability.reason : '',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The action a policy prescribes for a verification result. `repaired`
 * marks the result of verifying an answer that was already repaired once
 * (then `repair` is no longer an option: `afterRepair`).
 */
export function decideVerification(
  result: VerificationResult,
  policy: VerificationPolicy = {},
  repaired = false,
): VerificationAction {
  switch (result.verdict) {
    case 'pass':
      return 'deliver';
    case 'error':
      return policy.onError ?? 'deliver';
    case 'uncertain':
      return policy.onUncertain ?? 'deliver';
    case 'fail': {
      const contentFailed = result.claims.some(
        (c) => c.verdict === 'unsupported' || c.verdict === 'contradicted',
      );
      if (contentFailed) {
        const action = policy.onUnsupported ?? 'repair';
        return action === 'repair' && repaired ? (policy.afterRepair ?? 'annotate') : action;
      }
      return policy.onNotApplicable ?? 'annotate';
    }
  }
}

/** Texts of {@link buildRepairInstruction} and {@link verificationNotice}; each overrides the English default. */
export interface VerificationTexts {
  repairHeading: string;
  repairInstruction: string;
  noticeUnsupported: string;
  noticeNotApplicable: string;
  noticeUncertain: string;
  noticeError: string;
}

const TEXTS: VerificationTexts = {
  repairHeading: 'A check of your previous answer against the passages found these problems:',
  repairInstruction:
    'Answer again using only what the passages state. Leave out or correct every claim listed above; do not add figures, conditions or steps the passages do not contain. If the passages do not cover the case asked, say so. Do not mention this review, the passages or how the context is laid out: answer as you normally would.',
  noticeUnsupported: 'Part of this answer could not be confirmed in the documents:',
  noticeNotApplicable: 'The documents found may not apply to this case:',
  noticeUncertain: 'Part of this answer is only partially supported by the documents:',
  noticeError: 'This answer could not be verified against the documents.',
};

/**
 * Instruction for a second synthesis that repairs a failed answer: the
 * claims without support and, when relevant, why the passages do not apply.
 * Append it after the context and the question.
 */
export function buildRepairInstruction(
  result: VerificationResult,
  texts: Partial<VerificationTexts> = {},
): string {
  const t = { ...TEXTS, ...texts };
  const lines = result.claims
    .filter((c) => c.verdict !== 'supported')
    .map((c) => `- (${c.verdict}) ${c.text}${c.note !== undefined ? ` — ${c.note}` : ''}`);
  if (result.applicability.verdict === 'does_not_apply') {
    lines.push(`- (does not apply) ${result.applicability.reason ?? ''}`.trim());
  }
  return `${t.repairHeading}\n${lines.join('\n')}\n${t.repairInstruction}`;
}

/**
 * A notice for the user of an annotated answer: what could not be confirmed
 * (the claims, as the verifier stated them). Empty for a passing result.
 */
export function verificationNotice(
  result: VerificationResult,
  texts: Partial<VerificationTexts> = {},
): string {
  const t = { ...TEXTS, ...texts };
  if (result.verdict === 'pass') return '';
  if (result.verdict === 'error') return t.noticeError;
  const unsupported = result.claims.filter(
    (c) => c.verdict === 'unsupported' || c.verdict === 'contradicted',
  );
  if (unsupported.length > 0)
    return `${t.noticeUnsupported}\n${unsupported.map((c) => `- ${c.text}`).join('\n')}`;
  if (result.applicability.verdict === 'does_not_apply') {
    return `${t.noticeNotApplicable} ${result.applicability.reason ?? ''}`.trim();
  }
  const partial = result.claims.filter((c) => c.verdict === 'partial');
  return partial.length > 0
    ? `${t.noticeUncertain}\n${partial.map((c) => `- ${c.text}`).join('\n')}`
    : '';
}
