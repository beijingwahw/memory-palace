#!/usr/bin/env node
/**
 * Performance benchmark + regression gate — `npm run bench`.
 *
 * Zero dependencies (node: builtins + the project's own dist/ artifacts).
 * Four fixed benchmarks, each with warmup and median-of-N sampling:
 *
 *   1. SCAN      — offline-BM25 64-dim corpus into a real MemoryStore
 *                  (temp SQLite file), exact scanBySimilarity P50/P95 vs
 *                  the same scan restricted to IVF probe buckets (radius 1,
 *                  passed straight into ScanOptions.buckets — the store
 *                  path the retriever's ivf gate selects).
 *   2. QUANT     — 1024-dim random unit vectors: int8Cosine vs the
 *                  dequantize-then-cosine float path, median per call.
 *   3. PAGERANK  — 500 nodes / 2,000 weighted edges, 20 power iterations.
 *   4. TOKENIZER — mixed CJK/English ~100 KB: tokenize + approximateTokenCount.
 *
 * Baseline gate: every timed metric in scripts/bench-baseline.json must stay
 * within 2x of the recorded value, else the run prints the offender and
 * exits 1 — a performance regression is a regression. Informational
 * ratios (IVF speedup, int8 speedup) are recorded but never gate: they can
 * legitimately move in EITHER direction when the other path gets faster.
 *
 * Flags:
 *   --update    rewrite scripts/bench-baseline.json from this run (full
 *               scale only — a smoke run must never shrink the baseline).
 *   --smoke     1/5-scale run, print-only, no gate (CI-friendly, <8 s).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { MemoryStore } from '../dist/services/index.js';
import { OfflineBM25EmbeddingProvider, cosine } from '../dist/utils/embedding.js';
import { int8Cosine, quantizeToInt8, dequantizeToFloat32 } from '../dist/utils/quantize.js';
import { pageRank } from '../dist/utils/pagerank.js';
import { tokenize, approximateTokenCount } from '../dist/utils/tokenizer.js';
import { probeKeys } from '../dist/utils/ivf.js';

// ------------------------------------------------------------------ config

const SMOKE = process.argv.includes('--smoke');
const UPDATE = process.argv.includes('--update');
if (SMOKE && UPDATE) {
  console.log('note: --update ignored in --smoke mode (baseline requires full scale)\n');
}
const DO_UPDATE = UPDATE && !SMOKE;

const DAY_MS = 86_400_000;

/** 1/5 scale in smoke mode, as documented. */
const CFG = SMOKE
  ? {
    scanItems: 1_000, scanSamples: 5, scanWarmup: 2,
    quantCalls: 2_000, quantDim: 1_024, quantWarmup: 200,
    prNodes: 100, prEdges: 400, prIters: 20, prSamples: 3,
    tokTargetKB: 20, tokSamples: 5,
  }
  : {
    scanItems: 5_000, scanSamples: 10, scanWarmup: 3,
    quantCalls: 10_000, quantDim: 1_024, quantWarmup: 500,
    prNodes: 500, prEdges: 2_000, prIters: 20, prSamples: 5,
    tokTargetKB: 100, tokSamples: 10,
  };

// fileURLToPath handles percent-encoded and non-ASCII segments (and never
// leaves a leading slash on Windows): the raw .pathname form made the
// baseline unreadable (ENOENT) on any checkout path with spaces/non-ASCII.
const BASELINE_PATH = fileURLToPath(new URL('./bench-baseline.json', import.meta.url));

// ------------------------------------------------------------------ helpers

/** Deterministic PRNG (mulberry32) — same corpus, same graph, every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function nowNs() {
  return process.hrtime.bigint();
}

function elapsedMs(t0) {
  return Number(nowNs() - t0) / 1e6;
}

/** Median of numeric samples (even n: average of the middle pair). */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank P95 (of n samples: the ceil(0.95n)-th smallest). */
function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** Time one sync call, returning elapsed ms. */
function timeCall(fn) {
  const t0 = nowNs();
  fn();
  return elapsedMs(t0);
}

const fmt = (v, digits = 3) => v.toFixed(digits);
const fmtInt = (v) => v.toLocaleString('en-US');

// Timed results gate against the baseline; info results are recorded only.
const timed = new Map();
const info = new Map();
const report = [];

function recordTimed(key, value, label, unit) {
  timed.set(key, value);
  report.push({ kind: 'timed', key, label, value, unit });
}

function recordInfo(key, value, label, unit) {
  info.set(key, value);
  report.push({ kind: 'info', key, label, value, unit });
}

// ------------------------------------------------------------------ bench 1: scan

