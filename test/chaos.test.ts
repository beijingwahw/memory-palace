/**
 * Pipeline-level CHAOS / SOAK FUZZ suite for the Memory Palace plugin.
 *
 * This is deliberately NOT a unit test: per seed it installs ONE real plugin
 * instance (mock Cordis context + throwaway SQLite database) and drives a
 * ~200-step random operation storm through the model-facing surface —
 * ingestMessage, the memory_retrieve / memory_remember / memory_forget /
 * memory_inspect / memory_sleep tools, session.end lifecycle wiring —
 * interleave with ~5% malformed inputs (empty query, 50 KB content, emoji /
 * surrogate pairs / SQL metacharacters, bogus layers), while cross-cutting
 * INVARIANTS are re-checked after EVERY step:
 *
 *   a) ACL never leaks: every retrieval hit visible to u-b is either
 *      u-b-owned or a tier u-b may read (re-verified with visibleAtLevel);
 *      anonymous callers only ever see the global tier.
 *   b) store.dataVersion() is monotonically non-decreasing (every mutation
 *      regime — items, tombstones, entities, edges, purge — only ever bumps).
 *   c) the store stays healthy: stats() every 50 steps is finite, integral
 *      and non-NaN; close() at teardown never throws.
 *   d) zero unhandled promise rejections process-wide while the storm runs
 *      (a process.on('unhandledRejection') collector is asserted empty and
 *      removed at the end).
 *   e) retrieval shape: hits.length <= topK, score within [0, 1.2] (fusion
 *      of clamped factors; bandit rails cap vectorWeight+keywordWeight well
 *      under the bound — 1e-9 epsilon absorbs float rounding only), and
 *      via is one of 'vector' | 'entity-hop'.
 *
 * Endgame: memory_inspect still runs, a full retrieval round re-proves the
 * ACL invariant for u-a / u-b / anonymous, and plugin disposal is idempotent.
 *
 * Genesis intent: any future change that breaks one of these cross-cutting
 * invariants turns this suite red IMMEDIATELY, no matter which internal
 * layer regressed.
 *
 * TWO-PHASE DRIVER (shrinkable by construction):
 *   - Phase 1, generatePlan(seed): a per-seed mulberry32 PRNG bakes ALL
 *     randomness — op picks, caller triples, monotonic clock ticks, op
 *     arguments, per-step ACL probe queries — into a plain data array of
 *     200 planned steps. Nothing consumes randomness at execution time, so
 *     replaying ANY subset of the plan is fully deterministic.
 *   - Phase 2, runStorm(env, plan, { skip, limit }): executes the plan
 *     against a freshly installed plugin instance, skipping `skip`ped plan
 *     indices and stopping after `limit` steps, re-checking every invariant
 *     checkpoint along the way.
 *
 * BUILT-IN SHRINKER (failure auto-minimization):
 *   - When an invariant fires the suite does NOT just throw: it first
 *     greedily minimizes the failing storm, then prints the minimal step
 *     sequence (op name + key parameters) to stderr, then re-throws the
 *     ORIGINAL assertion unchanged. Wall-clock budget ~30 s (on timeout the
 *     best-so-far sequence is printed and the original error thrown);
 *     CHAOS_SHRINK=0 disables shrinking entirely.
 *   - Every checkpoint error carries a category: 'acl' | 'version' |
 *     'stats' | 'shape' | 'contract:<op>' | 'endgame' | 'endgame-dispose' |
 *     'unhandled' | 'registration' | 'internal'. A shrunk replay only
 *     counts if it fails with the SAME category as the original.
 *   - Algorithm: (0) confirm the failure reproduces on a clean full replay;
 *     (1) binary-search the shortest failing plan prefix; (2) linear greedy
 *     scan over that prefix — try deleting each step, keep the deletion iff
 *     the remaining subset still fails with the same category.
 *   - 'unhandled' and 'endgame-dispose' are asserted against process-wide /
 *     disposal state that the replay harness deliberately does not re-run;
 *     failures in those categories skip shrinking and throw as-is.
 *
 * DETERMINISM / REPRODUCTION:
 *   - All randomness flows from hand-written mulberry32 PRNGs. No
 *     Date.now() in the driver: event timestamps come from an injected
 *     monotonic clock baked into the plan. The SHRINKER consults wall-clock
 *     time only to bound its own budget — a timeout never changes which
 *     steps run, it only stops the minimization early.
 *   - Seeds: default list 31337,1,7,42 — one sub-test per seed (~0.8 s
 *     each, keeping `npm test` cheap). CHAOS_SEEDS=<a,b,c,…> overrides the
 *     list (the CI fuzz gate runs 8); legacy CHAOS_SEED=<n> pins a single
 *     trajectory and wins over the list.
 *   - To reproduce: CHAOS_SEEDS=<n> npm run fuzz
 *     (fuzz === node --import tsx --test test/chaos.test.ts).
 *
 * Windows: teardown follows the integration.test.ts pattern — the store
 * close hook is registered BEFORE the tempdir rm hook (hooks run in
 * registration order), so rmSync never fights an open WAL handle. Replay
 * environments dispose synchronously in the same order (dispose event →
 * store close → rm).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext, type MockContext } from './mock-context.ts';
import { scopeLevels, visibleAtLevel } from '../src/utils/scope.ts';
import type { MemoryItem, MemoryScope } from '../src/types/index.ts';

// ── Seed list & shrinker configuration ──────────────────────────────────────

/** Default rotation: four trajectories (~3.2 s of storm total) so plain
 *  `npm test` already sweeps several op-mix shapes; CI's fuzz gate widens
 *  this to 8 via CHAOS_SEEDS. */
const DEFAULT_SEEDS: readonly number[] = [31337, 1, 7, 42];

