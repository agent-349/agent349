# Integration tools

Agent349 ships configurable tools for the systems agents most often need to
reach: SQL and MongoDB databases, HTTP APIs, web pages, feeds, document stores,
files and email. They share one rule:

> **Credentials and destinations are configuration. The model only supplies the
> parameters declared as its own.**

The model never chooses a host, a path, a method, a connection string or a
table outside the allowlist. It cannot even name them, because they are not in
the input schema it sees.

| Tool (`ref`)                  | Purpose                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sql.query`                   | Declared statements, or read-only free-form SQL for text-to-SQL, on PostgreSQL, MySQL/MariaDB, SQL Server and Oracle |
| `sql.schema`                  | Describes the tables and relations an agent may query                                                                |
| `mongo.query`, `mongo.schema` | Read-only MongoDB queries and schema description                                                                     |
| `http.request`                | One declared operation of an HTTP API: fixed method, host and path template                                          |
| `web.read`                    | Reads a web page (optionally a CSS-selected region) as text                                                          |
| `feed.read`                   | Reads RSS 2.0, Atom 1.0 and RSS 1.0 feeds as normalized entries                                                      |
| `doc.read`                    | Reads documents from a document store you provide                                                                    |
| `file.read`                   | Reads files from an allowlisted directory (path-jailed)                                                              |
| `mail.send`                   | Sends email through a transport you provide                                                                          |

## Connections and credentials

```json config
{
  "connections": {
    "erp": {
      "type": "sql",
      "driver": "postgres",
      "host": "db.internal",
      "port": 5432,
      "database": "erp",
      "credential": { "ref": "erp-readonly" },
      "readOnlyUser": true,
      "limits": { "maxRows": 500, "timeoutMs": 15000 }
    },
    "crm": {
      "type": "http",
      "baseUrl": "https://crm.example.com/api/v2",
      "credential": { "ref": "crm-token" }
    }
  },
  "credentials": {
    "erp-readonly": { "kind": "basic", "username": "agent_ro", "password": "${ERP_PASSWORD}" },
    "crm-token": { "kind": "bearer", "token": "${CRM_TOKEN}" }
  }
}
```

- Connections open lazily, on first use. A database that is down does not
  prevent startup.
- `shutdown()` closes what the SDK opened, and nothing the host injected.
- Connection `limits` are a ceiling: a tool can lower them, never raise them.
- For OAuth, rotation, secret managers or per-user credentials, extend
  `CredentialProvider`. It receives the `ExecutionContext` and is called on every
  execution, never cached.
- Connections can also be registered at runtime (`orch.registerConnection`), for
  example one per tenant.

Database clients are not bundled. Install the one you use (`pg`, `mysql2`,
`mssql`, `oracledb`, `mongodb`) and register its driver:

```ts
import { PostgresDriver } from 'agent349';

orch.connections.registerDriver(new PostgresDriver());
```

## Parameter bindings

Every parameter declares where its value comes from:

| `from`    | Value decided by                                                               | Visible to the model |
| --------- | ------------------------------------------------------------------------------ | -------------------- |
| `model`   | The model, validated against the declared schema                               | Yes                  |
| `context` | The caller's `ExecutionContext` (`userId`, `tenantId`, `roles`, `metadata.*`…) | No                   |
| `literal` | Configuration                                                                  | No                   |

```json config
{
  "tools": {
    "definitions": [
      {
        "name": "sales.byCustomer",
        "kind": "internal",
        "ref": "sql.query",
        "config": {
          "connection": "erp",
          "description": "Confirmed sales of the current customer since a date.",
          "statement": "SELECT date, amount FROM v_sales WHERE customer_id = :customerId AND date >= :since ORDER BY date DESC",
          "params": {
            "customerId": { "from": "context", "path": "metadata.customerId", "required": true },
            "since": {
              "from": "model",
              "required": true,
              "schema": { "type": "string", "format": "date" }
            }
          }
        }
      }
    ]
  },
  "connections": {
    "erp": {
      "type": "sql",
      "driver": "postgres",
      "host": "db.internal",
      "database": "erp",
      "readOnlyUser": true
    }
  }
}
```

Here the model can pick the date, but never the customer: the customer comes
from the authenticated session. A required `context` binding with no value
fails the call rather than running an unscoped query. Values are always sent
as bound parameters, never interpolated into the SQL.

## Free-form SQL: what is and is not guaranteed

`sql.query` with `mode: "freeform"` lets the model write SQL (text-to-SQL)
against an allowlist of relations. Each statement runs inside a **read-only
transaction** with a statement timeout, so the database engine itself rejects
writes. On SQL Server, which has no read-only transactions, the transaction is
always rolled back instead: a write is undone, not prevented.

On top of that, syntactic guards check for a single statement, a read prefix,
forbidden keywords (including `SELECT … INTO`) and the relation allowlist.
**These guards are not the security boundary.** The boundary is a database
user whose permissions are limited to the exposed relations. `readOnlyUser:
true` is your assertion that such a user is configured. Omitting it emits
`security.sql.unrestricted`.

## HTTP operations

An `http.request` tool is **one declared operation**: fixed method and path
template on a connection's `baseUrl`. Path parameters containing `..` or
absolute URLs are rejected. Redirects are off by default, and when enabled each
hop is re-validated. Mutating verbs are marked as side-effecting, and emit
`security.http.mutating.unapproved` if the tool is not flagged
`requiresApproval`. `blockPrivateAddresses` rejects targets that resolve to
private networks.

## Results and limits

Collections come back in one envelope with truncation stated explicitly, so
the model does not present a partial result as complete:

```json
{
  "rows": [],
  "rowCount": 200,
  "truncated": true,
  "truncatedBy": "maxRows",
  "notice": "Truncated: showing the first 200 rows… do not present this as a complete or total count."
}
```

Limits cascade tool → connection → SDK defaults (`maxRows: 200`,
`maxBytes: 131072`, `timeoutMs: 15000`).

## Running a tool from your code

`orch.executeTool(name, input, context)` runs any of these tools, for example
from a dashboard, with the same validation, limits, events and audit as an
agent call.

The Spanish [integration tools manual](../es/TOOLS_MANUAL.md) documents every
tool's options, the dialect differences between SQL engines, and a production
checklist.
