/**
 * Quickstart — a governed agent in one file.
 *
 * An agent with two tools, a role-based access policy that decides which user
 * may call which tool, and an audit trail of everything that happened.
 *
 * Run it from the repository root:
 *
 *   npx tsx examples/quickstart.ts
 *
 * With `ANTHROPIC_API_KEY` set it talks to Claude. Without it, a small scripted
 * model stands in so the example runs offline and deterministically — the
 * governance layer (ACL, security chain, audit) is the same real code either way.
 *
 * In your own project, import from `agent349` instead of `../src/index.js`.
 */
import {
  ACLService,
  Orchestrator,
  SecurityMiddlewareChain,
  ToolACLMiddleware,
} from '../src/index.js';
import type { Tool } from '../src/index.js';
import { ScriptedModel } from './support/ScriptedModel.js';

// ── Tools: plain objects with a JSON Schema and an async execute() ───────────

const getBalance: Tool = {
  name: 'accounts.getBalance',
  description: 'Returns the current balance of an account.',
  inputSchema: {
    type: 'object',
    properties: { accountId: { type: 'string' } },
    required: ['accountId'],
  },
  execute: async ({ accountId }: { accountId: string }) => ({
    success: true,
    data: { accountId, balance: 12_500, currency: 'USD' },
  }),
};

const transfer: Tool = {
  name: 'payments.transfer',
  description: 'Transfers money between two accounts.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      amount: { type: 'number' },
    },
    required: ['from', 'to', 'amount'],
  },
  sideEffects: true,
  execute: async ({ from, to, amount }: { from: string; to: string; amount: number }) => ({
    success: true,
    data: { from, to, amount, status: 'completed' },
  }),
};

// ── Runtime: audit enabled, in-memory stores (swap for Redis/Mongo in prod) ──

const orch = await Orchestrator.create({ audit: { enabled: true } });

if (!process.env['ANTHROPIC_API_KEY']) {
  orch.registerProvider(new ScriptedModel('claude'));
}

orch.registerTool(getBalance);
orch.registerTool(transfer);
orch.registerSkill({
  name: 'banking',
  description: 'Account queries and payments',
  tools: [getBalance, transfer],
});
orch.registerAgent({
  id: 'banking-assistant',
  name: 'Banking assistant',
  systemPrompt: 'You help employees with account queries and payments. Use the tools.',
  skills: ['banking'],
});

// ── Governance: who may call what ────────────────────────────────────────────

const acl = new ACLService({
  policies: [
    {
      resourceType: 'tool',
      resourceId: 'accounts.getBalance',
      allowedRoles: ['analyst', 'treasurer'],
    },
    { resourceType: 'tool', resourceId: 'payments.transfer', allowedRoles: ['treasurer'] },
  ],
});
// Layer 1: tools the caller may not use are never offered to the model.
orch.registerACLService(acl);
// Layer 2: every tool call is re-checked right before it executes. Passing the
// event bus is what routes denials into the audit trail.
const security = new SecurityMiddlewareChain(orch.events);
security.use(new ToolACLMiddleware(acl));
orch.registerSecurityChain(security);

// ── Two users, same agent, different permissions ────────────────────────────

const analyst = { tenantId: 'acme', userId: 'ana', roles: ['analyst'] };
const treasurer = { tenantId: 'acme', userId: 'tom', roles: ['treasurer'] };

const r1 = await orch.chat('banking-assistant', 'Transfer 500 USD from ACC-1 to ACC-2.', analyst);
console.log('analyst   →', r1.content, '| tools used:', r1.toolsUsed);

const r2 = await orch.chat('banking-assistant', 'Transfer 500 USD from ACC-1 to ACC-2.', treasurer);
console.log('treasurer →', r2.content, '| tools used:', r2.toolsUsed);

// ── Audit: an immutable record of who did what, and with which outcome ───────

await orch.audit!.flush();
const { records } = await orch.audit!.query({
  tenantId: 'acme',
  category: ['tool', 'security'],
  dateRange: { from: new Date(Date.now() - 60_000), to: new Date() },
});
console.log('\nAudit trail:');
for (const r of records) {
  console.log(`  ${r.userId.padEnd(4)} ${`${r.category}/${r.action}`.padEnd(34)} ${r.outcome}`);
}

await orch.shutdown();
