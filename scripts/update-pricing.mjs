#!/usr/bin/env node
/**
 * Regenerates src/tokens/pricing-catalog.json from LiteLLM's community price
 * list (model_prices_and_context_window.json, MIT licensed).
 *
 * Run by a maintainer before a release, never at runtime:
 *
 *   node scripts/update-pricing.mjs                 # download from LiteLLM main
 *   node scripts/update-pricing.mjs --source <url|file>
 *   node scripts/update-pricing.mjs --dry-run       # report the diff only
 *
 * Only the providers Agent349 ships adapters for are kept, and only the modes
 * it bills (chat, completion, responses, embedding). Prices are converted from
 * USD per token to USD per 1M tokens, the unit of vendor price pages.
 *
 * Manual corrections live in src/tokens/pricing-overrides.json, which this
 * script never writes: they are merged on top of the catalog at runtime, so a
 * regeneration cannot undo them. The diff report lists overrides that now
 * match the generated catalog, so they can be retired.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'src', 'tokens', 'pricing-catalog.json');
const OVERRIDES = join(ROOT, 'src', 'tokens', 'pricing-overrides.json');
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** LiteLLM provider → Agent349 catalog provider. Anything else is dropped. */
const PROVIDERS = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  cohere: 'cohere',
  cohere_chat: 'cohere',
};

/** Billable modes kept in the catalog. */
const MODES = new Set(['chat', 'completion', 'responses', 'embedding']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
const source = sourceArg ?? DEFAULT_SOURCE;

/** USD per token → USD per 1M tokens, rounded to remove float noise. */
const perMillion = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined;

async function loadSource() {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${source})`);
    return await res.text();
  }
  return readFileSync(source, 'utf-8');
}

function convert(raw) {
  const models = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'sample_spec' || entry === null || typeof entry !== 'object') continue;
    const provider = PROVIDERS[entry.litellm_provider];
    if (provider === undefined || !MODES.has(entry.mode)) continue;
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token) ?? 0;
    if (input === undefined) continue;

    // LiteLLM prefixes some keys with the provider ("gemini/gemini-2.5-pro").
    const model = key.startsWith(`${entry.litellm_provider}/`)
      ? key.slice(entry.litellm_provider.length + 1)
      : key.includes('/')
        ? undefined
        : key;
    if (model === undefined) continue;
    const id = `${provider}/${model}`;
    // Prefer the unprefixed key when both spellings exist.
    if (models[id] !== undefined && key.includes('/')) continue;

    const out = { mode: entry.mode === 'embedding' ? 'embedding' : 'chat', input, output };
    const cached = perMillion(entry.cache_read_input_token_cost);
    if (cached !== undefined) out.cachedInput = cached;
    const batchInput = perMillion(entry.input_cost_per_token_batches);
    const batchOutput = perMillion(entry.output_cost_per_token_batches);
    if (batchInput !== undefined) out.batchInput = batchInput;
    if (batchOutput !== undefined) out.batchOutput = batchOutput;
    if (
      typeof entry.deprecation_date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.deprecation_date)
    ) {
      out.deprecation = {
        shutdown: entry.deprecation_date,
        ...(typeof entry.successor_model === 'string' && {
          replacement: `${provider}/${entry.successor_model}`,
        }),
        ...(typeof entry.deprecation_source === 'string' && { source: entry.deprecation_source }),
      };
    }
    if (typeof entry.source === 'string') out.source = entry.source;
    models[id] = out;
  }
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
}

function priceKey(e) {
  return JSON.stringify([e.input, e.output, e.cachedInput, e.batchInput, e.batchOutput]);
}

function report(previous, next) {
  const before = previous?.models ?? {};
  const added = Object.keys(next).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in next));
  const changed = Object.keys(next).filter(
    (k) => k in before && priceKey(before[k]) !== priceKey(next[k]),
  );
  console.log(
    `models: ${Object.keys(next).length} (added ${added.length}, removed ${removed.length}, price changes ${changed.length})`,
  );
  for (const k of changed.slice(0, 60)) {
    const a = before[k];
    const b = next[k];
    console.log(`  ~ ${k}: in ${a.input} → ${b.input}, out ${a.output} → ${b.output}`);
  }
  if (added.length)
    console.log(`  + ${added.slice(0, 40).join(', ')}${added.length > 40 ? ', …' : ''}`);
  if (removed.length)
    console.log(`  - ${removed.slice(0, 40).join(', ')}${removed.length > 40 ? ', …' : ''}`);

  if (existsSync(OVERRIDES)) {
    const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf-8')).models ?? {};
    for (const [k, o] of Object.entries(overrides)) {
      const g = next[k];
      if (
        g &&
        ['input', 'output', 'cachedInput'].every((f) => o[f] === undefined || o[f] === g[f])
      ) {
        console.log(`  override ${k} now matches the generated catalog: it can be removed`);
      }
    }
  }
}

const text = await loadSource();
const raw = JSON.parse(text);
const models = convert(raw);
const previous = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf-8')) : undefined;
report(previous, models);

const catalog = {
  version: new Date().toISOString().slice(0, 10),
  currency: 'USD',
  unit: 'per_1M_tokens',
  source: {
    name: 'LiteLLM model_prices_and_context_window.json (MIT)',
    url: source,
    sha256: createHash('sha256').update(text).digest('hex'),
  },
  models,
};

if (dryRun) {
  console.log('dry run: catalog not written');
} else {
  writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote ${CATALOG}`);
}
