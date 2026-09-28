# LLM providers

Agents never talk to a vendor SDK directly. They name a **provider instance**
declared in configuration, and the `LLMRouter` handles the call, the circuit
breaker and the fallback.

## Supported providers

| `type`              | Service                                                          | Default instance                     | Default model      |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------ | ------------------ |
| `claude`            | Anthropic Messages API                                           | `claude`, key `ANTHROPIC_API_KEY`    | `claude-opus-5`    |
| `openai`            | OpenAI                                                           | `openai`, key `OPENAI_API_KEY`       | `gpt-6-sol`        |
| `gemini`            | Google Gemini                                                    | `gemini`, key `GEMINI_API_KEY`       | `gemini-3.8-flash` |
| `ollama`            | Local or self-hosted Ollama                                      | `ollama` at `http://localhost:11434` | `llama3`           |
| `openai-compatible` | vLLM, LiteLLM, internal gateways, any OpenAI-compatible endpoint | none (`baseUrl` required)            | set it             |

A custom adapter can be added by extending `LLMProvider` (see
[below](#custom-providers)).

## Instances, not vendors

`llm.providers` takes arbitrary names. Each name is an **instance** with its own
endpoint, credentials, timeout, pricing, token accounting and circuit breaker.
One instance serves many models.

```json config
{
  "llm": {
    "defaultProvider": "claude",
    "providers": {
      "claude": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "defaultModel": "claude-opus-5"
      },
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "defaultModel": "gpt-6-sol"
      },
      "local-llama": {
        "type": "openai-compatible",
        "baseUrl": "http://vllm:8000/v1",
        "defaultModel": "meta-llama/Llama-3.1-8B-Instruct"
      },
      "gateway": {
        "type": "openai-compatible",
        "baseUrl": "https://llm-gateway.example.com/v1",
        "defaultModel": "qwen2.5-72b",
        "headers": { "Authorization": "Bearer ${GATEWAY_TOKEN}" }
      },
      "ollama-gpu": {
        "type": "ollama",
        "baseUrl": "http://gpu-host:11434",
        "defaultModel": "qwen2.5:32b",
        "timeoutMs": 300000
      }
    },
    "circuitBreaker": { "failureThreshold": 3, "recoveryTimeMs": 60000 }
  }
}
```

- `type` is inferred for the names `claude`, `openai` and `ollama`, and required
  for any other name.
- Use `baseUrl` and `headers`. The SDK translates them to each vendor SDK's own
  option names.
- An `Authorization` header in `headers` takes precedence over `apiKey` (the SDK
  emits `llm.provider.auth_conflict` when both are set).

Agents choose an instance and optionally a model:

```ts
orch.registerAgent({
  id: 'summarizer',
  name: 'Summarizer',
  systemPrompt: 'Summarize documents faithfully.',
  skills: [],
  llmConfig: {
    provider: 'local-llama', // keep this workload on-premises
    fallbackProvider: 'claude', // used when the primary fails or its circuit is open
    fallbackModel: 'claude-haiku-4-5',
  },
});
```

The model names in this guide are current as of September 2026. Set
`defaultModel` explicitly in production rather than relying on the SDK's
defaults, and prefer stable model IDs over moving aliases: an alias such as
`gemini-flash-latest` can point to a preview or experimental release.

Cost accounting uses a built-in price list for current Claude, OpenAI and
Gemini models. Prices change, so set your own under `tokens.pricing` (see
[Observability](observability.md#token-accounting-and-quotas)); a model without a
price is counted at `0`.

## Circuit breaker and fallback

After `failureThreshold` consecutive failures, an instance's circuit opens and
calls go straight to the agent's `fallbackProvider` (if any) until
`recoveryTimeMs` has passed. Fallback respects capabilities: a request with an
image or a JSON Schema is never sent to a fallback that cannot handle it. The
primary's error is returned instead of a degraded answer.

## Direct model calls

`orch.complete()` calls a provider without an agent loop, still with token
accounting, quota checks and events:

```ts
const response = await orch.complete(
  {
    model: 'gpt-6-sol',
    systemPrompt: 'Classify the ticket as "bug", "question" or "request".',
    messages: [{ role: 'user', content: 'The export button does nothing.' }],
    maxTokens: 10,
  },
  context,
  { provider: 'openai' },
);
console.log(response.content, response.usage.totalTokens);
```

## Multimodal input

Messages can mix text with images, documents, audio and video. Build content
blocks with the helpers instead of by hand:

```ts
import { documentFromPath, imageFromUrl, text } from 'agent349';

const response = await orch.chat(
  'assistant',
  [
    text('Does the invoice match the delivery photo?'),
    documentFromPath('./invoice.pdf'),
    imageFromUrl('https://example.com/delivery.jpg'),
  ],
  identity,
);
```

Sources can be a file path, bytes, a URL, a file already uploaded to the
provider, or base64. The SDK never downloads URLs itself: a URL is passed to
providers that fetch URLs, and rejected with a clear error by those that do not.

Each provider declares what it supports, and an unsupported block fails before
the request is sent instead of being silently dropped:

```ts
const caps = orch.capabilities('gemini');
if (!caps.input.document) {
  // choose another provider, or extract the text first
}
```

|                   | Image | Document | Audio / video | JSON Schema | Schema + tools | Files | Batch |
| ----------------- | ----- | -------- | ------------- | ----------- | -------------- | ----- | ----- |
| Gemini            | ✅    | ✅       | ✅            | ✅          | ✅             | ✅    | ✅    |
| Claude            | ✅    | ✅       | —             | ✅          | ✅             | ✅    | ✅    |
| OpenAI            | ✅    | ✅       | —             | ✅          | ✅             | ✅    | ✅    |
| OpenAI-compatible | ✅    | —        | —             | JSON mode   | ✅             | —     | —     |
| Ollama            | ✅    | —        | —             | ✅          | —              | —     | —     |

## Structured output

Ask for JSON that matches a schema, optionally validated by the SDK:

```ts
const invoiceSchema = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    total: { type: 'number' },
    currency: { type: 'string' },
  },
  required: ['number', 'total', 'currency'],
};

const response = await orch.chat('assistant', 'Extract the invoice fields.', identity, {
  responseFormat: { type: 'json_schema', schema: invoiceSchema, validate: true },
});

if (response.structured?.validation === 'valid') {
  console.log(response.structured.value);
}
```

`structured` reports three separate facts: how the provider enforced the format
(`mode`), whether the answer parsed as JSON (`parsed`), and whether it passed
schema validation (`validation`, with `validationErrors`).

## Files and batch

Providers with a files API (Gemini, Claude, OpenAI) can take an upload once and
reuse it: `orch.uploadFile()` / `orch.deleteFile()`, with
`fileHandling: 'upload'` on a request. For large offline workloads,
`orch.submitBatch()` submits many requests as one discounted provider batch job.
`orch.getBatch()` and `orch.streamBatchResults()` collect the results, keyed by
your own `customId`. The SDK never polls or schedules. Your application
decides when to check. See the Spanish [batch manual](../es/BATCH_MANUAL.md) and
[multimodal manual](../es/MULTIMODAL_MANUAL.md) for the details.

## Custom providers

```ts
import { LLMProvider, textOnlyCapabilities } from 'agent349';
import type { LLMRequest, LLMResponse, ProviderCapabilities, ProviderProbe } from 'agent349';

export class InternalModelProvider extends LLMProvider {
  readonly name = 'internal';
  readonly providerType = 'internal-http';

  constructor(private readonly endpoint: string) {
    super();
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: req.model, system: req.systemPrompt, messages: req.messages }),
      ...(req.signal !== undefined && { signal: req.signal }),
    });
    const body = (await res.json()) as { text: string; inputTokens: number; outputTokens: number };
    return {
      content: body.text,
      stopReason: 'end',
      usage: {
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        totalTokens: body.inputTokens + body.outputTokens,
      },
      model: req.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }

  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }

  async listModels(): Promise<string[]> {
    return ['internal-v1'];
  }

  // Declare only what you support: the SDK checks this before every request.
  capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

orch.registerProvider(new InternalModelProvider('https://models.example.com/v1/generate'));
```

To make a custom type available from JSON configuration, pass a factory in
`llmAdapters` to `Orchestrator.fromConfig(config, { llmAdapters })`. Files and
batch are separate interfaces (`FileCapableProvider`, `BatchCapableProvider`)
that a provider implements only if it supports them.
