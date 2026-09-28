# Examples

Run any example from the repository root after `npm install`:

```bash
npx tsx examples/<name>.ts
```

The examples import from `../src/index.js` so they run against the sources. In
your own project, import from `agent349`.

| Example                                              | Shows                                                                                   | Needs                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`quickstart.ts`](quickstart.ts)                     | An agent with tools, two-layer ACL and an audit trail; two users, different permissions | Nothing (uses Claude if `ANTHROPIC_API_KEY` is set)  |
| [`integration-tools.ts`](integration-tools.ts)       | Database, HTTP API, document and mail tools declared in configuration                   | Nothing (builds and inspects the agent)              |
| [`audit-basic.ts`](audit-basic.ts)                   | Audit capture, session timeline, request trace, statistics                              | Nothing                                              |
| [`audit-siem.ts`](audit-siem.ts)                     | Forwarding the audit trail to a SIEM (webhook and custom forwarder)                     | Nothing (delivery to the sample URL fails by design) |
| [`audit-mongo.ts`](audit-mongo.ts)                   | Persisting the audit trail in MongoDB                                                   | `npm install mongodb`, a MongoDB at `MONGO_URI`      |
| [`logging-console.ts`](logging-console.ts)           | Console logging and a custom logger adapter                                             | Nothing                                              |
| [`tokens-observability.ts`](tokens-observability.ts) | Pricing, cost breakdowns and per-request reports                                        | Nothing                                              |

All examples are type-checked in CI (`npm run typecheck:examples`), and the
quickstart runs in CI.