/** Comma-separated seed list → integers in [0, 2^32); invalid entries are
 *  dropped; an all-invalid (or empty) value falls back to the default. */
function parseSeeds(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw === undefined || raw.trim() === '') return [...fallback];
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff);
  return parsed.length > 0 ? parsed : [...fallback];
}

// Legacy CHAOS_SEED (single trajectory) wins over the CHAOS_SEEDS list.
const SEEDS: number[] = parseSeeds(process.env.CHAOS_SEED ?? process.env.CHAOS_SEEDS, DEFAULT_SEEDS);

/** CHAOS_SHRINK=0 disables failure auto-minimization (default: on). */
const SHRINK_ENABLED: boolean = process.env.CHAOS_SHRINK !== '0';
/** Wall-clock budget for one shrink run; on expiry the best-so-far minimal
 *  sequence is printed and the original assertion is thrown regardless. */
const SHRINK_BUDGET_MS = 30_000;

// ── Deterministic PRNG (mulberry32, same algorithm as genesis-store.test) ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-seed randomness bundle — the ONLY randomness the storm consumes,
 *  and it is consumed exclusively during plan GENERATION. */
interface Rng {
  rand(): number;
  ri(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  const rand = mulberry32(seed);
  return {
    rand,
    ri: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)] as T,
    chance: (p) => rand() < p,
  };
}

// ── Injected monotonic clock (no Date.now in the driver) ────────────────────

const CLOCK_BASE = Date.UTC(2026, 0, 5, 8, 0, 0); // fixed epoch anchor
const CLOCK_MAX_STEP_MS = 90_000;

// ── Fixed vocabularies (no temporal idioms — they would pull real
//    wall-clock into parseQueryHints and break step-replay determinism) ──────

const WORDS = [
  'kafka', 'postgres', 'pgvector', 'kubernetes', 'redis', 'neo4j',
  'envoy', 'grafana', 'clickhouse', 'flink', 'deployment', 'migration',
  'rollback', 'canary', 'tracing', 'opentelemetry', 'credentials',
  'runbook', 'partition', 'throughput', 'dashboard', 'incident',
  'postmortem', 'cache', 'queue', 'index', 'schema', 'backup',
  'phoenix', 'aurora', 'vector', 'quantum',
] as const;

const TEMPLATES = [
  (w: string[]) => `The ${w[0]} pipeline uses ${w[1]} for ${w[2]} with ${w[3]} enabled.`,
  (w: string[]) => `Note that ${w[0]} depends on ${w[1]} during ${w[2]} rollout.`,
  (w: string[]) => `Runbook for ${w[0]}: check ${w[1]}, then restart the ${w[2]} workers.`,
  (w: string[]) => `Incident summary: ${w[0]} lost sync with ${w[1]} after ${w[2]} flooded the ${w[3]} cluster.`,
  (w: string[]) => `Preference: prefer ${w[0]} over ${w[1]} whenever ${w[2]} matters.`,
] as const;

/** Random content from the fixed word table (deterministic per seed). */
function randomWords(rng: Rng, n: number): string[] {
  return Array.from({ length: n }, () => rng.pick(WORDS));
}

function randomContent(rng: Rng): string {
  return rng.pick(TEMPLATES)(randomWords(rng, 4 + rng.ri(0, 4)));
}

function randomQuery(rng: Rng): string {
  return randomWords(rng, 2 + rng.ri(0, 3)).join(' ');
}

// ── Random scope triples: u-a / u-b / anon × ws-1 / none × random session ──

const USERS = ['u-a', 'u-b', undefined] as const;
const WORKSPACES = ['ws-1', undefined] as const;
const SESSIONS = ['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4'] as const;
const VISIBILITIES = [undefined, 'user', 'global', 'workspace'] as const;
const ENTITY_POOL = ['Kafka', 'Postgres', 'Grafana', 'Flink', 'Redis', 'QuantumImp'] as const;
const VALID_LAYERS = ['episodic', 'semantic', 'procedural'] as const;

interface Triple {
  userId?: string;
  workspaceId?: string;
  sessionId: string;
}

function randomTriple(rng: Rng): Triple {
  return {
    userId: rng.pick(USERS),
    workspaceId: rng.pick(WORKSPACES),
    sessionId: rng.pick(SESSIONS),
  };
}

const tripleToTctx = (s: Triple) => ({
  sessionId: s.sessionId,
  userId: s.userId,
  workspaceId: s.workspaceId,
});

const tripleToScope = (s: Triple): MemoryScope => ({
  userId: s.userId,
  workspaceId: s.workspaceId,
  sessionId: s.sessionId,
});

// ── Weighted operation pool ─────────────────────────────────────────────────

interface WeightedOp {
  name: string;
  weight: number;
}

const OPS: WeightedOp[] = [
  { name: 'ingest', weight: 30 },
  { name: 'retrieve', weight: 22 },
  { name: 'remember', weight: 12 },
  { name: 'forget', weight: 10 },
  { name: 'inspect', weight: 6 },
  { name: 'sessionEnd', weight: 8 },
  { name: 'malformed', weight: 5 }, // 5 / 93 ≈ 5.4% of steps
];

const TOTAL_WEIGHT = OPS.reduce((n, o) => n + o.weight, 0);

function weightedOpName(rng: Rng): string {
  let roll = rng.rand() * TOTAL_WEIGHT;
  for (const op of OPS) {
    roll -= op.weight;
    if (roll < 0) return op.name;
  }
  return OPS[OPS.length - 1]!.name;
}

const STEPS = 200;

// ── Phase 1: the operation PLAN (pure data, no execution) ───────────────────
//
// Every random decision the storm will ever need is baked into these records
// up front. `forget` is the one op whose target depends on runtime state
// (the ids remembered so far): its remember-target is stored as a uniform
// ROLL that execution applies to the live id list — deterministic for any
// plan subset, exact for the full plan.

