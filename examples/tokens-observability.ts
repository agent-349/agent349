/**
 * Token accounting: pricing, multi-dimensional breakdowns and the
 * observability façade.
 *
 * Shows:
 *  - automatic cost per model from config.tokens.pricing;
 *  - breakdowns by agent / session / request / skill / tool / provider;
 *  - a per-request report combining cost and audit trail.
 *
 * Run: npx tsx examples/tokens-observability.ts
 */
import { ConfigLoader, Orchestrator } from '../src/index.js';

async function main(): Promise<void> {
  const config = ConfigLoader.from({
    audit: { enabled: true }, // for the combined cost + audit report
    tokens: {
      pricing: {
        'claude-opus-5': { input: 0.005, output: 0.025 },
        reranker: { input: 0, output: 0 },
      },
    },
  }).get();

  const orch = await Orchestrator.fromConfig(config);

  // In a real run the AgentLoop and RAGPipeline record this. Simulated here.
  await orch.tokens.record(
    {
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-finance',
      sessionId: 's1',
      requestId: 'r1',
      roles: [],
    },
    {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      provider: 'claude',
      model: 'claude-opus-5',
    },
  );
  await orch.tokens.record(
    {
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-finance',
      sessionId: 's1',
      requestId: 'r1',
      roles: [],
    },
    {
      inputTokens: 200,
      outputTokens: 0,
      totalTokens: 200,
      provider: 'cohere',
      model: 'reranker',
      toolName: 'rag.search',
    },
  );

  const today = (() => {
    const now = new Date();
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(now);
    to.setUTCHours(23, 59, 59, 999);
    return { from, to };
  })();

  // Cost computed automatically from the price list.
  const byAgent = await orch.tokens.getByAgent('acme', 'agent-finance', today);
  console.log('Agent cost:', byAgent.totalCostUsd, 'USD');
  console.log('By provider:', byAgent.byProvider);
  console.log('By tool:', byAgent.byTool);

  // Cost of a single request (includes tool and RAG calls).
  const reqUsage = await orch.tokens.getByRequest('r1');
  console.log('Request r1:', reqUsage.totalInputTokens + reqUsage.totalOutputTokens, 'tokens');

  // Façade: cost and audit trail of one request. The audit trail is empty here
  // because the usage above was recorded by hand; in a real chat() the loop's
  // events populate it.
  const report = await orch.observability.getRequestReport('r1');
  console.log(
    'Report r1 → cost:',
    report.usage.totalCostUsd,
    '| audited events:',
    report.auditTrail.length,
  );

  await orch.shutdown();
}

void main();
