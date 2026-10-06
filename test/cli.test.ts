/**
 * CLI 入口契约测试（此前零覆盖）— palace-cli end-to-end.
 *
 * src/bin/palace-cli.ts is the only repository entry point that had ZERO
 * test coverage while accumulating real-world fixes — BOM stripping,
 * directory format-flag inheritance, the --topk guard, and sessionId
 * anti-collision — none of which were ever locked by a regression test.
 *
 * Each case runs the REAL CLI in a child process:
 *
 *     node --import tsx src/bin/palace-cli.ts <args>      (cwd = repo root)
 *
 * so argv parsing, format sniffing, the two-phase ingest pipeline and the
 * v3 retrieval kernel are exercised exactly the way a shell user drives
 * them. Conventions:
 *
 *  - spawnSync with an argv ARRAY and no shell — quoting-safe on Windows.
 *  - The child env blanks DEEPSEEK_API_KEY and drops MEMORY_PALACE_DIMS /
 *    NODE_OPTIONS so every run uses the deterministic offline-bm25 embedder
 *    at the default 1024 dimensions.
 *  - Every test gets its own mkdtemp directory (database + fixtures),
 *    removed in t.after — by then the child processes have exited, so no
 *    open WAL handle can block rmSync on Windows.
 *  - All fixtures are fixed content: scores may shift, counts must not.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'src', 'bin', 'palace-cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run palace-cli as a real child process (no shell — Windows-safe). */
function runCli(args: string[]): CliResult {
  const env = { ...process.env } as Record<string, string | undefined>;
  // '' is falsy → buildRuntime picks the offline-bm25 embedder; a stale
  // developer-side DEEPSEEK_API_KEY must not leak network calls into CI.
  env['DEEPSEEK_API_KEY'] = '';
  delete env['MEMORY_PALACE_DIMS'];
  delete env['NODE_OPTIONS'];
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fresh per-test scratch directory, removed when the test ends. */
function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'palace-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Parse the ingest summary line
 *   `ingested: M messages + D doc sections → S semantic items, E entities`
 * into its numeric core (also asserts the line exists).
 */
function ingestSummary(stdout: string): {
  messages: number;
  docs: number;
  semantic: number;
  entities: number;
} {
  const m = stdout.match(
    /ingested: (\d+) messages \+ (\d+) doc sections → (\d+) semantic items, (\d+) entities/,
  );
  assert.ok(m, `ingest summary line not found in stdout:\n${stdout}`);
  return {
    messages: Number(m[1]),
    docs: Number(m[2]),
    semantic: Number(m[3]),
    entities: Number(m[4]),
  };
}

/** Hit count from the query header `… → N hits, …` (the CLI double-spaces
 *  around the arrow, so accept any whitespace run). */
function hitCount(stdout: string): number {
  const m = stdout.match(/→\s+(\d+) hits/);
  assert.ok(m, `query hit-count line not found in stdout:\n${stdout}`);
  return Number(m[1]);
}

// ------------------------------------------------------------------ fixtures

/** Two "## " sections with ≥40-char bodies and rare, queryable tokens. */
const QUOKKA_MD = [
  '## Quokka Gateway Deployment',
  '',
  'The quokka gateway ships through the zephyrblade pipeline on every lunar cycle,',
  'pinning harbor chart version nine before the teal rotors rotate. Nightly checks',
  'verify the marsala checksums and rehearse the full rollback procedure.',
  '',
  '## Nebula Backup Rotation',
  '',
  'The nebula backup rotation swaps the amber tapes while the lighthouse keeper',
  'records the checksum ledger by hand, humming the old observatory shanty.',
  '',
].join('\n');

/** A minimal claude-format export with one message per conversation. */
const CLAUDE_EXPORT = JSON.stringify([
  {
    name: 'Conv One',
    chat_messages: [
      {
        sender: 'human',
        text: 'first conversation about the amber lighthouse keeper rotation duty',
        created: '2026-01-02T03:04:05Z',
      },
    ],
  },
  {
    name: 'Conv Two',
    chat_messages: [
      {
        sender: 'assistant',
        text: 'second conversation about the observatory shanty and the ledger',
        created: '2026-01-02T05:06:07Z',
      },
    ],
  },
]);

/** Ingest QUOKKA_MD into <dir>/palace.db under user u1; asserts success. */
function ingestRunbook(dir: string): CliResult {
  writeFileSync(join(dir, 'runbook.md'), QUOKKA_MD, 'utf8');
  const r = runCli(['ingest', '--db', join(dir, 'palace.db'), '--user', 'u1', '--md', join(dir, 'runbook.md')]);
  assert.equal(r.status, 0, `ingest failed, stderr:\n${r.stderr}`);
  return r;
}

// --------------------------------------------------------------------- tests

test('ingest → query → stats: markdown round trip', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');

  const ing = ingestRunbook(dir);
  const sum = ingestSummary(ing.stdout);
  assert.equal(sum.messages, 0, 'md path ingests docs, not messages');
  assert.equal(sum.docs, 2, 'both ## sections become doc sections');
  assert.equal(sum.semantic, 2, 'each doc section lands as one semantic item');

  const q = runCli(['query', '--db', db, '--user', 'u1', 'quokka gateway zephyrblade deployment']);
  assert.equal(q.status, 0, `query failed, stderr:\n${q.stderr}`);
  assert.ok(hitCount(q.stdout) >= 1, 'keyword query finds the ingested section');
  assert.match(q.stdout, /\[\d+\.\d{3}\]/, 'each hit prints a finalScore');
  assert.match(q.stdout, /zephyrblade/, 'each hit prints a content snippet');

  const st = runCli(['stats', '--db', db]);
  assert.equal(st.status, 0, `stats failed, stderr:\n${st.stderr}`);
  const stats = JSON.parse(st.stdout) as {
    items: Record<string, number>;
    entities: number;
    topEntities: unknown[];
  };
  assert.equal(stats.items.semantic, sum.semantic, 'stats JSON agrees with ingest summary');
  assert.equal(stats.entities, sum.entities);
  assert.ok(Array.isArray(stats.topEntities), 'stats JSON carries graph topEntities');
});