type MalformedKind = 1 | 2 | 3 | 4;
type ForgetMode = 'purge' | 'id' | 'entity' | 'query';
const MALFORMED_NAMES = ['emptyQuery', 'hugeContent', 'nastyChars', 'badLayers'] as const;

interface StepBase {
  /** 1-based planned step number — STABLE across shrunk replays. */
  step: number;
  op: string;
  triple: Triple;
  /** Monotonic event timestamp for this step (injected clock). */
  ts: number;
  /** Pre-rolled query for the ACL probe that follows this step. */
  probe: string;
}

interface IngestStep extends StepBase {
  op: 'ingest';
  role: 'user' | 'assistant';
  content: string;
}
interface RetrieveStep extends StepBase {
  op: 'retrieve';
  query: string;
  topK: number;
  layers?: string[];
}
interface RememberStep extends StepBase {
  op: 'remember';
  content: string;
  importance: number;
  tags?: string[];
  visibility?: (typeof VISIBILITIES)[number];
  supersede?: true;
}
interface ForgetStep extends StepBase {
  op: 'forget';
  mode: ForgetMode;
  /** id mode: uniform roll applied to the runtime rememberedIds list. */
  rememberRoll: number;
  useRemembered: boolean;
  id?: string;
  /** entity mode. */
  entity?: string;
  knownEntity: boolean;
  /** query mode. */
  query?: string;
  dryRun: boolean;
}
interface InspectStep extends StepBase {
  op: 'inspect';
}
interface SessionEndStep extends StepBase {
  op: 'sessionEnd';
  flavor: 'emit' | 'tool';
  forceCompression: boolean;
}
interface MalformedStep extends StepBase {
  op: 'malformed';
  kind: MalformedKind;
  huge?: string;
  nasty?: string;
  query?: string;
}

type PlannedStep =
  | IngestStep
  | RetrieveStep
  | RememberStep
  | ForgetStep
  | InspectStep
  | SessionEndStep
  | MalformedStep;

function generatePlan(seed: number): PlannedStep[] {
  const rng = makeRng(seed);
  let clock = CLOCK_BASE;
  // Malformed sub-kind and sessionEnd flavor ROTATE at plan time (timing
  // stays random via the op pool): with a fixed seed, purely random
  // sub-kind picking can starve one of the four attack vectors or one of
  // the two sleep trigger paths — rotation guarantees coverage.
  let malformedGen = 0;
  let sessionEndGen = 0;
  const plan: PlannedStep[] = [];

  for (let step = 1; step <= STEPS; step++) {
    const op = weightedOpName(rng);
    const triple = randomTriple(rng);
    clock += 1 + rng.ri(0, CLOCK_MAX_STEP_MS);
    const ts = clock;

    let s: PlannedStep;
    if (op === 'ingest') {
      s = {
        step, op, triple, ts, probe: '',
        role: rng.chance(0.5) ? 'user' : 'assistant',
        content: randomContent(rng),
      };
    } else if (op === 'retrieve') {
      const layers = rng.chance(0.5) ? undefined : VALID_LAYERS.filter(() => rng.chance(0.5));
      s = {
        step, op, triple, ts, probe: '',
        query: randomQuery(rng),
        topK: rng.ri(1, 10),
        layers: layers && layers.length > 0 ? [...layers] : undefined,
      };
    } else if (op === 'remember') {
      s = {
        step, op, triple, ts, probe: '',
        content: randomContent(rng),
        importance: Number((0.1 + rng.rand() * 0.9).toFixed(2)),
        tags: rng.chance(0.4) ? ['chaos', 'fuzz'] : undefined,
        visibility: rng.pick(VISIBILITIES),
        supersede: rng.chance(0.3) || undefined,
      };
    } else if (op === 'forget') {
      const modeRoll = rng.rand();
      const dryRun = rng.chance(0.5);
      if (modeRoll < 0.1) {
        s = { step, op, triple, ts, probe: '', mode: 'purge', rememberRoll: 0, useRemembered: false, knownEntity: false, dryRun };
      } else if (modeRoll < 0.45) {
        s = {
          step, op, triple, ts, probe: '', mode: 'id', dryRun,
          useRemembered: rng.chance(0.6),
          rememberRoll: rng.rand(),
          id: `chaos-nonexistent-${step}`,
        };
      } else if (modeRoll < 0.75) {
        s = {
          step, op, triple, ts, probe: '', mode: 'entity', dryRun,
          knownEntity: rng.chance(0.7),
          entity: rng.pick(ENTITY_POOL),
          rememberRoll: 0, useRemembered: false,
        };
      } else {
        s = { step, op, triple, ts, probe: '', mode: 'query', query: randomQuery(rng), rememberRoll: 0, useRemembered: false, knownEntity: false, dryRun };
      }
    } else if (op === 'inspect') {
      s = { step, op, triple, ts, probe: '' };
    } else if (op === 'sessionEnd') {
      s = {
        step, op, triple, ts, probe: '',
        flavor: sessionEndGen++ % 2 === 0 ? 'emit' : 'tool',
        forceCompression: rng.chance(0.5),
      };
    } else {
      const kind = ((malformedGen++ % 4) + 1) as MalformedKind;
      const m: MalformedStep = { step, op: 'malformed', triple, ts, probe: '', kind };
      if (kind === 2) {
        // ~50 KB content through the full chunk → embed → tx pipeline.
        let huge = 'chaos-payload';
        while (huge.length < 50 * 1024) huge += ` ${rng.pick(WORDS)}`;
        m.huge = huge;
      } else if (kind === 3) {
        // Valid surrogate pairs (emoji), quotes and SQL metacharacters.
        m.nasty =
          'Quote "it\'s 100%\'s" -- ; DROP TABLE memory_items; -- ' +
          "_ LIKE '%' ESCAPE '_' \uD83D\uDE00\uD83D\uDE80\u{1F680} " +
          `emoji tail for ${rng.pick(WORDS)}`;
      } else if (kind === 4) {
        m.query = randomQuery(rng);
      }
      s = m;
    }

    // ACL probe query for this step's checkpoint (consumed last, mirroring
    // the original single-phase driver's ordering).
    s.probe = randomQuery(rng);
    plan.push(s);
  }
  return plan;
}

