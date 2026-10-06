/**
 * PHYSICAL-layer fault injection — the store meets process death and byte
 * rot. Every other suite in this directory (chaos.test.ts above all)
 * exercises LOGICAL faults: malformed inputs, adversarial call orders,
 * ACL abuse, pipeline-level fuzz storms. None of them ever killed a
 * process or flipped a byte on disk. This suite does exactly that, at the
 * four places where physics meets the store:
 *
 *   1. CRASH MID-TRANSACTION — a spawnSync'd child process opens a real
 *      MemoryStore, starts ingestTx, writes 10 items, then process.exit(7)
 *      INSIDE the transaction (no COMMIT, no close, no rollback: the
 *      un-cleanest death a WAL writer can suffer). The parent reopens the
 *      same file and proves WAL crash-recovery semantics: committed data
 *      intact, uncommitted batch invisible, version stamp un-committed,
 *      integrityCheck runnable.
 *   2. BYTE-LEVEL CELL CORRUPTION — a second better-sqlite3 connection
 *      overwrites 3 metadata cells with 'BROKEN{', one tree_nodes.child_ids
 *      with 'not json', one entities.aliases with '{oops'. Every read path
 *      must degrade (safeJson) instead of throwing; integrityCheck must
 *      flag; repairIntegrity must reset child_ids to '[]' WITHOUT losing
 *      the metadata-corrupted rows (they stay readable, degraded).
 *   3. user_version BOUNDARY — the 32-bit cache-invalidation stamp
 *      pushed THROUGH the ceiling under the epoch-namespace scheme: the
 *      wrap writes user_version = 0 and persistently increments an epoch
 *      (palace_meta), every cache compares the composite
 *      `<epoch>:<version>` string stamp, so pre-wrap entries CANNOT
 *      compare fresh after the wrap (the old false-fresh "theoretical
 *      edge" is structurally unreachable now). Also proves the epoch is
 *      durable across connections and that THIS process adopts a NEW
 *      epoch stamped by a foreign connection's wrap (multi-process
 *      refresh path: version-decrease detection → meta re-read).
 *   4. BACKUP FROM A CORRUPTED STORE — backupTo snapshots the scenario-2
 *      database; the snapshot must mount, keep the item count, degrade the
 *      same corrupt cells, and pass integrityCheck/repair (corruption is
 *      not a reason to be un-mountable).
 *   5. REPEATED CRASH CYCLES — three consecutive mid-tx kills followed by
 *      reopen-and-write; the store stays healthy and the -wal residue of
 *      each unclean death is observable (wal_autocheckpoint keeps the log
 *      bounded; only existence is asserted, never size).
 *
 * Method notes:
 *   - Child scripts are generated into the test's own $TEMP dir and run as
 *     `node --import tsx <script>` with cwd = the project root (so the tsx
 *     bare specifier resolves from node_modules). The store module is
 *     imported through a file:// URL because a Windows absolute path is
 *     not a valid ESM specifier.
 *   - VACUOUS-PASS GUARD: if the child fails to SPAWN, every downstream
 *     atomicity assertion would be trivially green (nothing was ever
 *     written). Each crash test therefore asserts r.error === undefined
 *     and the exact exit status BEFORE looking at the database.
 *   - Windows teardown follows the genesis-integrity.test.ts order: every
 *     store-close hook is registered BEFORE the directory-removal hook
 *     (hooks run in registration order), or rmSync fights an open WAL
 *     handle (EPERM). Stores created mid-test are collected in an array
 *     whose closer was registered up front.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncResult } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { MemoryStore } from '../src/services/memory-store.ts';
import { SemanticQueryCache } from '../src/utils/query-cache.ts';
import { scopeLevels, widestLevel } from '../src/utils/scope.ts';
import type { MemoryItem } from '../src/types/index.ts';

// ───────────────────────────── helpers ─────────────────────────────

const DIMS = 64;

/**
 * Project root — spawn cwd so the child's `--import tsx` resolves from
 * node_modules. Derived from THIS file (test/…), not process.cwd(): the
 * test runner may be launched from anywhere. Note dirname(fileURLToPath(
 * new URL('../', …))) is a trap — the directory URL stringifies with a
 * trailing separator and dirname then strips to the GRANDparent.
 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** file:// URL of the store module (valid ESM specifier on Windows). */