test('jsonl ingest skips malformed lines but keeps the good ones', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  const f = join(dir, 'session-log.jsonl');
  const lines = [
    JSON.stringify({ role: 'user', content: 'user asks about the harbor chart pinning ritual in detail' }),
    '{ this line is definitively not valid json',
    JSON.stringify({ role: 'assistant', content: 'assistant explains the rollback procedure for teal rotors' }),
  ];
  writeFileSync(f, lines.join('\n'), 'utf8');

  const r = runCli(['ingest', '--db', db, '--jsonl', f]);
  assert.equal(r.status, 0, `bad jsonl line must not fail the ingest, stderr:\n${r.stderr}`);
  assert.ok(
    r.stdout.includes(`[jsonl] ${f}: 2 messages`),
    `good lines still ingested, stdout:\n${r.stdout}`,
  );
  assert.equal(ingestSummary(r.stdout).messages, 2);
});

test('BOM regression: identical stats with and without a UTF-8 BOM', (t) => {
  const dirPlain = tmpDir(t);
  const dirBom = tmpDir(t);
  // Same FILE NAME in both dirs: only the leading BOM differs, so any
  // stat divergence is attributable to the BOM alone.
  writeFileSync(join(dirPlain, 'doc.md'), QUOKKA_MD, 'utf8');
  writeFileSync(join(dirBom, 'doc.md'), '\uFEFF' + QUOKKA_MD, 'utf8');

  const plain = runCli(['ingest', '--db', join(dirPlain, 'palace.db'), '--md', join(dirPlain, 'doc.md')]);
  const bom = runCli(['ingest', '--db', join(dirBom, 'palace.db'), '--md', join(dirBom, 'doc.md')]);
  assert.equal(plain.status, 0, `stderr:\n${plain.stderr}`);
  assert.equal(bom.status, 0, `stderr:\n${bom.stderr}`);

  const sumPlain = ingestSummary(plain.stdout);
  const sumBom = ingestSummary(bom.stdout);
  // Pre-fix, the BOM welded itself onto the first "## " heading, failing
  // the /^##\s+/ match: the first section merged into the file-title
  // section and doc/semantic/entity counts diverged from the plain file.
  assert.equal(sumBom.docs, 2, 'BOM must not swallow the first ## heading');
  assert.deepEqual(sumBom, sumPlain, 'BOM and BOM-free ingest stats must be identical');
});

