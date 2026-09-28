# Security policy

Agent349 enforces access control, data isolation and approvals for AI agents,
so we treat security reports as a priority.

## Supported versions

Agent349 is pre-1.0. Security fixes are released for the latest minor version.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | ✅        |
| < 0.4   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:
[Security → Report a vulnerability](https://github.com/agent-349/agent349/security/advisories/new).

Include what you can of:

- the affected version and component (for example `security/`, `approval/`,
  `tools/builtin/sql`),
- a description of the issue and its impact,
- steps or a minimal configuration to reproduce it,
- any suggested fix.

We aim to acknowledge reports within three business days and to agree on a
disclosure timeline with you. Credit is given in the release notes unless you
prefer otherwise.

## Scope

Particularly relevant reports include:

- bypasses of tool ACL, data filtering, field masking or retrieval scoping;
- cross-tenant data exposure;
- ways for model output to choose credentials, hosts, paths or relations that
  configuration did not expose in integration tools;
- SQL read-only guard bypasses that lead to writes on engines where the SDK
  claims read-only execution;
- approval bypasses (a tool that should be suspended runs without approval,
  or a caller without an approver role or from another tenant decides an
  action);
- secrets leaking into logs, audit records or model prompts.

## Security model and known limits

Some behavior is by design and documented; please read these before
reporting:

- Agent349 does not authenticate users. The identity passed to `chat()` is
  trusted.
- Approver authorization (tenant and approver roles) is checked against the
  identity your application passes to `approve()` and `reject()`. Like the
  identity passed to `chat()`, it is trusted
  ([details](docs/guides/human-in-the-loop.md#deciding)).
- Prompt-injection detection is pattern-based defense in depth, not a
  guarantee. Untrusted-content tracking reports risk but does not block.
- Free-form SQL guards are syntactic. The security boundary is a
  least-privilege database user ([details](docs/guides/integration-tools.md#free-form-sql-what-is-and-is-not-guaranteed)).
- The audit integrity hash detects modification but is not a signature.