const STORE_MODULE_URL = pathToFileURL(
  join(PROJECT_ROOT, 'src', 'services', 'memory-store.ts'),
).href;

let fixtureSeq = 0;

/** Deterministic store item fixture (fixed clock, caller supplies the rest). */
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = 1_700_000_000_000 + fixtureSeq++;
  return {
    id: `fault-${fixtureSeq}`,
    layer: 'semantic',
    content: 'fault-injection fixture content',
    metadata: { source: 'user' },
    createdAt: now,
    updatedAt: now,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/** Throwaway dir for tests that manage their own store lifetimes + cleanup. */
function freshDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `fault-injection-${label}-`));
}

/**
 * Generate the crasher child script into the test's own temp dir. The
 * script is parameterized through FI_* env vars so one generated file
 * serves every round: it opens the store at FI_DB_PATH, writes FI_COUNT
 * items (ids FI_PREFIX-0..) inside ingestTx, and dies via process.exit(
 * FI_EXIT) mid-transaction — deliberately not committing, not closing.
 */
function writeCrasherScript(dir: string): string {
  const script = join(dir, 'crash-mid-tx.ts');
  writeFileSync(
    script,
    `/**
 * Fault-injection CHILD process — generated by test/fault-injection.test.ts.
 * Opens the real MemoryStore, writes FI_COUNT items inside ingestTx, then
 * process.exit(FI_EXIT) BEFORE the transaction can commit and before any
 * close(): the process dies exactly like a SIGKILL'd writer mid-batch.
 */
import { MemoryStore } from ${JSON.stringify(STORE_MODULE_URL)};

const store = new MemoryStore({
  storagePath: process.env.FI_DB_PATH!,
  dimensions: 64,
  scope: 'user',
});
store.ingestTx(() => {
  const n = Number(process.env.FI_COUNT ?? '10');
  const prefix = process.env.FI_PREFIX ?? 'crash-tx';
  for (let i = 0; i < n; i++) {
    const ts = 1_700_000_100_000 + i;
    store.insertItem(
      {
        id: prefix + '-' + i,
        layer: 'semantic',
        content: 'uncommitted payload ' + prefix + ' #' + i,
        metadata: { source: 'fault-injection' },
        createdAt: ts,
        updatedAt: ts,
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: ts,
      },
      { userId: 'fi-crash' },
    );
  }
  // Mid-transaction death: no COMMIT, no rollback, no close().
  process.exit(Number(process.env.FI_EXIT ?? '7'));
});
`,
  );
  return script;
}

/** Spawn the crasher child; utf8 encoding → stdout/stderr are strings. */
function crashMidTx(opts: {
  dbPath: string;
  script: string;
  prefix: string;
  exitCode: number;
  count?: number;
}): SpawnSyncResult<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', opts.script], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      FI_DB_PATH: opts.dbPath,
      FI_PREFIX: opts.prefix,
      FI_EXIT: String(opts.exitCode),
      FI_COUNT: String(opts.count ?? 10),
    },
    encoding: 'utf8',
    // tsx cold start + 10 inserts should be seconds; 120s is a hang guard.
    timeout: 120_000,
  });
}

// ───────────────── 1: process death mid-transaction ─────────────────

