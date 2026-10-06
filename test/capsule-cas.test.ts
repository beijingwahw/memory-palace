/**
 * Cryptographic content-addressed storage (CAS) for memory capsules —
 * the D-02 terminal state and the I-DI-20 execution point.
 *
 * Guards:
 *   a. v3 id determinism + cross-process consistency (independent SHA-256
 *      re-derivation) and whitespace normalization.
 *   b. Three id generations coexisting in ONE capsule (8-hex v1 / 16-hex
 *      v2 / 32-hex v3, each recomputed by its own era's algorithm) parse
 *      cleanly, with legacyAddressCount observing the two pre-v3 items —
 *      and the observation field never enters the HMAC canonical form.
 *   c. The same-capsule address-collision tripwire: direct-drive of
 *      assertNoAddressCollisions, plus a REAL 32-bit FNV (v1) birthday
 *      collision driving the wire through parseCapsule — proof that the
 *      fail-loud path is wired, not just unit-testable.
 *   d. Generational separation: v1/v2/v3 address the same content to
 *      three distinct ids (no format-mixed keying).
 *   e. Coarse performance anchor: addressing 1 MiB of content stays
 *      comfortably interactive.
 *   f. Signature normalization-blindness: a sparse third-party capsule
 *      (optional fields omitted at signing time) still verifies after
 *      parseCapsule fills the defaults — the federation import path.
 *   g. planImport observability: an intra-capsule repeat (a later item
 *      whose normalized content matches an earlier one's — whitespace
 *      variants of one fact) is COUNTED in intraCapsuleDuplicates
 *      instead of silently vanishing from every bucket.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CAPSULE_MAGIC,
  type CapsuleItem,
  type MemoryCapsule,
  assertNoAddressCollisions,
  capsuleItemId,
  normalizedContent,
  parseCapsule,
  planImport,
  signCapsule,
  verifyCapsule,
} from '../src/utils/capsule.ts';
import { hash32 } from '../src/utils/embedding.ts';

// ---- per-generation id re-derivation (independent of src, frozen algo) ----

/** v1 (pre-widening): `cap:` + 8 hex, single FNV-1a round via hash32. */
function v1Id(content: string): string {
  return `cap:${hash32(normalizedContent(content)).toString(16).padStart(8, '0')}`;
}

/**
 * v2 (0.20.0 widening): `cap:` + 16 hex, dual-round FNV — round two seeds
 * with (round1 ^ 0x9e3779b9) and hashes again. Re-implemented HERE so the
 * test proves the frozen algorithm instead of calling the src twin.
 */
