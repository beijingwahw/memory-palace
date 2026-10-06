/**
 * Genesis hardening tests — code-point immunity and boundary semantics
 * for the v0.19 utils tier. Every case is deterministic (fixed content,
 * fixed vectors, injected clocks); pure kernels only, no database, no
 * network, no filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, approximateTokenCount } from '../src/utils/tokenizer.ts';
import { chunkText } from '../src/utils/chunker.ts';
import { CircuitBreaker } from '../src/utils/circuit-breaker.ts';
import { SemanticQueryCache } from '../src/utils/query-cache.ts';
import { anchorKey } from '../src/utils/anchors.ts';
import { cosine } from '../src/utils/embedding.ts';
import { parseQueryHints } from '../src/utils/query-understanding.ts';
import { detectConflict, negationPolarity, numericSignature } from '../src/utils/consensus.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/**
 * Detects an isolated UTF-16 surrogate half inside a string: a low
 * surrogate not preceded by a high one, or a high surrogate not followed
 * by a low one. A clean token (whole code points only) must test false.
 */
const LONE_SURROGATE_RE =
  /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?:[^\uDC00-\uDFFF]|$)/;

function assertWholeCodePoints(tokens: string[], label: string): void {
  for (const t of tokens) {
    assert.equal(
      LONE_SURROGATE_RE.test(t),
      false,
      `${label}: token ${JSON.stringify(t)} must not contain an isolated surrogate half`,
    );
  }
}

// ───────────── 1. tokenizer: code-point-safe CJK segmentation ─────────────

test('tokenizer: astral-plane CJK (surrogate pairs) segment into whole code points', () => {
  // Flagship: 𠀀 (U+20000, CJK Extension B) is a surrogate pair in JS.
  // Code-unit slicing would cut through the pair; the tokens must instead
  // be whole code points, and the astral char must PARTICIPATE in the
  // bigrams instead of being silently invisible.
  const tokens = tokenize('依赖𠀀数据库');
  assert.ok(tokens.length >= 5, `astral char contributes bigrams (got ${tokens.length})`);
  assertWholeCodePoints(tokens, '依赖𠀀数据库');
  assert.ok(
    tokens.some((t) => t.includes('𠀀')),
    'the astral Han character is part of at least one token',
  );

  // Mixed-script flagship from the audit: BMP CJK + astral math letter.
  assertWholeCodePoints(tokenize('v2数据𝕏'), 'v2数据𝕏');

  // A lone astral letter survives as ONE whole code-point token.
  const mathy = tokenize('𝕏');
  assert.deepEqual(mathy, ['𝕏']);
  assertWholeCodePoints(mathy, '𝕏');

  // The approximate budget counts astral CJK per character (regex /u
  // walks code points), never as two surrogate halves nor as one blob.
  assert.ok(
    approximateTokenCount('𠀀𠀀𠀀') >= 3,
    `per-character CJK budget for astral Han (got ${approximateTokenCount('𠀀𠀀𠀀')})`,
  );

  // BMP behavior is unchanged (regression guard against the rewrite).
  assert.deepEqual(tokenize('依赖数据库'), ['依赖', '赖数', '数据', '据库']);
  assert.deepEqual(tokenize('好'), ['好']);
});

// ───────────── 2. chunker: no-space CJK paragraphs window correctly ─────────────

test('chunker: 300-char no-space Chinese splits into bounded windows with exact offsets', () => {
  const SENTENCE = '数据宫殿依赖向量检索与增量压缩来维持长期记忆的召回质量。'; // 27 CJK chars + 。
  const text = SENTENCE.repeat(12); // 336 chars, zero whitespace anywhere
  const MAX_TOKENS = 48;
  const chunks = chunkText(text, { maxTokens: MAX_TOKENS, overlapTokens: 8, minTokens: 1 });

  assert.ok(chunks.length >= 2, `no-space CJK must window, not emit one blob (got ${chunks.length})`);
  let prevStart = -1;
  for (const c of chunks) {
    assert.ok(
      approximateTokenCount(c.text) <= MAX_TOKENS + 20,
      `each window within maxTokens+20 (got ${approximateTokenCount(c.text)})`,
    );
    assert.ok(c.startChar >= 0 && c.endChar <= text.length, 'offsets in bounds');
    assert.ok(c.startChar < c.endChar, 'non-empty span');
    assert.ok(c.startChar > prevStart, `strict forward progress (${prevStart} → ${c.startChar})`);
    prevStart = c.startChar;
    // Offsets address the ORIGINAL source exactly (slice reproduces the
    // chunk text verbatim — no drift, no half characters).
    assert.equal(
      text.slice(c.startChar, c.endChar),
      c.text,
      `startChar/endChar reproduce chunk ${c.index} from the source`,
    );
  }
});

// ───────── 3. query-understanding: hour windows vs day windows vs last year ─────────