const EN_WORDS = [
  'memory', 'palace', 'vector', 'retrieval', 'recall', 'keyword', 'schema', 'index',
  'session', 'workspace', 'gravity', 'cluster', 'digest', 'entity', 'graph', 'edge',
  'rank', 'decay', 'half', 'life', 'tombstone', 'sweep', 'purge', 'capsule',
  'federate', 'replica', 'merge', 'conflict', 'consensus', 'pattern', 'mine', 'token',
  'budget', 'prompt', 'context', 'window', 'cache', 'invalid', 'version', 'stamp',
  'quantize', 'anchor', 'plane', 'bucket', 'probe', 'radius', 'hamming', 'ladder',
  'circuit', 'breaker', 'failover', 'offline', 'provider', 'space', 'dimension', 'unit',
  'normalize', 'sparse', 'dense', 'score', 'threshold', 'candidate', 'pool', 'escalate',
];
const ZH_WORDS = [
  '记忆', '宫殿', '检索', '召回', '向量', '索引', '分桶', '探针', '半径', '量化',
  '衰减', '半衰', '权重', '图谱', '实体', '边', '共识', '冲突', '模式', '挖掘',
  '令牌', '预算', '上下文', '窗口', '缓存', '失效', '版本', '断路', '降级', '回退',
];

/** Synthetic corpus: overlapping vocabulary keeps cosines non-degenerate. */
function makeCorpus(rng, count) {
  const vocab = [...EN_WORDS, ...ZH_WORDS];
  const docs = [];
  for (let i = 0; i < count; i++) {
    const parts = [];
    for (let t = 0; t < 24; t++) {
      // 25% repetition rate — sublinear-TF path stays exercised.
      parts.push(vocab[Math.floor(rng() * vocab.length)]);
    }
    docs.push(`bench doc ${i}: ${parts.join(' ')}`);
  }
  const query = Array.from({ length: 8 }, () => vocab[Math.floor(rng() * vocab.length)]).join(' ');
  return { docs, query };
}

