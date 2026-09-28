import type { SanitizationResult, DetectedPattern } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom injection pattern supplied by the consuming application.
 */
export interface CustomInjectionPattern {
  /** Descriptive name used in detection results. */
  name: string;
  /** Regular expression source string. Case-insensitive matching is applied. */
  pattern: string;
  /** Risk level assigned when this pattern matches. */
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * Configuration for {@link InputSanitizer}.
 */
export interface SanitizerConfig {
  /**
   * Additional injection patterns registered by the application.
   * Appended after the built-in patterns.
   */
  customPatterns?: CustomInjectionPattern[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in detection rules
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltinRule {
  type: string;
  pattern: RegExp;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
}

/** Ordered list of built-in injection detection rules. */
const BUILTIN_RULES: BuiltinRule[] = [
  // ── role_override (high) ───────────────────────────────────────────────────
  {
    type: 'role_override',
    pattern: /ignore\s+(?:your\s+)?(?:previous\s+)?instructions/i,
    confidence: 0.95,
    riskLevel: 'high',
  },
  {
    type: 'role_override',
    pattern: /ignora\s+(?:tus\s+)?(?:instrucciones|instrucción)/i,
    confidence: 0.95,
    riskLevel: 'high',
  },
  {
    type: 'role_override',
    pattern: /forget\s+(?:your\s+)?(?:previous\s+)?instructions/i,
    confidence: 0.95,
    riskLevel: 'high',
  },
  {
    type: 'role_override',
    pattern: /override\s+(?:your\s+)?(?:system\s+)?instructions/i,
    confidence: 0.9,
    riskLevel: 'high',
  },
  {
    type: 'role_override',
    pattern: /disregard\s+(?:all\s+)?(?:previous\s+)?instructions/i,
    confidence: 0.9,
    riskLevel: 'high',
  },
  {
    type: 'role_override',
    pattern: /new\s+instructions?\s*:/i,
    confidence: 0.85,
    riskLevel: 'high',
  },
  // ── instruction_inject (medium) ────────────────────────────────────────────
  {
    type: 'instruction_inject',
    pattern: /you\s+are\s+now\s+(?:a|an)\s/i,
    confidence: 0.8,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /act\s+as\s+(?:if\s+)?(?:you\s+(?:are|were)\s+)?(?:a|an)\s/i,
    confidence: 0.8,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /pretend\s+(?:to\s+be|you\s+are)/i,
    confidence: 0.8,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /roleplay\s+as/i,
    confidence: 0.75,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /without\s+restrictions?/i,
    confidence: 0.75,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /sin\s+restricciones/i,
    confidence: 0.8,
    riskLevel: 'medium',
  },
  {
    type: 'instruction_inject',
    pattern: /as\s+an?\s+ai\s+without/i,
    confidence: 0.85,
    riskLevel: 'medium',
  },
  // ── delimiter_escape (low) ─────────────────────────────────────────────────
  {
    type: 'delimiter_escape',
    pattern: /```\s*(?:system|prompt|instruction)/i,
    confidence: 0.7,
    riskLevel: 'low',
  },
  {
    type: 'delimiter_escape',
    pattern: /\[SYSTEM\]/i,
    confidence: 0.65,
    riskLevel: 'low',
  },
  {
    type: 'delimiter_escape',
    pattern: /<\|?system\|?>/i,
    confidence: 0.7,
    riskLevel: 'low',
  },
  {
    type: 'delimiter_escape',
    pattern: /\[\[(?:SYSTEM|INSTRUCTIONS?)\]\]/i,
    confidence: 0.7,
    riskLevel: 'low',
  },
  // ── context_manipulation (medium) ─────────────────────────────────────────
  {
    type: 'context_manipulation',
    pattern: /forget\s+everything\s+(?:you\s+(?:know|were\s+told))?/i,
    confidence: 0.85,
    riskLevel: 'medium',
  },
  {
    type: 'context_manipulation',
    pattern: /reset\s+(?:your\s+)?(?:context|memory|conversation)/i,
    confidence: 0.8,
    riskLevel: 'medium',
  },
  {
    type: 'context_manipulation',
    pattern: /(?:as\s+(?:an?\s+)?(?:admin(?:istrator)?|developer|superuser))/i,
    confidence: 0.7,
    riskLevel: 'medium',
  },
  {
    type: 'context_manipulation',
    pattern: /start\s+(?:a\s+)?(?:fresh|new)\s+(?:session|conversation)/i,
    confidence: 0.7,
    riskLevel: 'medium',
  },
];

// Risk level ordinal for comparison
const RISK_ORDER: Record<'none' | 'low' | 'medium' | 'high', number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// InputSanitizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects and neutralises prompt injection attempts in user-supplied text.
 *
 * ### Detection categories
 *
 * | Category              | Risk   | Examples                                         |
 * |-----------------------|--------|--------------------------------------------------|
 * | `role_override`       | high   | "Ignore your previous instructions…"            |
 * | `instruction_inject`  | medium | "Act as if you were…", "sin restricciones"       |
 * | `delimiter_escape`    | low    | "```system", "[SYSTEM]", "<|system|>"            |
 * | `context_manipulation`| medium | "Forget everything", "reset your context"        |
 *
 * ### Risk aggregation
 * The overall `riskLevel` in {@link SanitizationResult} is the **maximum** risk
 * level across all detected patterns. The `recommendation` maps to:
 * - `none` / `low`  → `'allow'`
 * - `medium`        → `'sanitize'`
 * - `high`          → `'block'`
 *
 * Custom patterns (via {@link SanitizerConfig.customPatterns}) are evaluated
 * after the built-in rules and may raise the overall risk level.
 */
export class InputSanitizer {
  readonly #rules: BuiltinRule[];

  /**
   * @param config - Optional sanitiser configuration.
   */
  constructor(config: SanitizerConfig = {}) {
    const custom: BuiltinRule[] = (config.customPatterns ?? []).map((cp) => ({
      type: cp.name,
      pattern: new RegExp(cp.pattern, 'i'),
      confidence: 0.8,
      riskLevel: cp.riskLevel,
    }));
    this.#rules = [...BUILTIN_RULES, ...custom];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Scans `input` for prompt-injection patterns and returns a structured result.
   *
   * Every matching pattern contributes a {@link DetectedPattern} entry.
   * The `riskLevel` is the maximum risk across all matches.
   * The `recommendation` is derived from the risk level:
   * - `none` / `low`  → `'allow'`
   * - `medium`        → `'sanitize'`
   * - `high`          → `'block'`
   *
   * @param input - Raw user-supplied text to analyse.
   * @returns Full detection report with risk level and recommendation.
   */
  analyze(input: string): SanitizationResult {
    const patterns: DetectedPattern[] = [];
    let maxRisk: 'none' | 'low' | 'medium' | 'high' = 'none';

    for (const rule of this.#rules) {
      const match = rule.pattern.exec(input);
      if (match !== null) {
        patterns.push({ type: rule.type, match: match[0], confidence: rule.confidence });
        if (RISK_ORDER[rule.riskLevel] > RISK_ORDER[maxRisk]) {
          maxRisk = rule.riskLevel;
        }
      }
    }

    return {
      riskLevel: maxRisk,
      patterns,
      recommendation: this.#recommend(maxRisk),
    };
  }

  /**
   * Sanitises `input` by replacing all detected injection pattern matches with
   * the literal string `'[FILTERED]'`.
   *
   * The original string is not mutated; a new string is returned.
   *
   * @param input - Raw user-supplied text to sanitise.
   * @returns The sanitised string with dangerous substrings neutralised.
   */
  sanitize(input: string): string {
    let result = input;
    for (const rule of this.#rules) {
      result = result.replace(rule.pattern, '[FILTERED]');
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #recommend(risk: 'none' | 'low' | 'medium' | 'high'): 'allow' | 'sanitize' | 'block' {
    switch (risk) {
      case 'none':
      case 'low':
        return 'allow';
      case 'medium':
        return 'sanitize';
      case 'high':
        return 'block';
    }
  }
}