test('crash-mid-tx: child dies inside ingestTx, WAL recovery keeps committed data and discards the batch', (t) => {
  const dir = freshDir('crash-tx');
  const dbPath = join(dir, 'store.db');
  // Stores created MID-test collect here: this closer is registered BEFORE
  // the dir rm (Windows WAL ordering, see header) — a per-instance
  // t.after(f.close) registered at creation time would run AFTER the rm.
  const openedLater: MemoryStore[] = [];
  t.after(() => {
    for (const s of openedLater) s.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Phase 1 — a previous session writes committed data, then closes.
  const phase1 = new MemoryStore({
    storagePath: dbPath,
    dimensions: DIMS,
    scope: 'user',
  });
  const priorIds = ['fi-prior-0', 'fi-prior-1', 'fi-prior-2'];
  for (const id of priorIds) {
    phase1.insertItem(makeItem({ id, layer: 'semantic', content: `prior ${id}` }), {
      userId: 'fi-prior',
    });
  }
  const versionBefore = phase1.dataVersion();
  phase1.close();

  // Phase 2 — a separate process dies mid-transaction (exit code 7).
  const r = crashMidTx({
    dbPath,
    script: writeCrasherScript(dir),
    prefix: 'crash-tx',
    exitCode: 7,
    count: 10,
  });
  // VACUOUS-PASS GUARD: a spawn failure (status null) would make every
  // assertion below trivially green — the crash itself is asserted first,
  // with the child's stderr embedded for diagnosis when it dies wrongly.
  const childTail = (r.stderr ?? '').slice(-600);
  assert.equal(r.error, undefined, 'child process spawned (no ENOENT/exec error)');
  assert.equal(r.status, 7, `child really died mid-ingestTx with exit code 7 (stderr tail: ${childTail})`);
  assert.equal(r.signal, null, 'no signal — the child exited by itself');
  // Unclean death leaves the WAL file behind (no checkpoint-and-delete
  // ever ran) — physical evidence of the crash on disk.
  assert.ok(existsSync(dbPath + '-wal'), 'WAL residue exists after the crash');

  // Phase 3 — the parent reopens the SAME file.
  const reopened = new MemoryStore({
    storagePath: dbPath,
    dimensions: DIMS,
    scope: 'user',
  });
  openedLater.push(reopened);

  // (a) implicit: the constructor above did not throw.

  // (b) atomicity — the 10 uncommitted rows are invisible everywhere.
  const live = reopened.listItemsByLayer('semantic');
  assert.equal(
    live.filter((i) => i.id.startsWith('crash-tx-')).length,
    0,
    'no uncommitted row leaks into listItemsByLayer',
  );
  assert.equal(
    reopened.countByLayer().semantic,
    priorIds.length,
    'countByLayer sees only committed rows',
  );
  assert.equal(reopened.getItem('crash-tx-0'), null, 'getItem: uncommitted id absent (not just filtered)');
  assert.equal(reopened.getItem('crash-tx-9', { liveOnly: true }), null, 'liveOnly read: absent too');

  // (c) previously committed data is intact, byte for byte.
  const seen = new Set(live.map((i) => i.id));
  for (const id of priorIds) assert.ok(seen.has(id), `prior row survived: ${id}`);
  const p0 = reopened.getItem('fi-prior-0');
  assert.ok(p0, 'prior item readable');
  assert.equal(p0!.content, 'prior fi-prior-0');
  assert.equal(p0!.metadata.source, 'user');

  // The crashed batch's version stamp never committed either — WAL
  // recovery rolled the WHOLE transaction back, bump included.
  assert.equal(
    reopened.dataVersion(),
    versionBefore,
    'dataVersion untouched by the crashed batch',
  );

  // (d) integrityCheck runs on the recovered store and is clean.
  const ic = reopened.integrityCheck();
  assert.equal(ic.ok, true, 'recovered store passes integrityCheck');
});

// ───────────────── 2: byte-level metadata corruption ─────────────────

test('byte-corruption: safeJson degrades every read path, integrity flags, repair heals child_ids without losing rows', (t) => {
  const dir = freshDir('corrupt');
  const dbPath = join(dir, 'store.db');
  const store = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Seed through the public API: 5 items, 1 entity, 1 tree parent whose
  // child_ids reference a live item (pre-corruption the refs are valid).
  const itemIds = ['cor-item-0', 'cor-item-1', 'cor-item-2', 'cor-item-3', 'cor-item-4'];
  for (const id of itemIds) {
    store.insertItem(makeItem({ id, layer: 'semantic' }), { userId: 'fi-cor' });
  }
  store.upsertEntity(
    {
      id: 'cor-ent',
      name: 'Corrupt Entity',
      type: 'person',
      aliases: ['zed'],
      firstSeenAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_500,
      mentionCount: 1,
    },
    { visibility: 'user', userId: 'fi-cor' },
  );
  store.upsertTreeNode({
    nodeId: 'cor-week',
    level: 'week',
    periodStart: 0,
    periodEnd: 100,
    content: 'parent node',
    tokenCount: 3,
    childIds: ['cor-item-0'],
  });

  // PHYSICAL corruption: a foreign connection overwrites JSON cells with
  // garbage the way a partial write / external editor / bit rot would.
  const raw = new Database(dbPath);
  raw
    .prepare("UPDATE memory_items SET metadata = 'BROKEN{' WHERE id IN ('cor-item-0','cor-item-1','cor-item-2')")
    .run();
  raw.prepare("UPDATE tree_nodes SET child_ids = 'not json' WHERE node_id = 'cor-week'").run();
  raw.prepare("UPDATE entities SET aliases = '{oops' WHERE id = 'cor-ent'").run();
  raw.close();

  // Every read path survives — safeJson degrades instead of throwing.
  const listed = store.listItemsByLayer('semantic');
  assert.equal(listed.length, 5, 'no row lost to corrupt metadata cells');
  const counts = store.countByLayer();
  assert.equal(counts.semantic, 5);
  const st = store.stats();
  assert.equal(st.items.semantic, 5);
  assert.equal(st.entities, 1);

  const c0 = store.getItem('cor-item-0');
  assert.ok(c0, 'corrupt-metadata row is still readable');
  assert.equal(c0!.metadata.source, undefined, 'metadata degraded to {} (fixture source vanished)');
  assert.equal(c0!.content, 'fault-injection fixture content', 'non-JSON columns untouched');

  const nodes = store.listTreeNodes('week', undefined);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0]!.childIds, [], "child_ids 'not json' degrades to [] on read");

  const level = widestLevel(scopeLevels('user', { userId: 'fi-cor' }));
  const ents = store.listEntitiesScoped(level);
  assert.deepEqual(ents.map((e) => e.id), ['cor-ent']);
  assert.deepEqual(ents[0]!.aliases, [], "aliases '{oops' degrades to [] on read");

  // integrityCheck flags the unreadable cell as a dangling child (the
  // json_valid CASE guard counts a malformed child_ids row as 1).
  const ic = store.integrityCheck();
  assert.ok(ic.danglingTreeChildren >= 1, 'corrupt child_ids counted as dangling');
  assert.equal(ic.ok, false);

  // repairIntegrity resets the unreadable cell to '[]' (byte-level, not
  // just a degraded read) and does NOT drop the metadata-corrupted rows.
  const rep = store.repairIntegrity();
  assert.ok(rep.danglingTreeChildrenPruned >= 1, 'repair pruned the corrupt child_ids cell');
  const raw2 = new Database(dbPath);
  const healed = raw2.prepare("SELECT child_ids FROM tree_nodes WHERE node_id = 'cor-week'").get() as {
    child_ids: string;
  };
  raw2.close();
  assert.equal(healed.child_ids, '[]', 'the cell itself was rewritten to []');
  // Metadata cells are deliberately left corrupt on disk — degraded reads
  // are the contract; re-ingest is the healing path for content JSON.
  assert.ok(store.getItem('cor-item-1'), 'metadata-corrupted row survives repair');
  assert.equal(store.listItemsByLayer('semantic').length, 5, 'still no row lost after repair');

  // Convergence: check → repair → check is clean.
  const ic2 = store.integrityCheck();
  assert.equal(ic2.ok, true);
});