test('--claude <dir> forces the claude parser on every file inside', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  const exportsDir = join(dir, 'exports');
  mkdirSync(exportsDir);
  writeFileSync(join(exportsDir, 'conversations.json'), CLAUDE_EXPORT, 'utf8');
  // Same claude payload under a name content sniffing can NOT rescue
  // (it does not end in conversations.json and the text starts with
  // '[', so extension sniffing would fall through to the md parser).
  // Only an explicit --claude that SURVIVES directory expansion can
  // parse this file as claude — this is the regression lock.
  writeFileSync(join(exportsDir, 'manual-export.json'), CLAUDE_EXPORT, 'utf8');

  const forced = runCli(['ingest', '--db', db, '--claude', exportsDir]);
  assert.equal(forced.status, 0, `stderr:\n${forced.stderr}`);
  assert.ok(
    forced.stdout.includes(`[claude] ${join(exportsDir, 'manual-export.json')}: 2 messages`),
    `explicit format must apply to non-sniffable files inside the directory, stdout:\n${forced.stdout}`,
  );
  assert.equal(ingestSummary(forced.stdout).messages, 4, 'both exports parsed as claude');

  // Control: no format flag — the conversations.json name + chat_messages
  // content sniff must still ingest successfully (path not asserted).
  const sniffed = runCli(['ingest', '--db', join(dir, 'palace2.db'), exportsDir]);
  assert.equal(sniffed.status, 0, `stderr:\n${sniffed.stderr}`);
  assert.ok(ingestSummary(sniffed.stdout).messages >= 2, 'content sniffing ingests the export');
});

test('--topk guard: bad values degrade loudly instead of SqliteError', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  ingestRunbook(dir);

  for (const bad of ['abc', '0']) {
    const q = runCli(['query', '--db', db, '--user', 'u1', '--topk', bad, 'quokka gateway deployment']);
    assert.ok(
      q.status === 0 || q.status === 1,
      `--topk ${bad}: clean exit expected, got status=${q.status}, stderr:\n${q.stderr}`,
    );
    assert.doesNotMatch(q.stderr, /SqliteError/, `--topk ${bad} must not surface a SqliteError stack`);
    assert.match(q.stderr, new RegExp(`invalid --topk "${bad}"`), `--topk ${bad} warns about the bad value`);
    assert.match(q.stderr, /falling back to 5/, `--topk ${bad} announces the fallback`);
    assert.ok(hitCount(q.stdout) >= 1, `--topk ${bad} fallback still returns results`);
  }
});

test('sessionId anti-collision: same-prefix long conversations stay separate', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  // The two titles share their first 80 characters (well past the old
  // whole-string slice(0, 80) truncation width AND past the current
  // base.slice(0, 64)) and differ only in the tail — exactly the shape
  // the truncate-then-hash sessionIdFor fix exists to keep apart. (Sharing
  // only the first 60 would NOT have collided even in the old code.)
  const shared = 'S'.repeat(80);
  const nameA = `${shared}-alpha-tail`;
  const nameB = `${shared}-beta-tail`;
  assert.ok(nameA.length > 80 && nameB.length > 80);
  writeFileSync(
    join(dir, 'conversations.json'),
    JSON.stringify([
      {
        name: nameA,
        chat_messages: [
          {
            sender: 'human',
            text: 'alpha marker: the crimson ferret audits the ledger at dawn',
            created: '2026-01-02T03:04:05Z',
          },
        ],
      },
      {
        name: nameB,
        chat_messages: [
          {
            sender: 'human',
            text: 'beta marker: the cobalt heron inspects the tide gates at noon',
            created: '2026-01-02T03:04:06Z',
          },
        ],
      },
    ]),
    'utf8',
  );

  const r = runCli(['ingest', '--db', db, '--claude', join(dir, 'conversations.json')]);
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  assert.equal(ingestSummary(r.stdout).messages, 2);

  // Direct DB assertion: truncation must not merge the two conversations
  // into one session (a shared session would also silently coalesce their
  // query_log trajectories, so the count is the sharpest observable).
  const raw = new Database(db);
  try {
    const row = raw
      .prepare('SELECT COUNT(DISTINCT session_id) AS n FROM episodic_events')
      .get() as { n: number };
    assert.equal(row.n, 2, 'same-prefix long titles must map to 2 distinct session ids');
  } finally {
    raw.close();
  }
});

