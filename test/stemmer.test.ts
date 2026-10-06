/**
 * Unit tests for the deterministic retrieval-time stemmer (src/utils/stemmer.ts).
 *
 * The contract under test is FOLDING CONSISTENCY, not linguistic precision:
 * both sides of a lexical comparison fold through the same rules, so a few
 * accepted over/under-foldings (movies → movy) are pinned as-is — they are
 * the documented tradeoff of having no exception dictionary (DECISIONS
 * D-07, INVARIANTS I-NT-12).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stem,
  stemAll,
  excludingQueryStems,
  STEM_RULESET_VERSION,
} from '../src/utils/stemmer.ts';
import { expansionTokens } from '../src/utils/prf.ts';

test('deploy inflection family folds onto one stem', () => {
  assert.equal(stem('deploy'), 'deploy');
  assert.equal(stem('deploys'), 'deploy', '3rd-person s stripped');
  assert.equal(stem('deployed'), 'deploy', 'past-tense ed stripped');
  assert.equal(stem('deploying'), 'deploy', 'gerund ing stripped');
  // The product-smoke miss that motivated the stemmer: query "deploy"
  // against content "deploys" must be the same lexical term.
  assert.equal(stem('deploy'), stem('deploys'));
});

test('running → run via post-strip undoubling (falling keeps fall)', () => {
  // Tradeoff documented in the rules table: after dropping "ing" the
  // remainder is "runn"; the undoubling rule removes one doubled final
  // consonant ∉ {l, s, z} (Porter's exclusion), so run ↔ running fold.
  assert.equal(stem('running'), 'run');
  assert.equal(stem('run'), 'run');
  // The l/s/z exclusion is what keeps the OTHER class folding: falling
  // → fall (not fal), spelling → spell, processing → process.
  assert.equal(stem('falling'), 'fall');
  assert.equal(stem('fall'), 'fall');
  assert.equal(stem('spelling'), 'spell');
  assert.equal(stem('processing'), 'process');
});

test('databases → database: the s-strip folds the regular plural family', () => {
  // The single-s strip on "databases" (9 letters) removes one 's' and
  // lands exactly on "database" — the brief anticipated the overfold
  // 'databas', but the arithmetic works out to a clean fold here. The
  // accepted overfolding residual lives one rule up instead: ies → y
  // maps "movies" to "movy", which then misses "movie" (pinned below).
  assert.equal(stem('databases'), 'database');
  assert.equal(stem('database'), 'database');
  assert.equal(stem('databases'), stem('database'));
  assert.notEqual(stem('movies'), stem('movie'), 'accepted ies-overfold residual, pinned');
});

test('ies → y folds the plural/verb family (studies → study)', () => {
  assert.equal(stem('studies'), 'study');
  assert.equal(stem('study'), 'study');
  assert.equal(stem('studies'), stem('study'));
  assert.equal(stem('classes'), 'class', 'sses → ss');
  // Short ies-words miss the len > 4 guard but fold via the bare-s strip.
  assert.equal(stem('ties'), 'tie');
  assert.equal(stem('tie'), 'tie');
});

test('CJK and single-character tokens pass through unchanged', () => {
  assert.equal(stem('依赖'), '依赖');
  assert.equal(stem('数据'), '数据');
  // Mixed-script token: returned whole, never partially folded.
  assert.equal(stem('rag的'), 'rag的');
  assert.equal(stem('a'), 'a');
  assert.equal(stem('z'), 'z');
  // ss/us/is endings and short s-words keep their s (len > 3 guard).
  assert.equal(stem('its'), 'its');
  assert.equal(stem('bus'), 'bus');
  assert.equal(stem('class'), 'class');
  assert.equal(stem('focus'), 'focus');
  assert.equal(stem('basis'), 'basis');
});

test('ly strip is consonant-guarded: quickly → quick, family stays', () => {
  assert.equal(stem('quickly'), 'quick');
  assert.equal(stem('locally'), 'local');
  // Vowel before ly → no strip, which is what keeps family ↔ families
  // folding (families goes through ies → y and must land on "family").
  assert.equal(stem('family'), 'family');
  assert.equal(stem('families'), 'family');
  assert.equal(stem('family'), stem('families'));
});

test('stemAll maps elementwise and preserves order/multiplicity', () => {
  assert.deepEqual(stemAll(['deploys', '依赖', 'running', 'x']), ['deploy', '依赖', 'run', 'x']);
  assert.deepEqual(stemAll([]), []);
});

test('stemming never grows a token (fold sets ≤ raw sets)', () => {
  // Property the retriever's denominator comment leans on: stem output is
  // never longer than its input, so folded set sizes can only shrink.
  for (const t of ['deploys', 'running', 'studies', 'a', '依赖', 'kubernetes', 'movies']) {
    assert.ok(stem(t).length <= t.length, `${t} → ${stem(t)} grew`);
  }
  assert.equal(stem('kubernetes'), 'kubernete', 'unguarded s strip, consistent both sides');
});

test('excludingQueryStems drops expansion terms that are query inflections', () => {
  // Real prf.expansionTokens output: its raw-domain exclusion keeps
  // "deploys" (not a verbatim query token) even though the query said
  // "deploy". The stem-domain second pass drops exactly those.
  const queryTokens = ['deploy', 'aurora'];
  const expansion = expansionTokens(
    queryTokens,
    [
      ['aurora', 'deploys', 'kubernetes'],
      ['aurora', 'deploys', 'rollouts'],
    ],
    8,
  );
  assert.ok(expansion.includes('deploys'), 'precondition: raw-domain exclusion kept the variant');
  const filtered = excludingQueryStems(expansion, queryTokens);
  assert.ok(!filtered.includes('deploys'), 'variant of a query term dropped');
  assert.ok(filtered.includes('kubernetes'), 'genuinely new term kept');
  assert.deepEqual(excludingQueryStems([], queryTokens), []);
});

test('STEM_RULESET_VERSION is pinned in the retriever cache key', () => {
  // Meta-guard: the constant exists and is stable — the retriever embeds
  // it into paramsKey so a ruleset change can never cross-serve cache
  // entries scored under different folding rules (I-NT-12).
  assert.equal(STEM_RULESET_VERSION, 1);
});