function v2Id(content: string): string {
  const fnv1a32Seeded = (s: string, seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const norm = normalizedContent(content);
  const hi = hash32(norm);
  const lo = fnv1a32Seeded(norm, (hi ^ 0x9e3779b9) >>> 0);
  return `cap:${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
}

function mkCapsuleItem(content: string, id: string): CapsuleItem {
  return {
    id,
    layer: 'semantic',
    content,
    importance: 0.5,
    createdAt: 1,
    entities: [],
    tags: [],
    source: 'user',
  };
}

function mkCapsule(items: CapsuleItem[]): MemoryCapsule {
  return {
    magic: CAPSULE_MAGIC,
    version: 1,
    palaceId: 'cas-test-palace',
    exportedAt: 1,
    items,
    patterns: [],
  };
}

// ------------------------------------------------------------ a. v3 identity

test('v3 ids are deterministic, normalization-safe, and re-derive from raw SHA-256', () => {
  const content = 'Aurora runs PostgreSQL 17 behind pgbouncer';
  // Same content twice → same id (pure function of the content).
  assert.equal(capsuleItemId(content), capsuleItemId(content));

  // Whitespace variants collapse to one normalized form → one id.
  assert.equal(
    capsuleItemId('Aurora   runs PostgreSQL 17\tbehind\npgbouncer'),
    capsuleItemId(content),
    'whitespace collapse → same id',
  );

  // CROSS-PROCESS CONSISTENCY, in-process proof: the id is nothing but the
  // first 32 hex of SHA-256 over the normalized content — an independent
  // re-derivation from node:crypto (what any other process would compute)
  // must agree byte-for-byte. No process-local state, seed, or ordering.
  const independent =
    'cap:' + createHash('sha256').update(normalizedContent(content), 'utf8').digest('hex').slice(0, 32);
  assert.equal(capsuleItemId(content), independent, 'id is pure truncated SHA-256');
  assert.match(capsuleItemId(content), /^cap:[0-9a-f]{32}$/, 'v3 shape: 32 hex');
});

// -------------------------------------------------- b. three generations coexist

test('one capsule may carry all three id generations; legacyAddressCount observes the pre-v3 items', () => {
  // Each item's id is recomputed by ITS OWN era's algorithm — no era's
  // validation is allowed to reject another era's mint.
  const capsule = mkCapsule([
    mkCapsuleItem('fact minted in the v1 era', v1Id('fact minted in the v1 era')),
    mkCapsuleItem('fact minted in the v2 era', v2Id('fact minted in the v2 era')),
    mkCapsuleItem('fact minted in the v3 era', capsuleItemId('fact minted in the v3 era')),
  ]);

  const parsed = parseCapsule(JSON.stringify(capsule));
  assert.equal(parsed.items.length, 3, 'all three generations parse');
  assert.equal(parsed.legacyAddressCount, 2, 'the 8-hex and 16-hex items are counted, the 32-hex is not');
  assert.match(parsed.items[0]!.id, /^cap:[0-9a-f]{8}$/);
  assert.match(parsed.items[1]!.id, /^cap:[0-9a-f]{16}$/);
  assert.match(parsed.items[2]!.id, /^cap:[0-9a-f]{32}$/);

  // A pure-v3 capsule reports 0 (absent on export, 0 after parse).
  const v3Only = parseCapsule(
    JSON.stringify(mkCapsule([mkCapsuleItem('modern fact', capsuleItemId('modern fact'))])),
  );
  assert.equal(v3Only.legacyAddressCount, 0, 'no pre-v3 addresses → count 0');

  // The observation field must never enter the HMAC canonical form: a
  // parsed capsule (legacyAddressCount set) and its pristine twin sign to
  // the SAME signature, and re-verifying a signed parsed capsule passes —
  // this is the federation import path (parseCapsule → verifyCapsule).
  const secret = 'cas-secret';
  const signedParsed = signCapsule(parsed, secret);
  const signedPristine = signCapsule({ ...capsule }, secret);
  assert.equal(signedParsed.signature, signedPristine.signature, 'signature is observation-field-blind');
  assert.ok(verifyCapsule(signedParsed, secret), 'signed parsed capsule verifies');
});

// ------------------------------------------------------ c. collision tripwire

test('assertNoAddressCollisions: same id over different content throws; same id same content is legal', () => {
  // Same id, DIFFERENT normalized content → the definition of a broken
  // address → fail loud with the colliding id for forensics.
  const id = capsuleItemId('the canonical spelling of this fact');
  assert.throws(
    () =>
      assertNoAddressCollisions([
        mkCapsuleItem('the canonical spelling of this fact', id),
        mkCapsuleItem('a DIFFERENT fact squatting on the same id', id),
      ]),
    /collision detected: cap:[0-9a-f]{32}/,
  );

  // Same id, SAME normalized content → the legal duplicate shape (an
  // exporter may repeat a fact; whitespace variants are one fact).
  assert.doesNotThrow(() =>
    assertNoAddressCollisions([
      mkCapsuleItem('repeated fact', id),
      mkCapsuleItem('repeated  fact', id), // normalizes identically
    ]),
  );

  // Empty / single items trivially pass.
  assert.doesNotThrow(() => assertNoAddressCollisions([]));
  assert.doesNotThrow(() => assertNoAddressCollisions([mkCapsuleItem('solo', capsuleItemId('solo'))]));
});

test('collision tripwire is wired into parseCapsule — proven with a REAL v1 (32-bit FNV) collision', () => {
  // Within parseCapsule the tripwire is reachable ONLY through a genuine
  // same-generation digest collision (every item's id was recomputed from
  // its own content first). For v3 that means broken SHA-256 — untestable
  // by construction, which is the point. For v1 a 32-bit birthday
  // collision is cheap to FIND deterministically (~77k probes at 50%),
  // and finding one exercises the exact wiring that would fire for a
  // broken v3: both items pass per-item validation, then the capsule as
  // a whole is refused, loudly, naming the colliding id.
  const seen = new Map<number, string>();
  let x = 0x2f6e2b1 >>> 0; // fixed seed → deterministic probe sequence
  let a = '';
  let b = '';
  let idHex = '';
  for (let i = 0; i < 2_000_000 && !idHex; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0; // LCG step
    const s = `v1-collision-probe-${i.toString(36)}-${(x >>> 20).toString(36)}`;
    const h = hash32(normalizedContent(s));
    const prev = seen.get(h);
    if (prev !== undefined && prev !== s) {
      a = prev;
      b = s;
      idHex = h.toString(16).padStart(8, '0');
    } else {
      seen.set(h, s);
    }
  }
  assert.match(idHex, /^[0-9a-f]{8}$/, 'birthday search found a real v1 collision (budget makes this certain)');
  assert.notEqual(normalizedContent(a), normalizedContent(b), 'the two contents are genuinely different facts');

  const capsule = mkCapsule([
    mkCapsuleItem(a, `cap:${idHex}`),
    mkCapsuleItem(b, `cap:${idHex}`), // same id — both recompute under v1
  ]);
  assert.throws(
    () => parseCapsule(JSON.stringify(capsule)),
    new RegExp(`\\[capsule\\] content-address collision detected: cap:${idHex}`),
    'silent wrong dedupe is refused; the capsule-level check fires after per-item validation',
  );
});

// ------------------------------------------------- d. generational separation

test('v3, v2 and v1 address the same content to three DISTINCT ids (no format-mixed keying)', () => {
  const content = 'one fact, addressed by three eras of the algorithm';
  const ids = new Set([capsuleItemId(content), v2Id(content), v1Id(content)]);
  assert.equal(ids.size, 3, 'no generation ever mints another generation\'s id');
  // The three ids even differ per-slice shape: lengths 32/16/8 hex. This
  // is why re-export churns legacy ids to v3 while planImport — which
  // dedupes by NORMALIZED CONTENT, never by id — stays correct across
  // the churn.
  assert.equal(capsuleItemId(content).length, 4 + 32);
  assert.equal(v2Id(content).length, 4 + 16);
  assert.equal(v1Id(content).length, 4 + 8);
});

// -------------------------------------------------------- e. performance anchor

test('addressing 1 MiB of content stays fast (coarse anchor, not a benchmark)', () => {
  // Coarse regression anchor, NOT a precise benchmark: sha256 of 1 MiB is
  // ~1-3 ms of native crypto; the < 50 ms bound only exists to catch an
  // accidental O(n²) pass or per-chunk allocation regression in the
  // pipeline feeding the digest.
  const big = 'k'.repeat(1024 * 1024);
  const t0 = Date.now();
  const id = capsuleItemId(big);
  const elapsed = Date.now() - t0;
  assert.match(id, /^cap:[0-9a-f]{32}$/);
  assert.ok(
    elapsed < 50,
    `capsuleItemId over 1 MiB took ${elapsed} ms (coarse anchor is 50 ms)`,
  );
});

// ------------------------------------------- f. signature normalization-blindness

test('sparse third-party capsules verify after parse fills omitted defaults', () => {
  const secret = 'cas-secret';
  // The sparse wire shape a third-party exporter produces when it omits
  // every optional field: items carry no tags/entities, the capsule
  // carries no patterns (source is also absent — parseCapsule leaves it
  // alone, so it never enters the normalization question). Before
  // normalization-blind signing, the federation import path (parseCapsule
  // fills the defaults, THEN verifyCapsule canonicalizes) compared a
  // different JSON than was signed — a permanent "signature mismatch"
  // indistinguishable from a wrong secret.
  const raw = {
    magic: CAPSULE_MAGIC,
    version: 1,
    palaceId: 'sparse-third-party-palace',
    exportedAt: 1,
    items: [
      {
        id: capsuleItemId('sparse fact exported without optional fields'),
        layer: 'semantic',
        content: 'sparse fact exported without optional fields',
        importance: 0.5,
        createdAt: 1,
      },
    ],
  } as MemoryCapsule;

  const parsed = parseCapsule(JSON.stringify(signCapsule(raw, secret)));
  assert.equal(parsed.items[0]?.tags.length, 0, 'parse filled the absent tags');
  assert.equal(parsed.items[0]?.entities.length, 0, 'parse filled the absent entities');
  assert.equal(parsed.patterns.length, 0, 'parse filled the absent patterns');
  assert.equal(verifyCapsule(parsed, secret), true, 'sparse capsule verifies after parse normalization');

  // Normalization must not weaken tamper evidence: one mutated field on
  // the parsed capsule still rejects.
  assert.equal(
    verifyCapsule({ ...parsed, palaceId: 'attacker-palace' }, secret),
    false,
    'tampered field rejects',
  );

  // First-party shape (no field omitted) round-trips as before — for it
  // the normalization is a no-op, so previously signed capsules stay valid.
  const full = mkCapsule([mkCapsuleItem('fully populated fact', capsuleItemId('fully populated fact'))]);
  const parsedFull = parseCapsule(JSON.stringify(signCapsule(full, secret)));
  assert.equal(verifyCapsule(parsedFull, secret), true, 'fully populated round-trip still verifies');
});

// ------------------------------------------- g. planImport intra-capsule dedup observability

test('planImport counts intra-capsule duplicates instead of silently dropping them', () => {
  // Two items whose contents differ only in WHITESPACE normalize to one
  // fact (case is significant — only whitespace collapses), so they mint
  // the same v3 id (the legal same-id-same-content shape). The second
  // used to vanish into planImport's `seen` set: no bucket, no count.
  const first = 'the palace keeps   the runbook';
  const repeat = 'the  palace\tkeeps\nthe runbook';
  assert.equal(normalizedContent(first), normalizedContent(repeat), 'precondition: one normalized form');
  const capsule = mkCapsule([
    mkCapsuleItem(first, capsuleItemId(first)),
    mkCapsuleItem(repeat, capsuleItemId(repeat)),
  ]);
  const plan = planImport(capsule, () => false, () => []);
  assert.equal(plan.toInsert.length, 1, 'the first occurrence plans for insert');
  assert.equal(plan.intraCapsuleDuplicates, 1, 'the whitespace-variant repeat is counted, not dropped');
  assert.equal(plan.duplicates.length, 0, 'no store-side duplicates');
  assert.equal(plan.conflicts.length, 0, 'no conflicts');
  assert.equal(plan.conflictOnly.length, 0, 'no conflict-only items');
});