test('query-understanding: hour/day rules do not hijack each other; 去年 is not recency', () => {
  const hours = parseQueryHints('last 3 hours', NOW);
  assert.ok(hours.sinceMs !== undefined, 'hour idiom opens a window');
  assert.ok(
    Math.abs(hours.sinceMs! - (NOW - 3 * HOUR)) <= 1,
    `last 3 hours → now-3h (got ${hours.sinceMs})`,
  );
  assert.ok(hours.sinceMs! <= NOW, 'window ends at now');
  assert.ok(hours.sinceMs! >= NOW - 3 * HOUR - 1_000, 'window starts in the 3h neighborhood');

  const zhHours = parseQueryHints('最近 6 小时的告警', NOW);
  assert.ok(
    Math.abs(zhHours.sinceMs! - (NOW - 6 * HOUR)) <= 1,
    `最近 N 小时 → hour window too (got ${zhHours.sinceMs})`,
  );

  const days = parseQueryHints('last 2 days', NOW);
  assert.equal(days.sinceMs, NOW - 2 * DAY, 'day rule wins for "last 2 days"');
  assert.ok(days.sinceMs! < NOW - 23 * HOUR, 'day-scale window, never the hour rule');

  const lastYear = parseQueryHints('去年的架构决策', NOW);
  assert.equal(lastYear.wantsRecent, false, '去年 is a past window, not a recency idiom');
  assert.equal(lastYear.sinceMs, NOW - 730 * DAY, '去年 window starts a year+ back');
  assert.equal(lastYear.untilMs, NOW - 365 * DAY, '去年 window ends a year ago');
});

// ───────────── 4. circuit breaker: stray and duplicate settles are no-ops ─────────────

test('breaker: settle without begin is ignored; duplicate settle is a no-op', () => {
  // A settle with nothing in flight must not throw and must not charge
  // failures or touch the state machine.
  const stray = new CircuitBreaker({ threshold: 3, cooldownMs: 1_000, now: () => 5_000 });
  stray.settleAttempt(false);
  stray.settleAttempt(true);
  assert.equal(stray.currentState, 'closed', 'stray settles leave the breaker closed');
  assert.equal(stray.canAttempt(), true, 'still attemptable');
  stray.recordFailure();
  stray.recordFailure();
  assert.equal(stray.currentState, 'closed', 'strays did not pre-charge the failure count');
  stray.recordFailure();
  assert.equal(stray.currentState, 'open', 'opens exactly at the genuine threshold');

  // begin → settle lands once; a SECOND settle for the same attempt is
  // ignored (must not double-charge the failure).
  const dup = new CircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: () => 5_000 });
  assert.equal(dup.beginAttempt(), true);
  dup.settleAttempt(false);
  assert.equal(dup.currentState, 'closed', 'one settled failure below threshold 2');
  dup.settleAttempt(false); // duplicate settle — defensive no-op
  assert.equal(dup.currentState, 'closed', 'duplicate settle did not charge a second failure');
  dup.recordFailure();
  assert.equal(dup.currentState, 'open', 'the second GENUINE failure is what opens it');
});

// ───────────── 5. query cache: near-duplicate stores replace, not pile up ─────────────

test('query-cache: re-storing a near-duplicate query replaces the old entry', () => {
  const cache = new SemanticQueryCache<string>({ capacity: 8, threshold: 0.985 });
  const DIMS = 64;
  const v = new Float32Array(DIMS);
  v[0] = 1;
  const w = new Float32Array(DIMS);
  w[0] = 1;
  w[1] = 0.1; // cosine ≈ 0.995 — a near-duplicate rephrasing, not a copy

  // Deterministic preconditions given the fixed anchor planes: the
  // near-dup lands within one sign flip of v's bucket and passes cosine.
  const keyV = anchorKey(v);
  const keyW = anchorKey(w);
  const hamming = [...keyV].filter((c, i) => c !== keyW[i]).length;
  assert.ok(hamming <= 1, `near-dup vector is an anchor neighbor (${keyV} vs ${keyW})`);
  assert.ok(cosine(v, w) >= 0.985, `cosine(v,w) = ${cosine(v, w)} ≥ threshold`);

  cache.store(v, 'k', 1, 'FIRST');
  assert.equal(cache.count, 1);
  cache.store(w, 'k', 1, 'SECOND');
  assert.equal(cache.count, 1, 'near-duplicate store REPLACED the entry instead of appending');
  assert.equal(cache.lookup(v, 'k', 1), 'SECOND', 'both phrasings now serve the replacement');
  assert.equal(cache.lookup(w, 'k', 1), 'SECOND');

  // A genuinely different query still appends normally.
  const far = new Float32Array(DIMS);
  far[2] = 1;
  cache.store(far, 'k', 1, 'FAR');
  assert.equal(cache.count, 2, 'distinct vectors are not collapsed by the dedupe guard');
});

// ───────── 6. consensus: "cannot" negates; two-digit years normalize to one day ─────────

test('consensus: cannot counts as negation; 1/5/99 == 01/05/2099 (no false conflict)', () => {
  assert.equal(
    negationPolarity('The gateway cannot reach the vault service.'),
    1,
    '"cannot" is a negation (own regex branch, not swallowed by "can\'t")',
  );
  assert.equal(
    negationPolarity('The gateway can reach the vault service.'),
    0,
    'control: affirmative sentence has polarity 0',
  );

  // Two-digit year 99 clamps at the 2099 ceiling of the 2000 tier, so the
  // slash date normalizes to exactly the same day as its four-digit form.
  const short = numericSignature('deployed on 1/5/99 and verified');
  const long = numericSignature('deployed on 01/05/2099 and verified');
  assert.deepEqual(
    short,
    long,
    `1/5/99 and 01/05/2099 normalize to one atomic date (got ${JSON.stringify(short)} vs ${JSON.stringify(long)})`,
  );
  assert.equal(
    detectConflict(
      { id: 'x', content: 'deployed on 1/5/99 and verified', score: 1 },
      { id: 'y', content: 'deployed on 01/05/2099 and verified', score: 1 },
    ).conflict,
    false,
    'same day under two-digit-year normalization corroborates, not conflicts',
  );
});