// ───────────────── 3: user_version boundary (epoch namespace transfer) ─────────────────

test('user_version boundary: epoch namespace transfer makes wrap-around false freshness unrepresentable', (t) => {
  const dir = freshDir('version-boundary');
  const dbPath = join(dir, 'store.db');
  const store = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // (e) DESIGN NOTE (supersedes this suite's old "theoretical edge"
  // comment). The PRAGMA user_version header field is a signed 32-bit
  // int; on this toolchain (Node 24 / better-sqlite3 12 / its bundled
  // SQLite) the overflowing write 2147483647 + 1 lands as 0 — the
  // monotonic counter RESETS once per ~2^31 write transactions. Under
  // the old raw-number stamp, an entry stored at small version V in a
  // PREVIOUS cycle would compare equal to the post-wrap version V and
  // read as fresh (false-fresh window). That hazard is no longer
  // documented-and-tolerated: it is CLOSED by epoch namespace transfer.
  // The wrap bumps a persistent epoch (palace_meta key
  // 'dataVersionEpoch') and every cache compares the composite string
  // stamp `<epoch>:<version>` — a wrapped counter moves the comparison
  // into a fresh namespace where all pre-wrap stamps mismatch by
  // construction. Clearing caches is unnecessary (old-epoch stamps can
  // only miss, never hit) and clamping was rejected (a frozen stamp
  // stops invalidating silently).

  // A foreign connection drags the 32-bit stamp to one below the ceiling.
  const raw = new Database(dbPath);
  raw.pragma('user_version = 2147483646');
  raw.close();

  const v0 = store.dataVersion();
  const s0 = store.dataVersionStamp();
  assert.equal(v0, 2147483646, 'header stamp visible across connections');
  // No meta row exists yet ⇒ epoch 0; the stamp is `<epoch>:<version>`.
  assert.equal(s0, '0:2147483646', 'composite stamp format is epoch:version');
  const epochBefore = Number(s0.split(':')[0]);

  // (c-pre) bump 1 — still below the ceiling: plain increment, same epoch.
  store.insertItem(makeItem({ id: 'uv-item-0', layer: 'semantic' }), { userId: 'fi-uv' });
  const v1 = store.dataVersion();
  const s1 = store.dataVersionStamp();
  assert.equal(v1, 2147483647, 'first bump lands exactly on INT32_MAX');
  assert.equal(s1, `${epochBefore}:2147483647`, 'same-epoch stamp at the ceiling');
  assert.notEqual(s1, s0, 'the bump changed the stamp');

  // (a) THE WRAP — one more bump through a public write path: the store
  // writes PRAGMA user_version = 0 AND increments the persistent epoch.
  store.insertItem(makeItem({ id: 'uv-item-1', layer: 'semantic' }), { userId: 'fi-uv' });
  const v2 = store.dataVersion();
  const s2 = store.dataVersionStamp();
  assert.equal(v2, 0, 'wrap happened: the counter reset to 0 at the ceiling');
  const epochAfter = Number(s2.split(':')[0]);
  assert.equal(epochAfter, epochBefore + 1, 'stamp epoch segment incremented by exactly 1');
  assert.ok(epochAfter > epochBefore, 'epochs only ever grow (namespace transfer is one-way)');

  // The new epoch is DURABLE: a second connection reads it from
  // palace_meta, and the wrapped counter is in the file header.
  const raw2 = new Database(dbPath);
  const metaRow = raw2
    .prepare("SELECT value FROM palace_meta WHERE key = 'dataVersionEpoch'")
    .get() as { value: string } | undefined;
  assert.equal(metaRow?.value, String(epochAfter), 'new epoch persisted in palace_meta (foreign-connection visible)');
  assert.equal(raw2.pragma('user_version', { simple: true }), 0, 'wrapped counter durable in the header');
  raw2.close();

  // (b) FALSE-FRESHNESS DEATH PROOF. An entry stored at a pre-wrap stamp
  // can never compare fresh after the wrap: the post-wrap stamp differs
  // from EVERY pre-wrap stamp (different epoch segment ⇒ string !==),
  // so the cache MUST treat it as stale and lazily drop it. Under the
  // old raw-number identity the version segments alone (2147483646 → 0)
  // also differed here — the point of the epoch proof is that the
  // inequality holds for EVERY future version too, not just at v=0.
  const cache = new SemanticQueryCache<string>({ capacity: 4, threshold: 0.99 });
  const vec = new Float32Array(DIMS).map((_, i) => Math.sin(i + 1));
  cache.store(vec, 'fi:params', s0, 'pre-wrap-value');
  assert.equal(cache.count, 1);
  assert.notEqual(s2, s0, 'post-wrap stamp ≠ pre-wrap stamp (namespace transfer invariant)');
  assert.notEqual(s2, s1, 'post-wrap stamp ≠ ceiling stamp either');
  assert.equal(cache.lookup(vec, 'fi:params', s2), undefined, 'pre-wrap entry misses at the wrapped stamp');
  assert.equal(cache.lookup(vec, 'fi:params', s1), undefined, '...and at the intermediate ceiling stamp');
  cache.store(vec, 'fi:params', s2, 'post-wrap-value');
  assert.equal(cache.lookup(vec, 'fi:params', s2), 'post-wrap-value', 'store/lookup at the wrapped stamp work');

  // (c) POST-WRAP CYCLE — keep bumping through public writes: the epoch
  // segment stays at its new value while the version segment counts
  // 0 → N, and the normal invalidation semantics continue (an entry is
  // stale under ANY newer stamp).
  const stamps: string[] = [];
  for (let i = 1; i <= 3; i++) {
    store.insertItem(makeItem({ id: `uv-post-${i}`, layer: 'semantic' }), { userId: 'fi-uv' });
    const si = store.dataVersionStamp();
    stamps.push(si);
    assert.equal(Number(si.split(':')[0]), epochAfter, `bump ${i}: epoch segment stable at the wrapped value`);
    assert.equal(Number(si.split(':')[1]), i, `bump ${i}: version segment increments (${i})`);
    assert.equal(cache.lookup(vec, 'fi:params', si), undefined, `entry stored at the wrapped stamp misses at ${si}`);
  }

  // (d) MULTI-PROCESS EPOCH REFRESH. A second connection performs its
  // OWN wrap the way another MemoryStore process would (pre-position at
  // the ceiling, then user_version = 0 + epoch+1 in one transaction).
  // THIS process detects it the only way it can: its next stamp read
  // observes version 0 < lastSeenVersion → re-reads palace_meta →
  // adopts the foreign epoch. Safety direction: the adopted stamp is
  // incomparable with every stamp this process issued before (all older
  // epochs), so old entries miss — never false-hit.
  const foreign = new Database(dbPath);
  foreign.pragma('user_version = 2147483647');
  foreign.transaction(() => {
    foreign.pragma('user_version = 0');
    foreign
      .prepare(
        `INSERT INTO palace_meta (key, value) VALUES ('dataVersionEpoch', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(epochAfter + 1));
  })();
  foreign.close();

  const sD = store.dataVersionStamp();
  assert.equal(store.dataVersion(), 0, 'foreign wrap visible through this connection (WAL header read)');
  assert.equal(sD, `${epochAfter + 1}:0`, 'local stamp adopted the foreign process epoch');
  assert.notEqual(sD, stamps[stamps.length - 1], 'foreign-wrapped stamp differs from every pre-wrap local stamp');

  // Safe-direction close-out: an entry stored under the last local stamp
  // cannot be served under the foreign-wrapped stamp.
  cache.store(vec, 'fi:params2', stamps[stamps.length - 1]!, 'local-namespace-value');
  assert.equal(cache.lookup(vec, 'fi:params2', sD), undefined, 'entry from the old namespace misses under the foreign epoch');
});

// ───────────────── 4: backup round-trip from a corrupted store ─────────────────

test('backup-from-corruption: snapshot mounts, keeps counts, degrades the same cells, passes integrity', (t) => {
  const dir = freshDir('backup-corrupt');
  const dbPath = join(dir, 'store.db');
  const store = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  // The snapshot store is mounted mid-test; its close must run before the
  // dir rm (Windows WAL ordering, see header), so instances are collected
  // here instead of registering a LATER (out-of-order) hook.
  const mounted: MemoryStore[] = [];
  t.after(() => store.close());
  t.after(() => {
    for (const m of mounted) m.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const id of ['bk-cor-0', 'bk-cor-1', 'bk-ok-0', 'bk-ok-1']) {
    store.insertItem(makeItem({ id, layer: 'semantic' }), { userId: 'fi-bk' });
  }
  store.upsertTreeNode({
    nodeId: 'bk-week',
    level: 'week',
    periodStart: 0,
    periodEnd: 100,
    content: 'parent',
    tokenCount: 2,
    childIds: ['bk-ok-0'],
  });

  // Corrupt two metadata cells + the tree cell (same shapes as scenario 2).
  const raw = new Database(dbPath);
  raw.prepare("UPDATE memory_items SET metadata = 'BROKEN{' WHERE id IN ('bk-cor-0','bk-cor-1')").run();
  raw.prepare("UPDATE tree_nodes SET child_ids = 'not json' WHERE node_id = 'bk-week'").run();
  raw.close();

  // Snapshot the corrupted store.
  const snap = join(dir, 'snapshot.db');
  store.backupTo(snap);
  assert.ok(existsSync(snap), 'snapshot written despite corrupt JSON cells');

  // Mount it: a fresh MemoryStore over the snapshot must construct, read,
  // count, degrade and integrity-check — corruption is never a reason to
  // be un-mountable (VACUUM INTO copies the bytes verbatim).
  const restored = new MemoryStore({ storagePath: snap, dimensions: DIMS, scope: 'user' });
  mounted.push(restored);

  assert.equal(restored.listItemsByLayer('semantic').length, 4, 'item count identical to the source');
  assert.equal(restored.countByLayer().semantic, 4);
  assert.equal(restored.stats().items.semantic, 4);

  const c0 = restored.getItem('bk-cor-0');
  assert.ok(c0, 'corrupt row present in the snapshot');
  assert.equal(c0!.metadata.source, undefined, 'same safeJson degradation as the source');
  const ok0 = restored.getItem('bk-ok-0');
  assert.equal(ok0!.metadata.source, 'user', 'healthy rows keep their metadata');

  const nodes = restored.listTreeNodes('week', undefined);
  assert.deepEqual(nodes[0]!.childIds, [], 'corrupt child_ids degrades in the snapshot too');

  const ic = restored.integrityCheck();
  assert.ok(ic.danglingTreeChildren >= 1, 'snapshot reports the corrupt cell');
  const rep = restored.repairIntegrity();
  assert.ok(rep.danglingTreeChildrenPruned >= 1, 'snapshot repairs it');
  assert.equal(restored.integrityCheck().ok, true, 'snapshot converges to clean');
});

// ───────────────── 5: repeated crash cycles ─────────────────

test('repeated-crashes: three mid-tx kills, reopen-and-write each time — store stays healthy, WAL path live', (t) => {
  const dir = freshDir('sigkill');
  const dbPath = join(dir, 'store.db');
  const script = writeCrasherScript(dir);
  // Mid-test stores collect here (close-before-rm ordering, see header).
  const openedLater: MemoryStore[] = [];
  t.after(() => {
    for (const s of openedLater) s.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Committed baseline from a clean session.
  const phase1 = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  phase1.insertItem(makeItem({ id: 'sk-base-0', layer: 'semantic' }), { userId: 'fi-sk' });
  phase1.insertItem(makeItem({ id: 'sk-base-1', layer: 'semantic' }), { userId: 'fi-sk' });
  phase1.close();

  for (let round = 0; round < 3; round++) {
    // Crash a child mid-transaction (distinct exit code per round proves
    // each round is a fresh death, not a cached result).
    const r = crashMidTx({
      dbPath,
      script,
      prefix: `sigkill-${round}`,
      exitCode: 7 + round,
      count: 10,
    });
    assert.equal(r.error, undefined, `round ${round}: child spawned`);
    assert.equal(
      r.status,
      7 + round,
      `round ${round}: child died mid-ingestTx (stderr tail: ${(r.stderr ?? '').slice(-600)})`,
    );
    // Each unclean death leaves its WAL residue on disk.
    assert.ok(existsSync(dbPath + '-wal'), `round ${round}: WAL file present after the crash`);

    // Reopen, write committed data, verify health — three full
    // crash→recover→write cycles on ONE file.
    const s = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
    s.insertItem(makeItem({ id: `sk-post-${round}`, layer: 'semantic' }), { userId: 'fi-sk' });
    assert.equal(s.integrityCheck().ok, true, `round ${round}: healthy after reopen+write`);
    assert.equal(
      s.listItemsByLayer('semantic').filter((i) => i.id.startsWith(`sigkill-${round}-`)).length,
      0,
      `round ${round}: uncommitted batch still invisible`,
    );
    s.close();
  }

  // Final state: baseline (2) + one committed post-crash row per round (3).
  const final = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  openedLater.push(final);
  assert.equal(final.countByLayer().semantic, 5, '2 baseline + 3 post-crash rows, nothing else');
  const ids = new Set(final.listItemsByLayer('semantic').map((i) => i.id));
  for (const expect of ['sk-base-0', 'sk-base-1', 'sk-post-0', 'sk-post-1', 'sk-post-2']) {
    assert.ok(ids.has(expect), `committed row present: ${expect}`);
  }
  for (const id of ids) assert.ok(!id.startsWith('sigkill-'), `no crash residue: ${id}`);
  assert.equal(final.integrityCheck().ok, true, 'store healthy after three crash cycles');
  // wal_autocheckpoint (1000 pages, set in the constructor) keeps the log
  // bounded while the connection is live; its observable here is simply
  // that WAL mode is active — the -wal file exists on the open store.
  assert.ok(existsSync(dbPath + '-wal'), 'WAL active on the reopened store');
});