async function benchScan() {
  const rng = mulberry32(0x5ca41);
  const { docs, query } = makeCorpus(rng, CFG.scanItems);

  const provider = new OfflineBM25EmbeddingProvider(64);
  const vectors = await provider.embedBatch(docs);
  const queryVec = await provider.embed(query);

  const dir = mkdtempSync(join(tmpdir(), 'mp-bench-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'bench.db'),
    dimensions: provider.dimensions,
    activeSpace: provider.space,
  });
  try {
    const t0 = nowNs();
    store.ingestTx(() => {
      const now = Date.now();
      for (let i = 0; i < docs.length; i++) {
        store.insertItem(
          {
            id: `bench-item-${i}`,
            layer: 'semantic',
            content: docs[i],
            embedding: vectors[i],
            metadata: { source: 'system', embeddingSpace: provider.space },
            createdAt: now,
            updatedAt: now,
            importance: 0.5,
            accessCount: 0,
            lastAccessedAt: now,
          },
          {},
        );
      }
    });
    const ingestSecs = elapsedMs(t0) / 1_000;
    recordInfo('scan.ingestSecs', ingestSecs, 'ingest throughput', 's');

    const base = {
      layer: 'semantic',
      space: provider.space,
      queryVector: queryVec,
      minScore: 0,
      limit: 32,
    };
    // IVF engaged the direct way: restrict the scan to the radius-1 probe
    // neighborhood of the query's bucket (5 of 16 keys at width 4).
    const ivfKeys = probeKeys(queryVec, 1);

    for (let i = 0; i < CFG.scanWarmup; i++) {
      store.scanBySimilarity(base);
      store.scanBySimilarity({ ...base, buckets: ivfKeys });
    }

    const exact = [];
    const ivf = [];
    let exactHits = 0;
    let ivfHits = 0;
    for (let i = 0; i < CFG.scanSamples; i++) {
      exact.push(timeCall(() => {
        exactHits = store.scanBySimilarity(base).length;
      }));
      ivf.push(timeCall(() => {
        ivfHits = store.scanBySimilarity({ ...base, buckets: ivfKeys }).length;
      }));
    }

    recordTimed('scan.exact.p50', median(exact), 'exact scan p50', 'ms');
    recordTimed('scan.exact.p95', p95(exact), 'exact scan p95', 'ms');
    recordTimed('scan.ivf.p50', median(ivf), 'IVF scan p50 (radius 1)', 'ms');
    recordTimed('scan.ivf.p95', p95(ivf), 'IVF scan p95 (radius 1)', 'ms');
    recordInfo('scan.ivf.speedup', median(exact) / median(ivf), 'IVF speedup (p50 ratio)', 'x');
    recordInfo('scan.exact.hits', exactHits, 'exact scan hits (limit 32)', '');
    recordInfo('scan.ivf.hits', ivfHits, 'IVF scan hits (radius 1)', '');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ bench 2: quantization

function benchQuant() {
  const rng = mulberry32(0x6a117);
  const d = CFG.quantDim;
  const mkUnit = () => {
    const v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = rng() * 2 - 1;
    const n = Math.hypot(...v) || 1;
    for (let i = 0; i < d; i++) v[i] /= n;
    return v;
  };
  const a = mkUnit();
  const b = mkUnit();
  const qa = quantizeToInt8(a);
  const qb = quantizeToInt8(b);

  for (let i = 0; i < CFG.quantWarmup; i++) {
    int8Cosine(qa, qb);
    cosine(dequantizeToFloat32(qa), dequantizeToFloat32(qb));
  }

  const int8 = [];
  const float = [];
  for (let i = 0; i < CFG.quantCalls; i++) {
    int8.push(timeCall(() => { int8Cosine(qa, qb); }));
    // The dequantize path a float kernel pays: rebuild real vectors, then cosine.
    float.push(timeCall(() => {
      cosine(dequantizeToFloat32(qa), dequantizeToFloat32(qb));
    }));
  }

  const int8Us = median(int8) * 1_000;
  const floatUs = median(float) * 1_000;
  recordTimed('quant.int8.p50', int8Us, `int8Cosine p50 (${fmtInt(d)}-dim)`, 'us');
  recordTimed('quant.float.p50', floatUs, `dequantize+cosine p50 (${fmtInt(d)}-dim)`, 'us');
  recordInfo('quant.speedup', floatUs / int8Us, 'int8 vs float path ratio', 'x');
  recordInfo(
    'quant.cosError',
    Math.abs(int8Cosine(qa, qb) - cosine(dequantizeToFloat32(qa), dequantizeToFloat32(qb))),
    'int8 vs float cosine error',
    '',
  );
}

// ------------------------------------------------------------------ bench 3: pagerank

function benchPageRank() {
  const rng = mulberry32(0x9a2e5);
  const nodes = Array.from({ length: CFG.prNodes }, (_, i) => `n${i}`);
  const edges = Array.from({ length: CFG.prEdges }, () => ({
    from: nodes[Math.floor(rng() * nodes.length)],
    to: nodes[Math.floor(rng() * nodes.length)],
    weight: 1 + Math.floor(rng() * 40),
    lastSeenAt: Date.now() - Math.floor(rng() * 30 * DAY_MS),
  }));

  const run = () => pageRank(nodes, edges, { iterations: CFG.prIters });
  // Warmup + sanity: total rank mass must stay ~1 (dangling redistribution).
  let mass = [...run().values()].reduce((s, r) => s + r, 0);
  const times = [];
  for (let i = 0; i < CFG.prSamples; i++) {
    times.push(timeCall(run));
  }
  recordTimed('pagerank.total.p50', median(times), `pagerank p50 (${fmtInt(CFG.prNodes)} nodes / ${fmtInt(CFG.prEdges)} edges / ${CFG.prIters} iter)`, 'ms');
  recordInfo('pagerank.mass', mass, 'rank mass (sanity, ~1.0)', '');
}

// ------------------------------------------------------------------ bench 4: tokenizer

function makeMixedText(targetKB, rng) {
  const en = [
    'the retrieval pipeline embeds the query once per stored space',
    'vector scoring streams best-first rows out of the engine',
    'the circuit breaker serves offline embeddings when the api is unreachable',
    'compression runs nightly over the episodic layer with bounded budget',
  ];
  const zh = [
    '记忆宫殿通过分层存储与睡眠周期整理长期记忆',
    '检索管线将余弦相似度下推到数据库引擎内部执行',
    '断路器在接口不可用时降级为离线嵌入提供方',
    '图引擎按共现权重与时间衰减计算个性化排序',
  ];
  const parts = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetKB * 1_024) {
    const para = Array.from(
      { length: 3 + Math.floor(rng() * 3) },
      (_, k) => ((i + k) % 2 === 0 ? en[Math.floor(rng() * en.length)] : zh[Math.floor(rng() * zh.length)]),
    ).join('。');
    parts.push(para);
    bytes += Buffer.byteLength(para, 'utf8');
    i++;
  }
  return { text: parts.join('\n'), kb: bytes / 1_024 };
}

function benchTokenizer() {
  const rng = mulberry32(0x7ec41);
  const { text, kb } = makeMixedText(CFG.tokTargetKB, rng);

  for (let i = 0; i < 2; i++) {
    tokenize(text);
    approximateTokenCount(text);
  }

  const tok = [];
  const approx = [];
  let tokenCount = 0;
  for (let i = 0; i < CFG.tokSamples; i++) {
    tok.push(timeCall(() => {
      tokenCount = tokenize(text).length;
    }));
    approx.push(timeCall(() => { approximateTokenCount(text); }));
  }

  const perKB = (ms) => (ms * 1_000) / kb;
  recordTimed('tokenizer.tokenize.perKB', perKB(median(tok)), `tokenize (${kb.toFixed(0)} KB mixed zh/en)`, 'us/KB');
  recordTimed('tokenizer.approx.perKB', perKB(median(approx)), 'approximateTokenCount per KB', 'us/KB');
  recordInfo('tokenizer.tokens', tokenCount, 'tokens in corpus (sanity)', '');
}

// ------------------------------------------------------------------ report + gate

const UNITS = { us: 'µs', x: '×' };

function pretty(row) {
  const unit = UNITS[row.unit] ?? row.unit;
  const value = row.unit === ''
    ? (Number.isInteger(row.value) ? fmtInt(row.value) : fmt(row.value, 4))
    : fmt(row.value);
  return `${row.label}  ${value} ${unit}`.trimEnd();
}

function printReport() {
  const sections = [
    ['bench 1 · scan throughput', (r) => r.key.startsWith('scan.')],
    ['bench 2 · int8 quantization vs float cosine', (r) => r.key.startsWith('quant.')],
    ['bench 3 · pagerank (weighted, temporal, personalized)', (r) => r.key.startsWith('pagerank.')],
    ['bench 4 · tokenizer throughput', (r) => r.key.startsWith('tokenizer.')],
  ];
  for (const [title, match] of sections) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 58 - title.length))}`);
    for (const row of report.filter(match)) {
      const mark = row.kind === 'timed' ? '*' : ' ';
      console.log(`  ${mark} ${pretty(row)}`);
    }
  }
  console.log('\n  (* = gated against baseline, allowed within 2x; unmarked = informational)');
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    console.error(`error: baseline file is not valid JSON: ${BASELINE_PATH}`);
    process.exit(1);
  }
}

function gateAgainst(baseline) {
  console.log(`\n── baseline gate ${'─'.repeat(46)}`);
  console.log(`  baseline: ${baseline.generatedAt} · node ${baseline.node} · ${baseline.mode} scale`);
  let failed = 0;
  let checked = 0;
  for (const [key, baseVal] of Object.entries(baseline.metrics)) {
    const cur = timed.get(key);
    if (cur === undefined) {
      console.log(`  ? ${key}: in baseline but not measured this run`);
      failed++;
      continue;
    }
    checked++;
    const ratio = cur / baseVal;
    const ok = ratio <= 2;
    if (!ok) failed++;
    console.log(
      `  ${ok ? '✔' : '✘'} ${key.padEnd(26)} ${fmt(cur, 4).padStart(10)} vs ${fmt(baseVal, 4).padStart(10)}  ×${fmt(ratio, 2)}${ok ? '' : '  EXCEEDS 2x BASELINE'}`,
    );
  }
  console.log(`\n  ${checked} metrics checked, ${failed} failed (tolerance: <=2x baseline)`);
  return failed;
}

function writeBaseline() {
  const metrics = Object.fromEntries(timed);
  const payload = {
    version: 1,
    mode: SMOKE ? 'smoke' : 'full',
    note: 'Timed metrics gate at <=2x via `npm run bench`. Info metrics are recorded for context and never gate. Regenerate with `npm run bench:update` only after a deliberate, explained performance change.',
    generatedAt: new Date().toISOString(),
    node: process.version,
    scale: CFG,
    metrics,
    info: Object.fromEntries(info),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nbaseline written: ${BASELINE_PATH} (${Object.keys(metrics).length} gated metrics)`);
}

// ------------------------------------------------------------------ main

async function main() {
  const t0 = nowNs();
  console.log('memory-palace bench');
  console.log(`  mode: ${SMOKE ? 'smoke (1/5 scale, no gate)' : 'full (baseline gate)'}`);
  console.log(`  node: ${process.version} · platform: ${process.platform}`);

  await benchScan();
  benchQuant();
  benchPageRank();
  benchTokenizer();
  printReport();

  const wallSecs = elapsedMs(t0) / 1_000;
  console.log(`\ntotal wall time: ${fmt(wallSecs, 2)} s`);

  if (DO_UPDATE) {
    writeBaseline();
    return 0;
  }
  if (SMOKE) {
    console.log('smoke mode: baseline gate skipped');
    return 0;
  }

  const baseline = loadBaseline();
  if (!baseline || !baseline.metrics) {
    console.error('\nerror: no baseline found — generate one first: npm run bench:update');
    return 1;
  }
  const failed = gateAgainst(baseline);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('bench crashed:', e);
    process.exit(1);
  });