// ── Failure categories (drive the shrinker's same-class comparison) ─────────

interface CategorizedError extends Error {
  chaosCategory?: string;
}

/** Attach an invariant category to an error; first writer wins so a precise
 *  inner tag (e.g. 'acl' inside a retrieve op) is never overwritten by the
 *  broader zone it was called from. */
function categorize(e: unknown, category: string): void {
  if (e !== null && typeof e === 'object') (e as CategorizedError).chaosCategory ??= category;
}

function categoryOf(e: unknown): string {
  return (e !== null && typeof e === 'object'
    ? (e as CategorizedError).chaosCategory
    : undefined) ?? 'internal';
}

/** Run a synchronous assertion block under a category. */
function tag(category: string, run: () => void): void {
  try {
    run();
  } catch (e) {
    categorize(e, category);
    throw e;
  }
}

interface FailureInfo {
  error: unknown;
  category: string;
  /** 0-based plan index of the step whose checkpoint failed; -1 = pre-storm,
   *  STEPS = endgame (post-storm checks). */
  stepIndex: number;
  where: string;
}

// ── Invariant helpers (each self-tags its category) ─────────────────────────

/** Let fire-and-forget lifecycle handlers (ctx.emit) finish their microtask
 *  chains before the next storm step observes store state. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setImmediate(r));
};

/**
 * Invariant (a): the tier ACL. Every hit materialized for `scope` must be
 * visible at one of that caller's cumulative levels (re-checked in JS via
 * visibleAtLevel — mirroring the SQL ACL), and a hit owned by someone else
 * is only legal on a shared visibility group: global, OR a session tier
 * whose sessionId the caller genuinely shares, OR a workspace tier whose
 * workspaceId the caller shares (the scope v0.20 narrower-is-safer
 * semantics: same session/workspace = same visibility group by design).
 * Anonymous callers (no ids at all) see global only.
 */
function assertAcl(hits: Array<{ item: MemoryItem }>, scope: MemoryScope, label: string): void {
  tag('acl', () => {
    const anonymous = !scope.userId && !scope.workspaceId && !scope.sessionId;
    const levels = scopeLevels('user', scope);
    for (const h of hits) {
      const item = h.item;
      const tier = item.visibility ?? 'global';
      // Cross-owner visibility is legal only through a group the caller
      // genuinely belongs to (shared session/workspace id), never through
      // the owner's private user tier.
      const sharedGroup =
        tier === 'session' && !!item.sessionId && item.sessionId === scope.sessionId;
      const sharedWorkspace =
        tier === 'workspace' && !!item.workspaceId && item.workspaceId === scope.workspaceId;
      if (anonymous) {
        assert.equal(
          tier,
          'global',
          `${label}: anonymous retrieve leaked tier="${tier}" item ${item.id} (owner=${item.userId ?? 'none'})`,
        );
      } else {
        const row = {
          visibility: item.visibility,
          userId: item.userId,
          workspaceId: item.workspaceId,
          sessionId: item.sessionId,
        };
        const visibleSomewhere = levels.some((lvl) => visibleAtLevel(row, lvl));
        assert.ok(
          visibleSomewhere,
          `${label}: ACL leak — hit ${item.id} (tier=${tier}, owner=${item.userId ?? 'none'}) invisible at every caller level`,
        );
        if (item.userId && scope.userId && item.userId !== scope.userId) {
          assert.ok(
            tier === 'global' || sharedGroup || sharedWorkspace,
            `${label}: cross-owner hit ${item.id} must be global or a shared session/workspace group, got tier=${tier} owner=${item.userId} caller=${scope.userId} (caller sess=${scope.sessionId ?? 'none'}, item sess=${item.sessionId ?? 'none'})`,
          );
        }
      }
    }
  });
}

/**
 * Invariant (e): retrieval result shape. `scoreBound` upper limit 1.2: the
 * vector path clamps to [0,1], keyword fusion is vw*score + kw*keywords with
 * bandit rails vw<=0.85 / kw<=0.45 — and in this storm weights only ever
 * drift DOWN (forget's negative feedback) — so 1.2 is a generous hard bound;
 * the 1e-9 epsilon absorbs toFixed float rounding only, not real drift.
 */
function assertHitShape(
  hits: Array<{ score?: number; finalScore?: number; via?: string }>,
  topK: number,
  label: string,
): void {
  tag('shape', () => {
    assert.ok(Array.isArray(hits), `${label}: hits must be an array`);
    assert.ok(
      hits.length <= topK,
      `${label}: hits.length ${hits.length} exceeds topK ${topK}`,
    );
    for (const h of hits) {
      const score = h.finalScore ?? h.score;
      assert.ok(
        typeof score === 'number' && Number.isFinite(score),
        `${label}: hit score must be a finite number, got ${String(score)}`,
      );
      assert.ok(
        score >= 0 && score <= 1.2 + 1e-9,
        `${label}: hit score ${score} outside [0, 1.2]`,
      );
      assert.ok(
        h.via === 'vector' || h.via === 'entity-hop',
        `${label}: hit via must be vector|entity-hop, got ${String(h.via)}`,
      );
    }
  });
}

