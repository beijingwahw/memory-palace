/**
 * Unit tests for the contrast-based pattern miner (procedural memory core).
 * All fixtures use fixed timestamps on distinct days and a fixed `now`, so
 * every expectation is exact and reproducible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minePatterns } from '../src/utils/pattern-miner.ts';
import type { MinerItem } from '../src/utils/pattern-miner.ts';

const DAY = 86_400_000;
/** Fixed epoch: 2023-11-14T22:13:20Z. */
const T0 = 1_700_000_000_000;
const NOW = 1_710_000_000_000;

/** User-voice item on day `day` with a stable id. */
function user(content: string, importance: number, day: number, id: string): MinerItem {
  return { content, importance, role: 'user', createdAt: T0 + day * DAY, id };
}

test('token recurring across 3 high-importance days yields a prefers- pattern', () => {
  const items: MinerItem[] = [
    user('Typescript works better here', 0.9, 0, 'ts-1'),
    user('Rewrite that module in typescript', 0.9, 1, 'ts-2'),
    user('Typescript catches these bugs early', 0.9, 2, 'ts-3'),
    // Incidental low-importance chatter, each with unique words.
    user('The cafeteria menu repeats weekly', 0.2, 0, 'f-1'),
    user('Random hallway chatter about weekends', 0.2, 1, 'f-2'),
    user('Casual notes on parking spots', 0.2, 2, 'f-3'),
  ];

  const patterns = minePatterns(items, { now: NOW });
  const pref = patterns.find((p) => p.pattern === 'prefers-typescript');
  assert.ok(pref, `expected prefers-typescript, got ${JSON.stringify(patterns.map((p) => p.pattern))}`);

  // df=3, days=3, mean importance 0.9 vs corpus 0.55 → well above the gates.
  assert.ok(pref!.confidence > 0.5 && pref!.confidence <= 1, 'confidence in a confident range');
  assert.match(pref!.description, /"typescript"/);
  assert.match(pref!.description, /3 distinct high-importance memories across 3 days/);
  // All supporters tie on importance → evidence keeps input order, ids used.
  assert.deepEqual(pref!.evidence, ['ts-1', 'ts-2', 'ts-3'], 'evidence cites supporting items');
  assert.equal(pref!.createdAt, NOW, 'createdAt uses the injected clock');
});

test('low-importance incidental repetition does not pass the contrast gate', () => {
  const items: MinerItem[] = [
    // "meeting" recurs across 3 days, but only in throwaway low-importance
    // items, while the corpus mean is pulled up by the high-importance ones.
    user('Meeting went long today', 0.1, 0, 'm-1'),
    user('Meeting room double booked', 0.1, 1, 'm-2'),
    user('Meeting agenda attached separately', 0.1, 2, 'm-3'),
    user('Deploy the edge cache tonight', 0.9, 0, 'h-1'),
    user('Rotate database credentials quarterly', 0.9, 1, 'h-2'),
    user('Audit billing dashboards carefully', 0.9, 2, 'h-3'),
    // Assistant voice must not be mined even when it repeats the token.
    {
      content: 'Meeting recap follows the agenda',
      importance: 0.9,
      role: 'assistant',
      createdAt: T0 + 3 * DAY,
      id: 'a-1',
    },
  ];

  const patterns = minePatterns(items, { now: NOW });
  assert.ok(
    patterns.every((p) => p.pattern !== 'prefers-meeting'),
    'incidental low-importance repetition is not a preference',
  );
  // Nothing else recurs, so the mining result is empty.
  assert.deepEqual(patterns, [], 'no other token reaches minSupport');
});

test('recurring bigram among qualifying tokens yields a topic: pattern', () => {
  const items: MinerItem[] = [
    user('Kubernetes helm chart upgrade planned', 0.8, 0, 'k-1'),
    user('Helm values tuned for kubernetes', 0.8, 1, 'k-2'),
    user('Kubernetes rollout via helm succeeded', 0.8, 2, 'k-3'),
    user('Pin helm repository kubernetes wide', 0.8, 3, 'k-4'),
    user('Lunch options near the office', 0.1, 0, 'f-1'),
    user('Weekend hiking trail maps', 0.1, 1, 'f-2'),
  ];

  const patterns = minePatterns(items, { now: NOW });
  const topic = patterns.find((p) => p.pattern === 'topic:helm+kubernetes');
  assert.ok(topic, `expected topic:helm+kubernetes, got ${JSON.stringify(patterns.map((p) => p.pattern))}`);
  // 0.4 + 0.2·(4−3) + 0.1·min(4−1,2)
  assert.ok(Math.abs(topic!.confidence - 0.8) < 1e-9, `confidence from co-occurrence count (got ${topic!.confidence})`);
  assert.match(topic!.description, /"helm" and "kubernetes" recur together in 4 memories/);
  assert.deepEqual(topic!.evidence, ['k-1', 'k-2', 'k-3', 'k-4'], 'evidence cites co-occurring items');
});

test('output is deterministic and capped at 50 patterns', () => {
  // 60 distinct motifs × 3 days each = 60 qualifying preference patterns,
  // far past the cap; every pattern ties on confidence, so the name-asc
  // tiebreak is exercised too.
  const items: MinerItem[] = [];
  for (let i = 0; i < 60; i++) {
    for (const day of [0, 1, 2]) {
      items.push(user(`motif${i} only`, 0.9, day, `m-${i}-${day}`));
    }
  }
  for (let i = 0; i < 20; i++) {
    items.push(user(`filler${i} noise${i}`, 0.1, 0, `f-${i}`));
  }

  const r1 = minePatterns(items, { now: NOW });
  const r2 = minePatterns(items, { now: NOW });
  assert.deepEqual(r1, r2, 'same input → identical output (deep equal across runs)');

  assert.equal(r1.length, 50, 'pattern list capped at 50');
  const names = r1.map((p) => p.pattern);
  assert.deepEqual(names, [...names].sort(), 'equal-confidence ties break by name ascending');
  assert.ok(names.every((n) => n.startsWith('prefers-')), 'all surviving patterns are preferences');
  for (const p of r1) {
    assert.equal(p.evidence.length, 3, 'evidence capped at 5, all 3 supporters cited');
    assert.equal(p.createdAt, NOW, 'createdAt from injected clock');
  }
});

test('empty input (or no user-voice items) yields no patterns', () => {
  assert.deepEqual(minePatterns([]), [], 'empty array → empty result');
  assert.deepEqual(
    minePatterns([{ content: 'typescript everywhere', importance: 0.9, role: 'system', createdAt: T0 }], { now: NOW }),
    [],
    'non-user items are never mined',
  );
});