test('query --explain prints the score decomposition', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  ingestRunbook(dir);

  const q = runCli(['query', '--db', db, '--user', 'u1', 'quokka gateway zephyrblade', '--explain']);
  assert.equal(q.status, 0, `stderr:\n${q.stderr}`);
  assert.ok(hitCount(q.stdout) >= 1, 'explain mode still returns hits');
  assert.match(q.stdout, /raw=\d+\.\d{3}/, 'raw (pre-fusion) score present');
  assert.match(q.stdout, /decay=\d+\.\d{2}/, 'time-decay factor present');
  assert.match(q.stdout, /imp=\d+\.\d{2}/, 'importance factor present');
  assert.match(q.stdout, /graph=\d+\.\d{2}/, 'graph multiplier present');
});

test('--explain is boolean: it must not swallow the first query word', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  ingestRunbook(dir);

  // Pre-fix, the collector skipped the token after ANY '--' flag, so
  // "zephyrblade" was eaten as --explain's "value" and the query ran as
  // "deployment notes" — the echoed query line is the direct proof the
  // word survived the parser.
  const q = runCli(['query', '--db', db, '--user', 'u1', '--explain', 'zephyrblade deployment notes']);
  assert.equal(q.status, 0, `stderr:\n${q.stderr}`);
  assert.match(
    q.stdout,
    /query: "zephyrblade deployment notes"/,
    'the token after the boolean --explain flag is query text, not its value',
  );
  assert.ok(hitCount(q.stdout) >= 1, 'the full query still returns hits');
  assert.match(q.stdout, /\[\d+\.\d{3}\].*zephyrblade/, 'a hit line carries the queried token');
});

test('usage paths fail fast with a hint and no crash stack', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  const cases: Array<{ label: string; args: string[]; hint: RegExp }> = [
    { label: 'no command', args: [], hint: /usage: palace-cli <ingest\|query\|stats>/ },
    { label: 'ingest without inputs', args: ['ingest', '--db', db], hint: /no inputs/ },
    { label: 'query without text', args: ['query', '--db', db], hint: /usage: palace-cli query/ },
  ];
  for (const c of cases) {
    const r = runCli(c.args);
    assert.equal(r.status, 1, `${c.label}: expected exit 1, stderr:\n${r.stderr}`);
    assert.match(r.stderr, c.hint, `${c.label}: usage hint expected`);
    assert.doesNotMatch(r.stderr, /SqliteError/, `${c.label}: no SqliteError`);
    assert.doesNotMatch(r.stderr, /\n\s+at /, `${c.label}: no stack frames`);
  }
});

test('mid-ingest failure still drains the store (close in finally)', (t) => {
  const dir = tmpDir(t);
  const db = join(dir, 'palace.db');
  // A .json file whose content is not valid JSON: the explicit --claude
  // flag routes it to parseClaudeExport, whose JSON.parse throws AFTER
  // buildRuntime opened the SQLite store and BEFORE the command's tail
  // used to close it — exactly the mid-command exception path the
  // try/finally drain-close discipline exists for (jsonl skips bad lines;
  // a nonexistent path fails in collectInputs, which is pre-parse but
  // also post-open — the JSON SyntaxError is the sharpest constructor).
  writeFileSync(join(dir, 'conversations.json'), '{"unterminated": ', 'utf8');

  const r = runCli(['ingest', '--db', db, '--claude', join(dir, 'conversations.json')]);
  assert.notEqual(r.status, 0, 'bad claude export must exit non-zero');
  assert.notEqual(r.status, null, 'the process must terminate (not hang)');
  assert.match(r.stderr, /SyntaxError/, 'the surfaced failure is the JSON parse error');
  assert.doesNotMatch(r.stderr, /SqliteError/, 'no SqliteError may leak from the close path');

  // The store WAS opened before the throw, so the failure exercised the
  // post-open exception path (not a usage bail-out before buildRuntime).
  assert.ok(existsSync(db), 'the database was created before the parse threw');
  // Strongest observable of close-in-finally: the store runs in WAL mode,
  // and SQLite checkpoints and REMOVES the -wal file on the last clean
  // connection close. Nothing in the tree registers a process-exit hook,
  // so a path that skipped store.close() would leave the -wal behind —
  // OS-exit reclaiming an open handle is not a close.
  assert.ok(!existsSync(`${db}-wal`), 'WAL drained: store.close() ran in the finally block');
});
