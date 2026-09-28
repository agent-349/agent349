#!/usr/bin/env node
// Type-checks every ```ts / ```typescript block in README.md and docs/ (except
// the Spanish reference manuals in docs/es/) against the current sources, so
// documented examples cannot drift from the real API.
//
// Conventions for doc authors:
//   - Each block is compiled as its own ES module; `import ... from 'agent349'`
//     resolves to src/index.ts.
//   - A few ambient names are pre-declared when a block uses them without
//     declaring them itself: `orch`, `identity`, `context`.
//   - Named imports from relative paths (`import { x } from './tools.js'`) stand
//     for the reader's own modules and are declared as `any`.
//   - Mark an intentionally partial block with ```ts nocheck to skip it.
//   - A ```json block tagged `config` (```json config) is checked as
//     an object literal against the config type accepted by Orchestrator.create,
//     so unknown or misspelled keys fail.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'node_modules', '.cache', 'check-docs');

function markdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (relative(root, full) !== join('docs', 'es')) files.push(...markdownFiles(full));
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

const AMBIENT = [
  ['orch', "declare const orch: import('agent349').Orchestrator;"],
  ['identity', 'declare const identity: { tenantId: string; userId: string; roles: string[] };'],
  ['context', "declare const context: import('agent349').ExecutionContext;"],
];

const blocks = [];
for (const file of [join(root, 'README.md'), ...markdownFiles(join(root, 'docs'))]) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^```\s*(\S*)\s*(.*)$/.exec(line);
    if (!fence) {
      if (open) open.body.push(line);
      return;
    }
    if (open) {
      if (open.check) blocks.push(open);
      open = null;
    } else {
      const lang = fence[1];
      const isTs = (lang === 'ts' || lang === 'typescript') && !fence[2].includes('nocheck');
      const isConfig = (lang === 'json' || lang === 'jsonc') && /\bconfig\b/.test(fence[2]);
      open = {
        file: relative(root, file),
        line: i + 1,
        check: isTs || isConfig,
        config: isConfig,
        body: [],
      };
    }
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const CONFIG_TYPE = "Exclude<Parameters<typeof import('agent349').Orchestrator.create>[0], string>";

const files = blocks.map((b, i) => {
  const code = b.config
    ? `const config: ${CONFIG_TYPE} = ${b.body.join('\n')};\nvoid config;`
    : b.body
        .join('\n')
        .replace(/^import (?:type )?\{([^}]*)\} from '\.{1,2}\/[^']*';$/gm, (_, names) =>
          names
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((n) => `declare const ${n}: any;`)
            .join(' '),
        );
  const ambient = AMBIENT.filter(
    ([name]) =>
      new RegExp(`\\b${name}\\b`).test(code) &&
      !new RegExp(
        `\\b(?:const|let|var|function|class|import\\b[^;]*?)\\s+[{,]?[^;=()]*\\b${name}\\b`,
      ).test(code),
  ).map(([, decl]) => decl);
  const name = `block${String(i).padStart(3, '0')}.ts`;
  b.offset = 1 + Math.max(ambient.length, 1);
  writeFileSync(
    join(outDir, name),
    `// ${b.file}:${b.line}\n${ambient.join('\n')}\n${code}\nexport {};\n`,
  );
  return name;
});

writeFileSync(
  join(outDir, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: join(root, 'tsconfig.json'),
      compilerOptions: {
        rootDir: root,
        noEmit: true,
        declaration: false,
        declarationMap: false,
        noUnusedLocals: false,
        types: ['node'],
        baseUrl: root,
        paths: { agent349: ['src/index.ts'] },
      },
      files,
    },
    null,
    2,
  ),
);

// Strips // and /* */ comments from JSONC without touching string contents.
function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return out;
}

// Runs every config block through the real ConfigLoader, which also checks
// cross-references (e.g. a layer pointing at an undeclared storage backend).
function validateConfigBlocks() {
  const configs = blocks.filter((b) => b.config);
  const payload = configs.map((b) => ({
    where: `${b.file}:${b.line}`,
    json: stripJsonComments(b.body.join('\n')),
  }));
  const script = join(outDir, 'validate-config.mts');
  writeFileSync(
    script,
    `import { ConfigLoader } from ${JSON.stringify(join(root, 'src', 'index.ts'))};\n` +
      `const blocks = ${JSON.stringify(payload)};\n` +
      // Placeholders like ${MONGO_URI} must resolve to something plausible.
      `for (const b of blocks) for (const [, v] of b.json.matchAll(/\\$\\{([A-Z0-9_]+)\\}/g)) {\n` +
      `  process.env[v] ??= /URL|URI/.test(v) ? (v.includes('MONGO') ? 'mongodb://docs.invalid/db' : 'https://docs.invalid') : 'placeholder';\n` +
      `}\n` +
      `let failed = 0;\n` +
      `for (const b of blocks) {\n` +
      `  try { ConfigLoader.from(JSON.parse(b.json)).get(); }\n` +
      `  catch (e) { failed++; console.error(b.where + ': ' + (e instanceof Error ? e.message : String(e))); }\n` +
      `}\n` +
      `process.exit(failed === 0 ? 0 : 1);\n`,
  );
  execFileSync(join(root, 'node_modules', '.bin', 'tsx'), [script], { stdio: 'inherit' });
  return configs.length;
}

try {
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(outDir, 'tsconfig.json')], {
    stdio: 'pipe',
  });
  let configCount;
  try {
    configCount = validateConfigBlocks();
  } catch {
    process.exit(1);
  }
  console.log(
    `docs: ${blocks.length} blocks type-check against src/; ${configCount} config blocks load`,
  );
} catch (err) {
  const output = String(err.stdout ?? '') + String(err.stderr ?? '');
  // Point each diagnostic back at the Markdown source.
  const byFile = new Map(files.map((f, i) => [f, blocks[i]]));
  for (const line of output.split('\n')) {
    const m = /(block\d+\.ts)\((\d+),(\d+)\): (.*)/.exec(line);
    if (m) {
      const b = byFile.get(m[1]);
      console.error(
        `${b.file} (block at line ${b.line}, snippet line ${Number(m[2]) - b.offset}): ${m[4]}`,
      );
    } else if (line.trim()) {
      console.error(line);
    }
  }
  process.exit(1);
}