/** Invariant (c): stats() smoke — every counter finite, integral, >= 0. */
function assertStatsFinite(label: string, stats: Record<string, unknown>): void {
  tag('stats', () => {
    const intGe0 = (v: unknown, what: string) =>
      assert.ok(
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && !Number.isNaN(v),
        `${label}: stats.${what} must be a non-NaN integer >= 0, got ${String(v)}`,
      );
    const items = stats.items as Record<string, unknown>;
    for (const [layer, n] of Object.entries(items)) intGe0(n, `items.${layer}`);
    intGe0(stats.events, 'events');
    intGe0(stats.entities, 'entities');
    intGe0(stats.edges, 'edges');
    intGe0(stats.patterns, 'patterns');
    intGe0(stats.tombstoned, 'tombstoned');
    assert.ok(
      typeof stats.sizeBytes === 'number' && Number.isFinite(stats.sizeBytes) && stats.sizeBytes >= 0,
      `${label}: stats.sizeBytes must be finite >= 0`,
    );
    for (const [space, n] of Object.entries(stats.spaces as Record<string, unknown>)) {
      intGe0(n, `spaces.${space}`);
    }
  });
}

// ── Phase 2: execution (env, op runner, storm, endgame) ─────────────────────

interface Env {
  ctx: MockContext;
  dir: string;
  palace: any;
  tool(name: string): any;
}

/** Fresh throwaway environment: mock context + tempdir + real plugin. The
 *  fifteen-tool registration gate lives HERE so replays check it too. */
