/**
 * Regression guards for query-understanding temporal parsing.
 *
 * Focus: the negative-lookahead-guarded English idiom rules must not leak a
 * window into adjective derivatives ("the last weekly report", "this weekly
 * sync", "last monthly summary") while still recognizing the true idioms
 * ("last week", "this week", "上个月", "最近 3 天"). All cases run against a
 * fixed NOW so the expected windows are exact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQueryHints } from '../src/utils/query-understanding.ts';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000; // fixed clock: 2025-10-09T04:53:20Z — never Date.now()

function parse(query: string) {
  return parseQueryHints(query, NOW);
}

// ---------------------------------------------------------------------------
// MUST NOT open a window (guarded derivative forms)
// ---------------------------------------------------------------------------

test('"the last weekly report" imposes no temporal window', () => {
  const h = parse('the last weekly report');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
  assert.equal(h.wantsRecent, false, 'no rule may fire at all');
});

test('"this weekly sync" imposes no temporal window', () => {
  const h = parse('this weekly sync');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
  assert.equal(h.wantsRecent, false, 'no rule may fire at all');
});

test('"last monthly summary" imposes no temporal window', () => {
  const h = parse('last monthly summary');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
  assert.equal(h.wantsRecent, false, 'no rule may fire at all');
});

test('plural "last weeks" is also blocked by the lookahead guard', () => {
  const h = parse('the last weeks of the quarter');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
});

test('"last weekend" imposes no window (end lookahead)', () => {
  // The [-14d,-7d] week window would EXCLUDE the actual previous weekend
  // days it is asked about, so the idiom rule must not fire at all.
  const h = parse('what did I do last weekend');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
  assert.equal(h.wantsRecent, false, 'no rule may fire at all');
});

test('"the last years" imposes no window (plural blocked)', () => {
  const h = parse('the last years of the project');
  assert.equal(h.sinceMs, undefined, 'sinceMs must be unset');
  assert.equal(h.untilMs, undefined, 'untilMs must be unset');
});

test('"laptop 3 days ago" does not parse a topK', () => {
  // \b guard: the "top" inside "laptop" is not a result-size request.
  const h = parse('issues with my laptop 3 days ago');
  assert.equal(h.topK, undefined, 'topK must be unset');
});

// ---------------------------------------------------------------------------
// MUST open a window (true idioms survive the guards)
// ---------------------------------------------------------------------------

test('"last week" sets the exact [now-14d, now-7d] window', () => {
  const h = parse('what did we decide last week');
  assert.equal(h.sinceMs, NOW - 14 * DAY, 'sinceMs is exactly now-14d');
  assert.equal(h.untilMs, NOW - 7 * DAY, 'untilMs is exactly now-7d');
});

test('"this week progress" sets a since-only -7d window', () => {
  const h = parse('this week progress');
  assert.equal(h.sinceMs, NOW - 7 * DAY);
  assert.equal(h.untilMs, undefined);
  assert.equal(h.wantsRecent, true);
});

test('"上个月的部署" sets the exact [now-62d, now-31d] window', () => {
  const h = parse('上个月的部署');
  assert.equal(h.sinceMs, NOW - 62 * DAY);
  assert.equal(h.untilMs, NOW - 31 * DAY);
});

test('"最近 3 天" sets a since-only -3d window', () => {
  const h = parse('最近 3 天');
  assert.equal(h.sinceMs, NOW - 3 * DAY);
  assert.equal(h.untilMs, undefined);
  assert.equal(h.wantsRecent, true);
});

// ---------------------------------------------------------------------------
// Purity: repeated parses of the same query are identical
// ---------------------------------------------------------------------------

test('repeated parse calls are pure (same output twice)', () => {
  const query = 'notes on "deploy pipeline" from last week, top 10';
  const first = parse(query);
  const second = parse(query);
  assert.deepStrictEqual(second, first, 'second parse differs from first');
  // And the first call already produced the full expected shape, proving the
  // global PHRASE_RE / shared state is reset rather than accumulating.
  assert.deepStrictEqual(first, {
    sinceMs: NOW - 14 * DAY,
    untilMs: NOW - 7 * DAY,
    topK: 10,
    phrases: ['deploy pipeline'],
    wantsRecent: false,
  });
});
