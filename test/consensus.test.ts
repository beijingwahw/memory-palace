/**
 * Focused tests for the consensus contradiction heuristic:
 *
 *  - unit-aware numeric signatures: dates and versions are extracted as
 *    ATOMIC entries (with padding normalization), never shattered into
 *    digit fragments that collide or mask across statements;
 *  - Chinese negation polarity: affirmative 不-idioms (不错/不断/…) are not
 *    counted as negations, while true negations (不会/没有/…) are.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cnNegationCount,
  clusterByConsensus,
  detectConflict,
  negationPolarity,
  numericSignature,
  signaturesOf,
} from '../src/utils/consensus.ts';

const item = (id: string, content: string, score = 1) => ({ id, content, score });

// ------------------------------------------------- unit-aware signatures

test('signaturesOf extracts dates, versions and numbers in three passes', () => {
  const s = signaturesOf('Deployed 2024-01-15 with v1.2.3 on 3 nodes');
  assert.deepEqual(s.dates, ['2024-01-15'], 'ISO date is one atomic entry');
  assert.deepEqual(s.versions, ['1.2.3'], 'version is one atomic entry (v stripped)');
  assert.deepEqual(s.numbers, ['3'], 'remaining plain integer found');
  // Nothing leaked between passes: the date's digits are not plain numbers.
  assert.deepEqual(
    numericSignature('deployed on 2024-01-15'),
    ['2024-01-15'],
    'no 2024/01/15 fragments',
  );
});

test('unpadded dates normalize equal to padded ones', () => {
  assert.deepEqual(numericSignature('2024-1-15'), ['2024-01-15'], 'month/day zero-padded');
  assert.deepEqual(numericSignature('2024-1-5'), ['2024-01-05'], 'single-digit day padded');
  assert.deepEqual(numericSignature('1/5/2024'), ['01/05/2024'], 'slash date padded');
  // Datetime separator canonicalized: T and space forms are the same unit.
  assert.deepEqual(
    numericSignature('met 2024-01-15T09:30 or 2024-01-15 09:30'),
    ['2024-01-15T09:30'],
    'T/space datetime forms normalize together',
  );
  assert.equal(
    detectConflict(item('a', 'deployed on 2024-1-15'), item('b', 'deployed on 2024-01-15'))
      .conflict,
    false,
    '2024-1-15 and 2024-01-15 corroborate',
  );
});

test('same date, different topic: no conflict', () => {
  const a = item('a', 'Deployed the payments service on 2024-01-15.');
  const b = item('b', 'Team offsite was scheduled on 2024-01-15.');
  assert.equal(detectConflict(a, b).conflict, false, 'shared date is not a differing value');
});

test('same topic, different date: conflict carrying the DATE as the value', () => {
  const a = item('a', 'The gateway was deployed on 2024-01-15.');
  const b = item('b', 'The gateway was deployed on 2024-02-20.');
  const det = detectConflict(a, b);
  assert.equal(det.conflict, true, 'different dates conflict');
  assert.ok(
    det.reason?.includes('2024-01-15') && det.reason?.includes('2024-02-20'),
    `reason shows the atomic dates, got: ${det.reason}`,
  );
});

test('versions are atomic: 1.2.3 vs 1.2.4 conflicts, v-prefix equal', () => {
  const s = signaturesOf('CI uses toolchain v1.2.3 for builds');
  assert.deepEqual(s.versions, ['1.2.3'], 'version atomic');
  assert.deepEqual(s.numbers, [], 'version never shatters into 1/2/3');

  const det = detectConflict(
    item('a', 'CI uses toolchain 1.2.3 for builds.'),
    item('b', 'CI uses toolchain 1.2.4 for builds.'),
  );
  assert.equal(det.conflict, true, 'patch drift conflicts');
  assert.ok(
    det.reason?.includes('1.2.3') && det.reason?.includes('1.2.4'),
    `reason shows versions, got: ${det.reason}`,
  );
  assert.equal(
    detectConflict(item('a', 'CI uses toolchain v1.2.3.'), item('b', 'CI uses toolchain 1.2.3.'))
      .conflict,
    false,
    'v1.2.3 == 1.2.3',
  );
});

test('plain quantities still conflict: 3 nodes vs 5 nodes', () => {
  const det = detectConflict(
    item('a', 'deployed on 3 nodes'),
    item('b', 'deployed on 5 nodes'),
  );
  assert.equal(det.conflict, true, 'node count drift conflicts');
  assert.match(det.reason ?? '', /\b3\b.*\b5\b/, 'reason carries the counts');
  assert.equal(
    detectConflict(item('a', 'deployed on 3 nodes'), item('b', 'running on 3 nodes')).conflict,
    false,
    'same count corroborates',
  );
});

test('clusterByConsensus surfaces date conflicts with the date as value', () => {
  const items = [
    item('1', 'Release 2024-01-15 shipped the gateway deploy.', 0.9),
    item('2', 'The gateway deploy shipped on 2024-02-20 instead.', 0.8),
  ];
  const clusters = clusterByConsensus(items, { similarityThreshold: 0.3 });
  assert.equal(clusters.length, 1, 'same-topic statements merge');
  assert.equal(clusters[0].conflict, true, 'date drift flagged');
  assert.match(clusters[0].conflictReason ?? '', /2024-01-15.*2024-02-20/);
});

// ------------------------------------------------ Chinese negation polarity

test('affirmative 不-idioms are not negations', () => {
  assert.equal(cnNegationCount('这个方案不错'), 0, '不错 skipped');
  assert.equal(cnNegationCount('不断优化中'), 0, '不断 skipped');
  assert.equal(cnNegationCount('不仅快而且稳'), 0, '不仅 skipped');
  assert.equal(negationPolarity('这个方案不错，可以采用'), 0, '不错 stays affirmative');
});

test('true Chinese negations are counted', () => {
  assert.equal(cnNegationCount('我们不会使用 Kafka'), 1, '不会 counted');
  assert.equal(negationPolarity('我们不会使用 Kafka'), 1, '不会 is negated');
  assert.equal(cnNegationCount('别再拖了'), 1, '别再 counted');
  assert.equal(cnNegationCount('没有备份'), 1, '没有 counted');
  assert.equal(cnNegationCount('今天不加班'), 1, 'standalone 不 still negates');
  assert.equal(cnNegationCount('不是不可能'), 2, 'double negation → even count');
  // Blacklist consumption prevents the 不会 pair from double counting.
  assert.equal(cnNegationCount('不会不错'), 1, 'negation then idiom, no leak');
});

test('Chinese polarity flip conflicts through detectConflict', () => {
  const neg = item('a', '我们 不用 Kafka 做队列');
  const pos = item('b', '我们 已用 Kafka 做队列');
  const det = detectConflict(neg, pos);
  assert.equal(det.conflict, true, '不用 vs 用 flips polarity');
  assert.equal(det.reason, 'affirmative vs negated statements');
});