function makeEnv(): Env {
  const ctx = createMockContext();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-chaos-'));
  try {
    MemoryPalacePlugin(ctx as never, {
      storagePath: join(dir, 'chaos.db'),
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
      scope: 'user',
    });
    const palace = ctx.services.get('memory-palace') as any;
    const tools = new Map((ctx.tools as any[]).map((tl) => [tl.name, tl]));
    const tool = (name: string): any => {
      const td = tools.get(name);
      assert.ok(td, `tool ${name} registered`);
      return td;
    };
    // All fifteen model tools must be on the wire before the storm starts.
    tag('registration', () => assert.equal(ctx.tools.length, 15, 'fifteen tools registered'));
    return { ctx, dir, palace, tool };
  } catch (e) {
    // Best-effort cleanup so a failed install never leaks the tempdir/WAL.
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/** Teardown in the Windows-safe order: plugin dispose → store close → rm. */
function disposeEnv(env: Env): void {
  try {
    env.ctx.emit('dispose', {});
  } catch {
    /* idempotent by contract */
  }
  const store = env.ctx.services.get('memory-store') as { close(): void } | undefined;
  try {
    store?.close();
  } catch {
    /* already closed by the dispose endgame — nothing to do */
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Mutable execution state that only full-run replay can rebuild. */
interface RunState {
  rememberedIds: string[];
  lastVersion: number;
  opCounts: Record<string, number>;
  malformedKinds: Record<string, number>;
  sleepFlavors: Record<string, number>;
}

/** Execute ONE planned step (op + its contract asserts). Never categorizes
 *  invariant failures — the self-tagging helpers keep their precise tags. */
async function executeOp(env: Env, s: PlannedStep, state: RunState): Promise<void> {
  const tctx = tripleToTctx(s.triple);
  const label = `step ${s.step}`;

  if (s.op === 'ingest') {
    const res = await env.palace.ingestor.ingestMessage({
      role: s.role,
      content: s.content,
      sessionId: s.triple.sessionId,
      userId: s.triple.userId,
      workspaceId: s.triple.workspaceId,
      ts: s.ts,
    });
    assert.ok(typeof res.eventId === 'string' && res.eventId.length > 0, `${label}: ingest returns eventId`);
    assert.ok(Array.isArray(res.semanticIds), `${label}: ingest returns semanticIds array`);
  } else if (s.op === 'retrieve') {
    const res = await env.tool('memory_retrieve').run(
      { query: s.query, topK: s.topK, layers: s.layers },
      tctx,
    );
    assertHitShape(res.hits, s.topK, `${label} retrieve`);
    // Full-item ACL re-check: compact tool hits carry the item id; the raw
    // row (owner backfill) is re-fetched and re-verified against the
    // caller's cascade.
    for (const h of res.hits) {
      const raw = env.palace.store.getItem(h.id) as MemoryItem | undefined;
      assert.ok(raw, `${label}: retrieve hit ${h.id} resolves to a stored item`);
      assertAcl([{ item: raw }], tripleToScope(s.triple), `${label} retrieve`);
    }
  } else if (s.op === 'remember') {
    const res = await env.tool('memory_remember').run(
      {
        content: s.content,
        importance: s.importance,
        tags: s.tags,
        visibility: s.visibility,
        supersede: s.supersede,
      },
      tctx,
    );
    assert.ok(typeof res.id === 'string' && res.id.length > 0, `${label}: remember returns id`);
    state.rememberedIds.push(res.id);
  } else if (s.op === 'forget') {
    let res: any;
    if (s.mode === 'purge') {
      res = await env.tool('memory_forget').run({ purge: true }, tctx);
      assert.ok(Number.isInteger(res.purged) && res.purged >= 0, `${label}: forget purge count`);
    } else if (s.mode === 'id') {
      // Apply the pre-rolled uniform roll to the LIVE remembered-id list:
      // exact pick semantics on the full plan, deterministic on any subset.
      const idx = Math.floor(s.rememberRoll * state.rememberedIds.length);
      const id =
        s.useRemembered && idx < state.rememberedIds.length
          ? state.rememberedIds[idx]!
          : s.id!;
      res = await env.tool('memory_forget').run({ id, dryRun: s.dryRun }, tctx);
    } else if (s.mode === 'entity') {
      res = await env.tool('memory_forget').run(
        { entity: s.knownEntity ? s.entity : `GhostEntity${s.step}`, dryRun: s.dryRun },
        tctx,
      );
    } else {
      res = await env.tool('memory_forget').run({ query: s.query, dryRun: s.dryRun }, tctx);
    }
    assert.ok(typeof res === 'object' && res !== null && typeof res.mode === 'string', `${label}: forget returns a mode`);
  } else if (s.op === 'inspect') {
    const res = await env.tool('memory_inspect').run({}, tctx);
    assert.ok(res.stats && res.stats.items, `${label}: inspect returns stats.items`);
    assertStatsFinite(`${label} inspect`, res.stats);
  } else if (s.op === 'sessionEnd') {
    // Two flavors, rotating at plan time: the lifecycle wiring (ctx.emit →
    // sleep, fire-and-forget) and the direct tool call (awaited, optionally
    // forcing compression).
    if (s.flavor === 'emit') {
      env.ctx.emit('session.end', {
        userId: s.triple.userId,
        workspaceId: s.triple.workspaceId,
      });
      await settle();
    } else {
      const dream = await env.tool('memory_sleep').run(
        { forceCompression: s.forceCompression },
        tctx,
      );
      assert.ok(Array.isArray(dream.phases), `${label}: sleep returns phases array`);
      for (const ph of dream.phases) {
        assert.ok(ph.ok === true, `${label}: sleep phase ${ph.phase} must survive dirty data (error: ${ph.error})`);
      }
    }
  } else {
    // malformed (~5%): garbage in, NO throw out — tools answer with shape.
    if (s.kind === 1) {
      const res = await env.tool('memory_retrieve').run({ query: '', topK: 5 }, tctx);
      assertHitShape(res.hits, 5, `${label} empty-query`);
    } else if (s.kind === 2) {
      const res = await env.palace.ingestor.ingestMessage({
        role: 'user',
        content: s.huge!,
        sessionId: s.triple.sessionId,
        userId: s.triple.userId,
        workspaceId: s.triple.workspaceId,
        ts: s.ts,
      });
      assert.ok(typeof res.eventId === 'string', `${label}: huge ingest returns eventId`);
    } else if (s.kind === 3) {
      const res = await env.palace.ingestor.ingestMessage({
        role: 'assistant',
        content: s.nasty!,
        sessionId: s.triple.sessionId,
        userId: s.triple.userId,
        workspaceId: s.triple.workspaceId,
        ts: s.ts,
      });
      assert.ok(typeof res.eventId === 'string', `${label}: nasty ingest returns eventId`);
    } else {
      // Bogus layers: the tool's contract is filter-and-fallback (invalid
      // names are dropped; an empty remainder falls back to all layers) —
      // observed, documented behavior; the invariant burned in here is
      // "never throws, always answers with a well-formed shape".
      const res = await env.tool('memory_retrieve').run(
        { query: s.query, topK: 5, layers: ['bogus', `layer-${s.step}`] },
        tctx,
      );
      assertHitShape(res.hits, 5, `${label} bad-layers`);
    }
  }
}

interface StormOpts {
  /** Plan indices to skip (shrink replay). */
  skip?: ReadonlySet<number>;
  /** Only execute the first `limit` planned steps (prefix replay). */
  limit?: number;
}

interface StormRun {
  failure?: FailureInfo;
  state: RunState;
}

/** Execute a plan (or a subset of it) and check every per-step invariant.
 *  Never throws — the first categorized violation comes back as data. */
async function runStorm(env: Env, plan: PlannedStep[], opts: StormOpts = {}): Promise<StormRun> {
  const skip = opts.skip;
  const limit = opts.limit ?? plan.length;
  const state: RunState = {
    rememberedIds: [],
    lastVersion: env.palace.store.dataVersion(),
    opCounts: {},
    malformedKinds: {},
    sleepFlavors: { emit: 0, tool: 0 },
  };
  try {
    tag('version', () => assert.ok(Number.isInteger(state.lastVersion), 'dataVersion starts as an integer'));
  } catch (e) {
    return { failure: { error: e, category: categoryOf(e), stepIndex: -1, where: 'pre-storm' }, state };
  }

  for (let i = 0; i < limit; i++) {
    if (skip?.has(i)) continue;
    const s = plan[i]!;
    const label = `step ${s.step}`;

    // Op execution + its contract asserts (eventId returned, forget mode,
    // sleep phases …). Self-tagged invariant helpers inside keep their own,
    // more precise categories.
    try {
      await executeOp(env, s, state);
    } catch (e) {
      categorize(e, `contract:${s.op}`);
      return { failure: { error: e, category: categoryOf(e), stepIndex: i, where: label }, state };
    }
    state.opCounts[s.op] = (state.opCounts[s.op] ?? 0) + 1;
    if (s.op === 'malformed') {
      const name = MALFORMED_NAMES[s.kind - 1];
      state.malformedKinds[name] = (state.malformedKinds[name] ?? 0) + 1;
    }
    if (s.op === 'sessionEnd') {
      state.sleepFlavors[s.flavor] = (state.sleepFlavors[s.flavor] ?? 0) + 1;
    }

    // ── Per-step invariants ──────────────────────────────────────────────
    try {
      // (b) dataVersion monotonically non-decreasing.
      const version = env.palace.store.dataVersion();
      tag('version', () =>
        assert.ok(
          version >= state.lastVersion,
          `${label}: dataVersion regressed ${state.lastVersion} → ${version}`,
        ));
      state.lastVersion = version;

      // (a) ACL probe after EVERY step, alternating u-b / anonymous so both
      //     halves of the invariant get continuous coverage across the storm.
      const anon = s.step % 2 === 0;
      const probeScope: MemoryScope = anon ? {} : { userId: 'u-b' };
      const probe = await env.palace.retriever.retrieve({
        query: s.probe,
        topK: 10,
        scope: probeScope,
      });
      assertAcl(probe.hits, probeScope, `${label} acl-probe`);
      assertHitShape(probe.hits, 10, `${label} acl-probe`);

      // (c) stats() smoke every 50 steps.
      if (s.step % 50 === 0) {
        assertStatsFinite(`${label} smoke`, env.palace.store.stats());
      }
    } catch (e) {
      return { failure: { error: e, category: categoryOf(e), stepIndex: i, where: `${label} checkpoint` }, state };
    }
  }
  return { state };
}

/** Post-storm checks. 'full' (main run only) also exercises the dispose
 *  idempotency + closed-store assertions; replays use 'lite' because they
 *  dispose through disposeEnv() themselves. */
async function runEndgame(env: Env, mode: 'full' | 'lite'): Promise<FailureInfo | undefined> {
  try {
    // memory_inspect still runs on the dirty post-storm state.
    const insp = await env.tool('memory_inspect').run({}, { sessionId: 'sess-final', userId: 'u-a' });
    tag('endgame', () => {
      assert.ok(insp.stats && insp.stats.items, 'endgame: inspect stats present');
      assert.ok(typeof insp.health.rankGini === 'number', 'endgame: health panel present');
    });
    assertStatsFinite('endgame inspect', insp.stats);

    // Full retrieval round: invariant (a) must still hold for every identity.
    for (const scope of [{ userId: 'u-a' }, { userId: 'u-b' }, {}] as MemoryScope[]) {
      for (const q of ['kafka postgres', 'grafana incident', 'credentials runbook']) {
        const res = await env.palace.retriever.retrieve({ query: q, topK: 10, scope });
        assertAcl(res.hits, scope, `endgame sweep ${JSON.stringify(scope)} "${q}"`);
        assertHitShape(res.hits, 10, `endgame sweep ${JSON.stringify(scope)} "${q}"`);
      }
    }

    if (mode === 'full') {
      // Plugin disposal is idempotent (double dispose never throws) and the
      // first one really closed the store (post-close stats throws).
      tag('endgame-dispose', () => {
        assert.doesNotThrow(() => env.ctx.emit('dispose', {}), 'first dispose must not throw');
        assert.doesNotThrow(() => env.ctx.emit('dispose', {}), 'second dispose must not throw (idempotent)');
        assert.throws(
          () => env.palace.store.stats(),
          'dispose closed the underlying store',
        );
      });
    }
    return undefined;
  } catch (e) {
    return { error: e, category: categoryOf(e), stepIndex: STEPS, where: 'endgame' };
  }
}

/** One self-contained replay: fresh env → subset storm → (if the full plan
 *  was allowed to run) endgame-lite → dispose. Returns the first failure,
 *  or undefined when the subset survived every checkpoint. */
async function replayPlan(plan: PlannedStep[], opts: StormOpts): Promise<FailureInfo | undefined> {
  let env: Env;
  try {
    env = makeEnv();
  } catch (e) {
    return { error: e, category: categoryOf(e), stepIndex: -1, where: 'env-setup' };
  }
  try {
    const storm = await runStorm(env, plan, opts);
    if (storm.failure) return storm.failure;
    if ((opts.limit ?? plan.length) >= plan.length) {
      return await runEndgame(env, 'lite');
    }
    return undefined;
  } finally {
    disposeEnv(env);
  }
}

// ── The shrinker: greedy sequence minimization ──────────────────────────────

/** Human-readable one-liner for one planned step (op name + key params). */
function describeStep(s: PlannedStep): string {
  const t = s.triple;
  const who = `${t.userId ?? 'anon'}/${t.workspaceId ?? '-'}/${t.sessionId}`;
  const cut = (v: string, n = 56): string => {
    const flat = v.replace(/\s+/g, ' ');
    return flat.length > n ? `${flat.slice(0, n)}…` : flat;
  };
  if (s.op === 'ingest') {
    return `#${s.step} ingest ${who} role=${s.role} content="${cut(s.content)}"`;
  }
  if (s.op === 'retrieve') {
    return `#${s.step} retrieve ${who} topK=${s.topK}${s.layers ? ` layers=[${s.layers.join(',')}]` : ''} query="${cut(s.query)}"`;
  }
  if (s.op === 'remember') {
    return (
      `#${s.step} remember ${who} importance=${s.importance} visibility=${s.visibility ?? 'default'}` +
      `${s.tags ? ` tags=[${s.tags.join(',')}]` : ''}${s.supersede ? ' supersede' : ''} content="${cut(s.content)}"`
    );
  }
  if (s.op === 'forget') {
    const parts = [`#${s.step} forget ${who} mode=${s.mode}`];
    if (s.mode === 'id') {
      parts.push(s.useRemembered ? `target=remembered[roll=${s.rememberRoll.toFixed(3)}]` : `id=${s.id}`);
    }
    if (s.mode === 'entity') {
      parts.push(`entity=${s.knownEntity ? s.entity : `GhostEntity${s.step}`}`);
    }
    if (s.mode === 'query') parts.push(`query="${cut(s.query ?? '')}"`);
    if (s.mode !== 'purge') parts.push(`dryRun=${s.dryRun}`);
    return parts.join(' ');
  }
  if (s.op === 'inspect') {
    return `#${s.step} inspect ${who}`;
  }
  if (s.op === 'sessionEnd') {
    return `#${s.step} sessionEnd ${who} flavor=${s.flavor}${s.flavor === 'tool' ? ` forceCompression=${s.forceCompression}` : ''}`;
  }
  const kind = MALFORMED_NAMES[s.kind - 1];
  if (s.kind === 2) return `#${s.step} malformed(${kind}) ${who} bytes=${(s.huge ?? '').length}`;
  if (s.kind === 3) return `#${s.step} malformed(${kind}) ${who} content="${cut(s.nasty ?? '')}"`;
  if (s.kind === 4) return `#${s.step} malformed(${kind}) ${who} query="${cut(s.query ?? '')}"`;
  return `#${s.step} malformed(${kind}) ${who}`;
}

function errorMessage(e: unknown): string {
  return String((e as Error | undefined)?.message ?? e);
}

/**
 * Greedy sequence minimization of a failing storm. Prints the converged
 * minimal step sequence to stderr; the CALLER then re-throws the original
 * assertion. Wall-clock bounded by SHRINK_BUDGET_MS; CHAOS_SHRINK=0 skips
 * this function entirely.
 */
async function shrinkFailure(seed: number, plan: PlannedStep[], original: FailureInfo): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + SHRINK_BUDGET_MS;
  let replays = 0;
  const budgetLeft = (): boolean => Date.now() < deadline;

  /** True iff replaying the plan subset fails with the SAME category. */
  const reproduces = async (skip: ReadonlySet<number>, limit: number): Promise<boolean> => {
    replays += 1;
    const failure = await replayPlan(plan, { skip, limit });
    return failure !== undefined && failure.category === original.category;
  };

  console.error(
    `\n[chaos-shrink] seed=${seed}: '${original.category}' violation at ${original.where} — ` +
      `minimizing the ${STEPS}-step storm (budget ${Math.round(SHRINK_BUDGET_MS / 1000)}s; CHAOS_SHRINK=0 disables)…`,
  );

  // (0) The failure must reproduce on a clean full replay — otherwise
  // (non-determinism, or a category the replay harness intentionally
  // excludes: 'unhandled', 'endgame-dispose') minimization is meaningless.
  if (!(await reproduces(new Set(), plan.length))) {
    console.error(
      `[chaos-shrink] could not reproduce a '${original.category}' failure on replay — skipping minimization`,
    );
    return;
  }

  // (1) Shortest failing PREFIX via binary search over the prefix length.
  // Every hi value we settle on has been VERIFIED to fail, so the result is
  // sound even though subset-failure is not perfectly monotone in length.
  let lo = 1;
  let hi = Math.min(Math.max(original.stepIndex + 1, 0), plan.length);
  while (lo < hi && budgetLeft()) {
    const mid = (lo + hi) >> 1;
    if (await reproduces(new Set(), mid)) hi = mid;
    else lo = mid + 1;
  }
  const prefixLen = hi;

  // (2) Greedy per-step deletion: linear scan over the minimal prefix; a
  // step stays deleted iff the remaining subset still fails the same way.
  const skipped = new Set<number>();
  let budgetHit = false;
  for (let i = 0; i < prefixLen; i++) {
    if (!budgetLeft()) {
      budgetHit = true;
      break;
    }
    skipped.add(i);
    if (await reproduces(skipped, prefixLen)) continue; // deletion kept
    skipped.delete(i); // the step is load-bearing — restore it
  }

  const minimal: PlannedStep[] = [];
  for (let i = 0; i < prefixLen; i++) {
    if (!skipped.has(i)) minimal.push(plan[i]!);
  }

  console.error(
    `[chaos-shrink] seed=${seed}: minimal failing sequence for '${original.category}' — ` +
      `${minimal.length} step(s) (failing prefix was ${Math.max(original.stepIndex + 1, 0)} step(s); ` +
      `${skipped.size} deleted; ${replays} replays, ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
      `${budgetHit ? '; BUDGET EXHAUSTED — may not be fully minimal' : ''})`,
  );
  if (minimal.length === 0) {
    console.error('[chaos-shrink] the violation reproduces with ZERO storm steps (pre-storm state)');
  }
  for (const s of minimal) {
    console.error(`[chaos-shrink]   ${describeStep(s)}`);
  }
  console.error(`[chaos-shrink] original assertion — ${original.where}: ${errorMessage(original.error)}`);
}

// ── The storm (one sub-test per seed) ───────────────────────────────────────

for (const seed of SEEDS) {
  test(`pipeline chaos soak: 200-step random op storm with invariant monitoring (seed ${seed})`, async (t) => {
    // Phase 1 — the deterministic operation plan for this trajectory.
    const plan = generatePlan(seed);

    // (d) unhandledRejection collector — installed first so its cleanup hook
    // also runs first at teardown (listener removed even on mid-test failure).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));

    // Install — Windows hook order: store close BEFORE tempdir rm (see header).
    const env = makeEnv();
    t.after(() => disposeEnv(env));

    let failure: FailureInfo | undefined;
    try {
      // Phase 2 — execute the full plan; on any invariant violation, run the
      // shrinker first, then re-throw the ORIGINAL assertion below.
      const storm = await runStorm(env, plan);
      if (storm.failure) {
        failure = storm.failure;
      } else {
        failure = await runEndgame(env, 'full');
      }
      if (!failure) {
        // (d) zero unhandled rejections collected during the whole storm.
        tag('unhandled', () =>
          assert.equal(
            unhandled.length,
            0,
            `unhandledRejection collector captured ${unhandled.length}: ${unhandled.map(String).join(' | ').slice(0, 500)}`,
          ),
        );
        t.diagnostic(
          `seed=${seed} steps=${STEPS} ops=${Object.entries(storm.state.opCounts)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')} malformed=${JSON.stringify(storm.state.malformedKinds)} sleep=${JSON.stringify(storm.state.sleepFlavors)}`,
        );
      }
    } catch (e) {
      // Anything that escaped the zone plumbing (setup, collector assert).
      failure = failure ?? { error: e, category: categoryOf(e), stepIndex: -1, where: 'setup' };
    }

    if (failure) {
      if (SHRINK_ENABLED) await shrinkFailure(seed, plan, failure);
      throw failure.error;
    }
  });
}
