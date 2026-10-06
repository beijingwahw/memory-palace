/**
 * Core-memory kernel tests: line scoring, dedupe compaction, cap eviction,
 * merge freshness — all deterministic (seeded where random-ish).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactBlock,
  mergeIntoBlock,
  lineScore,
  lineSimilarity,
  splitLines,
} from '../src/utils/core-memory.ts';

test('splitLines handles bullets, blanks, and markdown', () => {
  const out = splitLines('# Title\n\n- first bullet\n* second\n\nplain line');
  assert.deepEqual(out, ['# Title', 'first bullet', 'second', 'plain line']);
});

test('lineScore rewards structure, entities, and brevity', () => {
  const plain = 'a random line of text';
  const structured = '## Deployment';
  const goalish = 'P0 goal: ship the migration by Friday';
  const hot = new Set(['kafka']);
  const withEntity = 'tune the kafka pipeline now';
  assert.ok(lineScore(structured) > lineScore(plain), 'headers beat plain');
  assert.ok(lineScore(goalish) > lineScore(plain), 'goal markers beat plain');
  assert.ok(
    lineScore(withEntity, hot) > lineScore(withEntity),
    'hot entity boosts the line',
  );
});

test('compactBlock dedupes near-identical lines', () => {
  const content = [
    'Kafka throughput tuning needs partition rebalancing first',
    'kafka throughput tuning needs partition rebalancing before anything else',
    'Unrelated note about the office plants',
  ].join('\n');
  const r = compactBlock(content, { maxTokens: 200 });
  assert.equal(r.kept, 2, 'duplicate merged away');
  assert.equal(r.removed, 1);
  assert.ok(r.content.includes('office plants'), 'unrelated line kept');
});

test('compactBlock evicts lowest-score lines over the token cap', () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(`filler line number ${i} with some padding text`);
  lines.push('## Critical');
  lines.push('P0 goal: ship by Friday');
  const r = compactBlock(lines.join('\n'), { maxTokens: 60 });
  assert.ok(r.kept < 32, 'evicted over-cap lines');
  assert.ok(r.content.includes('## Critical'), 'structural line survives');
  assert.ok(r.content.includes('P0 goal'), 'goal line survives');
  assert.ok(r.removedPreviews.length <= 8, 'previews bounded');
});

test('compactBlock preserves original relative order of survivors', () => {
  const content = 'zebra first\nalpha second\nmiddle third\nomega fourth';
  const r = compactBlock(content, { maxTokens: 200 });
  const idx = (s: string) => r.content.indexOf(s);
  assert.ok(idx('zebra first') < idx('alpha second'), 'order preserved');
  assert.ok(idx('alpha second') < idx('omega fourth'), 'order preserved');
});

test('mergeIntoBlock merges additions and dedupes against existing', () => {
  const existing = 'Project Aurora uses PostgreSQL 16\nRisk: single region';
  const r = mergeIntoBlock(
    existing,
    ['project Aurora uses PostgreSQL 16!', 'P0 goal: migrate to 17'],
    { maxTokens: 200 },
  );
  assert.ok(r.removed >= 1, 'duplicate addition merged');
  assert.ok(r.content.includes('migrate to 17'), 'new content present');
  assert.ok(r.content.includes('Risk'), 'existing content kept');
});

test('lineSimilarity: identical=1, disjoint≈0', () => {
  assert.ok(lineSimilarity('alpha beta gamma', 'alpha beta gamma') > 0.99);
  assert.equal(lineSimilarity('alpha beta', 'xray yankee'), 0);
});
