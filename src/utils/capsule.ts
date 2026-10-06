/**
 * Memory Capsules — inter-agent knowledge transport.
 *
 * A memory palace is single-tenant by design (four-tier ACL, scoped
 * graph). Capsules are the CONTROLLED bridge between palaces: a signed,
 * content-addressed bundle of distilled knowledge that one agent hands to
 * another — team onboarding, agent handover, or memory commerce.
 *
 * Design invariants:
 *
 *   - DETERMINISTIC CONTENT IDS: every item's id is `cap:<128-bit truncated
 *     SHA-256 of the normalized content>`, so the same fact exported from
 *     two palaces yields the same id and imports dedupe by construction,
 *     not by trusting the exporter. (DECISIONS D-02: originally accepted a
 *     32-bit collision birthday bound, then mitigated at 64 bits, now
 *     ELIMINATED by the cryptographic CAS — see capsuleItemId. parseCapsule
 *     keeps all three id generations importable forever and trips a
 *     fail-loud forensic wire on any same-capsule address collision.)
 *   - TAMPER EVIDENCE: an optional HMAC-SHA256 signature over the
 *     canonical JSON (recursively key-sorted, no signature field) proves
 *     the capsule came from a holder of the shared secret and was not
 *     modified in transit.
 *   - OWNER REBINDING: capsules carry NO owner identity. Export strips
 *     user/workspace/session ids; import rebinds every item to the
 *     importer's identity at the importer's chosen visibility tier. A
 *     capsule can never smuggle private ownership across the boundary.
 *   - CONFLICT AWARENESS: the import plan runs the same contradiction
 *     heuristics as memory_remember (dates/versions/polarity), so stale
 *     facts arrive flagged, not silently merged.
 *
 * Pure module — no store, no I/O.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { hash32 } from './embedding.js';
import { detectConflict } from './consensus.js';
import type { MemoryItem, MemoryLayer, MemoryMetadata } from '../types/index.js';
import type { VisibilityTier } from './scope.js';

export const CAPSULE_MAGIC = 'dsh-memory-capsule';
export const CAPSULE_VERSION = 1;

export interface CapsuleItem {
  /**
   * Deterministic content id: `cap:` + 32 hex (128-bit truncated SHA-256)
   * — same fact, same id, anywhere. Capsules minted before the
   * cryptographic CAS carry `cap:` + 16 hex (v2, dual-round FNV) or
   * `cap:` + 8 hex (v1, single-round FNV); parseCapsule recomputes and
   * accepts all three generations forever.
   */
  id: string;
  layer: MemoryLayer;
  content: string;
  importance: number;
  createdAt: number;
  /** Embedding serialized as base64 Float32 + its space tag. */
  embedding?: { space: string; dim: number; b64: string };
  /** Entity NAMES mentioned (the graph rehydrates from names, not ids —
   *  ids are palace-local and must never cross the boundary). */
  entities: string[];
  tags: string[];
  source: MemoryMetadata['source'];
}

export interface CapsulePattern {
  pattern: string;
  description: string;
  confidence: number;
  evidenceCount: number;
}

export interface MemoryCapsule {
  magic: typeof CAPSULE_MAGIC;
  version: typeof CAPSULE_VERSION;
  /** Exporter palace identifier (informational provenance). */
  palaceId: string;
  exportedAt: number;
  items: CapsuleItem[];
  patterns: CapsulePattern[];
  /**
   * OBSERVATIONAL, set by parseCapsule: how many items still carry a
   * pre-v3 address (8-hex v1 or 16-hex v2). Absent on freshly exported
   * capsules (treated as 0). Excluded from the HMAC canonical form, so
   * re-signing or verifying a parsed capsule is unaffected. Consumers
   * (e.g. a future ImportReport field) may surface it as a re-export
   * hint — importing is unaffected either way; this only observes.
   */
  legacyAddressCount?: number;
  /** HMAC-SHA256 over canonical JSON of the capsule without this field. */
  signature?: string;
}

// ----- Canonical JSON + signatures ------------------------------------------

/** Recursively key-sorted, whitespace-free JSON — the signing canonical form. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * Capsule shape as a counterparty may hand it over, BEFORE parseCapsule
 * normalizes it: the list fields (top-level patterns, per-item
 * tags/entities) are optional on the wire, and signature math must
 * tolerate their absence at runtime. A fully-filled MemoryCapsule is
 * assignable to this view (required → optional), which is why
 * signCapsule/verifyCapsule can feed their typed capsules in directly.
 */
type SparseCapsule = Omit<MemoryCapsule, 'items' | 'patterns'> & {
  patterns?: CapsulePattern[];
  items: ReadonlyArray<
    Omit<CapsuleItem, 'tags' | 'entities'> & { tags?: string[]; entities?: string[] }
  >;
};

/**
 * The HMAC input view: transport-only fields stripped and parse-time
 * defaults pre-applied. parseCapsule fills absent item tags/entities and
 * absent top-level patterns with [], so the signature must be computed
 * over the FILLED form — a third-party exporter that omits those optional
 * fields would otherwise produce a capsule whose sparse signature can
 * never survive the federation import path (parseCapsule fills, THEN
 * verifyCapsule compares, over differently-shaped canonical JSON). For
 * capsules that carry all fields — every first-party export and every
 * capsule signed by earlier versions — the normalization is a no-op, so
 * existing signatures stay valid. The two transport-only keys are
 * REMOVED (delete) rather than written as `undefined` — forbidden under
 * exactOptionalPropertyTypes — which is byte-identical for signing:
 * canonical JSON drops undefined-valued keys anyway.
 */
function unsignedView(capsule: SparseCapsule): Omit<MemoryCapsule, 'signature' | 'legacyAddressCount'> {
  const view = {
    ...capsule,
    patterns: capsule.patterns ?? [],
    items: capsule.items.map((it) => ({ ...it, tags: it.tags ?? [], entities: it.entities ?? [] })),
  };
  delete view.signature;
  delete view.legacyAddressCount;
  return view;
}

export function signCapsule(capsule: MemoryCapsule, secret: string): MemoryCapsule {
  // legacyAddressCount is parse-time observation metadata, not payload —
  // unsignedView strips it alongside the signature so the canonical
  // (signed) form of a capsule never depends on whether it has been parsed.
  const unsigned = unsignedView(capsule);
  const sig = createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('hex');
  return { ...unsigned, signature: sig };
}

/** True when the signature matches (unsigned capsules are rejected). */
export function verifyCapsule(capsule: MemoryCapsule, secret: string): boolean {
  if (!capsule.signature) return false;
  const expected = createHmac('sha256', secret).update(canonicalJson(unsignedView(capsule))).digest('hex');
  const a = Buffer.from(capsule.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ----- Build & parse ----------------------------------------------------------

/** Normalize content for content-addressing: collapse whitespace. */
export function normalizedContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

/**
 * Fixed salt mixed into the second addressing round (golden-ratio constant
 * 0x9e3779b9 — chosen once, frozen forever: any change silently invalidates
 * every minted capsule id).
 */
const CAPSULE_HASH2_SALT = 0x9e3779b9;

/**
 * Seeded FNV-1a 32 — the same discipline as embedding.ts `hash32` (zero
 * dependencies, char-code iteration, Math.imul wrapping), but with a
 * caller-controlled offset basis so the second addressing round is an
 * independent function of the first. `hash32` itself is single-seed, hence
 * this local twin.
 */
function fnv1a32Seeded(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Legacy pre-widening id (`cap:` + 8 hex, single FNV-1a round) — NOT for
 * minting; kept solely so parseCapsule can verify capsules minted before
 * the D-02 mitigation. Existing capsules never expire.
 */
function legacyCapsuleItemId(content: string): string {
  return `cap:${hash32(normalizedContent(content)).toString(16).padStart(8, '0')}`;
}

/**
 * v2 id (`cap:` + 16 hex, dual-round FNV-1a) — the 0.20.0 D-02 mitigation,
 * now itself legacy. NOT for minting since the cryptographic CAS (v3);
 * kept solely so parseCapsule can verify capsules minted in the v2 era.
 *
 * Round two reseeds with `(round1 ^ CAPSULE_HASH2_SALT)` and hashes again,
 * so a collision requires BOTH 32-bit lanes to collide simultaneously
 * (birthday bound ~5e9 items at 50%).
 */
function v2CapsuleItemId(content: string): string {
  const norm = normalizedContent(content);
  const hi = hash32(norm);
  const lo = fnv1a32Seeded(norm, (hi ^ CAPSULE_HASH2_SALT) >>> 0);
  return `cap:${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
}

/**
 * v3 id — the cryptographic CAS: `cap:` + first 32 hex of SHA-256 over the
 * normalized content (a 128-bit truncation).
 *
 * Why 128 truncated bits: the 50% birthday bound needs ~2^64 ≈ 1.8×10^19
 * DISTINCT items — unreachable for any palace cohort — AND, unlike the FNV
 * family, SHA-256 resists DELIBERATELY CONSTRUCTED collisions, which is the
 * property that matters here: capsules travel an untrusted cross-agent
 * channel where a hostile exporter can grind offline. A 128-bit truncated
 * digest is the CAS industry standard alignment (git's object addresses /
 * Nix's fixed-output derivations use exactly this discipline), and it adds
 * zero new dependencies — node:crypto.
 *
 * Truncating to 128 of SHA-256's 256 bits is standard practice (compare
 * git's plan to move to 128-bit-truncated SHA-256): the truncated digest
 * inherits the full function's collision resistance up to the truncation
 * width. Deterministic and stable across processes by SHA-256's definition.
 */
export function capsuleItemId(content: string): string {
  return (
    'cap:' + createHash('sha256').update(normalizedContent(content), 'utf8').digest('hex').slice(0, 32)
  );
}

/** Project a palace item into a capsule item (owner fields stripped). */
export function toCapsuleItem(item: MemoryItem): CapsuleItem {
  return {
    id: capsuleItemId(item.content),
    layer: item.layer,
    content: item.content,
    importance: item.importance,
    createdAt: item.createdAt,
    // Conditional spread (not `embedding: cond ? … : undefined`): under
    // exactOptionalPropertyTypes an optional field may not be explicitly
    // undefined — and JSON canonicalization dropped that key anyway, so
    // the wire form is byte-identical.
    ...(item.embedding && item.metadata.embeddingSpace
      ? {
          embedding: {
            space: item.metadata.embeddingSpace,
            dim: item.embedding.length,
            b64: Buffer.from(
              item.embedding.buffer,
              item.embedding.byteOffset,
              item.embedding.byteLength,
            ).toString('base64'),
          },
        }
      : {}),
    entities: item.metadata.entities ?? [],
    tags: item.metadata.tags ?? [],
    source: item.metadata.source,
  };
}

/** Rehydrate an embedding from its serialized form (alignment-safe copy). */
export function capsuleEmbedding(item: CapsuleItem): Float32Array | undefined {
  if (!item.embedding) return undefined;
  const buf = Buffer.from(item.embedding.b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

/** Reject absurd capsules before parsing — model-supplied strings are untrusted. */
export const MAX_CAPSULE_JSON_BYTES = 2 * 1024 * 1024;

/**
 * Same-capsule address-collision tripwire (fail-loud forensics).
 *
 * Two items whose ids are EQUAL while their normalized contents DIFFER is
 * the definition of a broken content address: planImport would silently
 * cross-dedupe knowledge that is NOT the same fact. Instead of importing
 * under that lie, throw with the colliding id for forensics. The same id
 * with the same normalized content is the legal duplicate shape and passes.
 *
 * Reachability inside parseCapsule: each item's id was just recomputed from
 * its own content by its generation's algorithm, so two items sharing an
 * id means BOTH contents genuinely digest to it — a same-generation hash
 * collision. For v3 (32 hex) that requires breaking truncated SHA-256;
 * for v1 (8 hex) it is the deliberately-constructible 32-bit FNV
 * collision D-02 originally accepted — exactly the case where fail-loud
 * beats silent wrong dedupe. Exported so tests can drive it directly.
 */
export function assertNoAddressCollisions(items: CapsuleItem[]): void {
  const normById = new Map<string, string>();
  for (const item of items) {
    const norm = normalizedContent(item.content);
    const seen = normById.get(item.id);
    if (seen !== undefined) {
      if (seen !== norm) {
        throw new Error(`[capsule] content-address collision detected: ${item.id}`);
      }
      continue; // same id, same content — legal duplicate shape
    }
    normById.set(item.id, norm);
  }
}

/** Optional parse-time capsule checks (all default off). */
export interface ParseCapsuleOptions {
  /**
   * Freshness bound (ms): when provided, the capsule is rejected unless
   * `exportedAt` is within maxAgeMs of now — anti-replay for stale
   * knowledge that would otherwise land over fresher local facts.
   * Omitted → no freshness check (backwards compatible).
   */
  maxAgeMs?: number;
}

/**
 * The capsule as JSON.parse yields it: every field unvalidated. Typing
 * the parse input as the already-validated MemoryCapsule made the
 * defensive checks below (and their String()/typeof coercions) look
 * "unnecessary" to the type system while the runtime still depends on
 * every one of them — these shapes tell the truth: model- or
 * third-party-authored JSON is untrusted until each check passes.
 */
interface WireCapsuleItem {
  content?: unknown;
  id?: unknown;
  layer?: unknown;
  importance?: unknown;
  tags?: unknown;
  entities?: unknown;
  /** Truthy embedding carrier; b64/dim are validated before any use. */
  embedding?: Record<string, unknown>;
}

interface WireCapsule {
  magic?: unknown;
  version?: unknown;
  palaceId?: unknown;
  exportedAt?: unknown;
  items?: unknown;
  patterns?: unknown;
  signature?: unknown;
  legacyAddressCount?: unknown;
}

export function parseCapsule(json: string, opts?: ParseCapsuleOptions): MemoryCapsule {
  // Real UTF-8 payload size, not UTF-16 code units (`.length` undercounts
  // CJK text ~3x — a "2MB" check on code units admitted ~6MB payloads).
  if (Buffer.byteLength(json, 'utf8') > MAX_CAPSULE_JSON_BYTES) {
    throw new Error(`capsule exceeds ${MAX_CAPSULE_JSON_BYTES} bytes — refusing to parse`);
  }
  const raw = JSON.parse(json) as WireCapsule;
  if (raw.magic !== CAPSULE_MAGIC) throw new Error('not a memory capsule');
  if (raw.version !== CAPSULE_VERSION) throw new Error(`capsule version ${String(raw.version)} unsupported`);
  // Optional freshness gate: fail FAST, before any item processing, when
  // the caller bounded the capsule's age. A malformed exportedAt (missing
  // / non-numeric) cannot prove freshness and is rejected with the same
  // error; a future-dated capsule (clock skew) simply passes.
  // Number() replicates the `-` operator's ToNumber coercion exactly for
  // every JSON-representable value (strings coerce, objects/undefined
  // become NaN), so which malformed shapes throw here is unchanged.
  if (opts?.maxAgeMs !== undefined) {
    const age = Date.now() - Number(raw.exportedAt);
    if (!Number.isFinite(age) || age > opts.maxAgeMs) {
      throw new Error(
        `capsule is stale: age ${Number.isFinite(age) ? `${age} ms` : 'not a finite number (malformed exportedAt?)'} exceeds the maxAgeMs limit of ${opts.maxAgeMs} ms`,
      );
    }
  }
  if (!Array.isArray(raw.items)) throw new Error('capsule has no items array');
  // Array.isArray only proves array-of-any; the loop below validates
  // every field of every element before it is used.
  const items = raw.items as WireCapsuleItem[];
  let legacyAddresses = 0;
  for (const it of items) {
    if (typeof it.content !== 'string' || it.content.length === 0) {
      throw new Error('capsule item missing content');
    }
    // Whitespace-only content is no content: an item whose text is all
    // blanks would import as a permanently empty memory.
    if (!it.content.trim()) {
      throw new Error(`capsule item "${String(it.id)}" has whitespace-only content`);
    }
    // Three-generation content addressing (D-02 terminal state): the id's
    // hex length selects the generation, and each generation verifies
    // against its OWN algorithm — v3 (`cap:` + 32 hex, truncated SHA-256)
    // is what current code mints; v2 (`cap:` + 16 hex, dual-round FNV) and
    // v1 (`cap:` + 8 hex, single-round FNV) stay importable forever so
    // existing capsules never expire. Lengths are disjoint, so this is a
    // pure dispatch, not a precedence rule; any other shape is rejected
    // with all three expected formats named.
    const hex = typeof it.id === 'string' && it.id.startsWith('cap:') ? it.id.slice(4) : '';
    if (!/^[0-9a-f]+$/.test(hex) || (hex.length !== 8 && hex.length !== 16 && hex.length !== 32)) {
      throw new Error(
        'capsule item id format unrecognized: expected cap:<8 hex (v1 legacy)> | ' +
          `cap:<16 hex (v2)> | cap:<32 hex (v3 sha256)>, actual ${String(it.id)}`,
      );
    }
    const expected =
      hex.length === 8
        ? legacyCapsuleItemId(it.content)
        : hex.length === 16
          ? v2CapsuleItemId(it.content)
          : capsuleItemId(it.content);
    if (it.id !== expected) {
      const gen = hex.length === 8 ? 'v1' : hex.length === 16 ? 'v2' : 'v3';
      throw new Error(
        `capsule item id mismatch: id ${String(it.id)} does not recompute for its content ` +
          `as a ${hex.length}-hex ${gen} address (expected ${expected}, tampered content?) — ` +
          'accepted formats: cap:<8 hex (v1 legacy)> | cap:<16 hex (v2)> | cap:<32 hex (v3 sha256)>',
      );
    }
    if (hex.length !== 32) legacyAddresses++; // pre-v3 address (observation only)
    // Layer whitelist: an unknown layer would flow into layer-scoped SQL
    // queries (and stats) as an unqueryable fifth layer.
    if (
      it.layer !== 'episodic' &&
      it.layer !== 'semantic' &&
      it.layer !== 'procedural'
    ) {
      throw new Error(
        `capsule item "${it.id}" has invalid layer ${JSON.stringify(it.layer)} ` +
          '(need episodic|semantic|procedural)',
      );
    }
    // Importance must be a finite number within [0,1]: NaN/Infinity
    // propagate straight through scoring math, and out-of-range values
    // break the importance factor assumptions downstream.
    if (typeof it.importance !== 'number' || !Number.isFinite(it.importance)) {
      throw new Error(
        `capsule item "${it.id}" has non-finite importance ${JSON.stringify(it.importance)}`,
      );
    }
    if (it.importance < 0 || it.importance > 1) {
      throw new Error(
        `capsule item "${it.id}" importance ${it.importance} outside [0,1]`,
      );
    }
    // tags / entities must be string arrays: the importer spreads them
    // into metadata and graph rehydration, where a non-string member
    // would corrupt joins or entity extraction.
    if (it.tags === undefined) {
      it.tags = [];
    } else if (
      !Array.isArray(it.tags) ||
      it.tags.some((t) => typeof t !== 'string')
    ) {
      throw new Error(`capsule item "${it.id}" tags must be a string[]`);
    }
    if (it.entities === undefined) {
      it.entities = [];
    } else if (
      !Array.isArray(it.entities) ||
      it.entities.some((e) => typeof e !== 'string')
    ) {
      throw new Error(`capsule item "${it.id}" entities must be a string[]`);
    }
    if (it.embedding) {
      const { b64, dim } = it.embedding;
      if (typeof b64 !== 'string' || typeof dim !== 'number' || !Number.isInteger(dim) || !(dim > 0)) {
        throw new Error(`capsule item "${it.id}" has malformed embedding (need string b64 + positive integer dim)`);
      }
      // STRICT charset precheck: Buffer.from(..., 'base64') is FORGIVING —
      // it silently drops characters outside the alphabet, so a payload
      // with illegal bytes ('!', whitespace, …) can still decode to the
      // expected byte length and pass the size gate below with corrupted
      // content. Only the standard alphabet plus at most two trailing '='
      // padders, in canonical quad-length form, may proceed to decoding.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new Error(`capsule item "${it.id}" embedding b64 is not valid base64`);
      }
      // A wrong-length buffer here would surface later as a misaligned
      // Float32Array crash deep in ingest — reject at the boundary.
      const byteLength = Buffer.from(b64, 'base64').byteLength;
      const expected = dim * 4;
      if (byteLength % 4 !== 0 || byteLength !== expected) {
        throw new Error(
          `capsule item "${it.id}" embedding size mismatch: expected ${expected} bytes (dim ${dim} x 4), got ${byteLength}`,
        );
      }
    }
  }
  // Every item has passed id/layer/importance/tags/entities/embedding
  // validation above, so from here on the wire shape IS a MemoryCapsule
  // (same object identity — raw — merely re-viewed through the type the
  // checks have proven).
  const capsule = raw as MemoryCapsule;
  // Collision tripwire: every item's id was recomputed from its own
  // content above, so a shared id over DIFFERENT normalized content means
  // a genuine same-generation digest collision (for v3, only if the hash
  // is broken) — fail loud with the colliding id rather than import under
  // a silently wrong dedupe.
  assertNoAddressCollisions(capsule.items);
  // Observation hook for downstream consumers (re-export hint); excluded
  // from the HMAC canonical form, so signing/verifying is unaffected.
  capsule.legacyAddressCount = legacyAddresses;
  // patterns: absent → normalize to [] (harmless omission); present but
  // malformed → reject (a string/object patterns field would explode the
  // importer's pattern loop).
  if (raw.patterns === undefined) {
    raw.patterns = [];
  } else {
    if (!Array.isArray(raw.patterns)) throw new Error('capsule patterns must be an array');
    const entries: unknown[] = raw.patterns;
    for (const p of entries) {
      // Same predicate as before (!p || typeof p !== 'object' || …),
      // expressed without any-typed member access: a non-object entry
      // yields no `pattern` string and is rejected identically.
      const pattern = p && typeof p === 'object' ? (p as Record<string, unknown>).pattern : undefined;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new Error('capsule patterns entries need a non-empty pattern string');
      }
    }
  }
  return capsule;
}

// ----- Import planning ---------------------------------------------------------

export interface ImportConflict {
  capsuleItemId: string;
  capsuleContent: string;
  existingItemId: string;
  existingContent: string;
  reason: string;
}

export interface ImportPlan {
  /** New items to insert (dedup + conflict-free). */
  toInsert: CapsuleItem[];
  /** Items whose exact content already exists in this palace. */
  duplicates: CapsuleItem[];
  /** Similar-but-contradictory items — flagged, imported only on force. */
  conflicts: ImportConflict[];
  /**
   * Items that PASSED the similarity probe (a stored near-neighbor above
   * the threshold was found) and were judged contradictory — imported
   * only on force. The `conflicts` array carries the per-pair details;
   * this bucket carries the items themselves.
   */
  conflictOnly: CapsuleItem[];
  /**
   * OBSERVATIONAL: how many items were skipped as intra-capsule repeats —
   * a later item whose normalized content matched an EARLIER item's
   * (whitespace variants of one fact; ids may differ by generation).
   * Optional for non-breaking compatibility (absent reads as 0);
   * planImport always sets it.
   */
  intraCapsuleDuplicates?: number;
}

/**
 * Plan a capsule import against the receiving palace. `lookupSimilar`
 * returns the most similar stored contents above the given threshold
 * (the federation service implements it via the retriever); `existsByContent`
 * is an exact-content membership check. Every capsule item lands in
 * exactly one bucket — except intra-capsule repeats of an earlier item's
 * normalized content, which land in the `intraCapsuleDuplicates` count
 * instead of vanishing silently.
 */
export function planImport(
  capsule: MemoryCapsule,
  existsByContent: (content: string) => boolean,
  lookupSimilar: (
    content: string,
    threshold: number,
  ) => Array<{ id: string; content: string; similarity: number }>,
  opts: { conflictScanThreshold?: number } = {},
): ImportPlan {
  const conflictThreshold = opts.conflictScanThreshold ?? 0.75;
  const plan: ImportPlan = {
    toInsert: [],
    duplicates: [],
    conflicts: [],
    conflictOnly: [],
    intraCapsuleDuplicates: 0,
  };
  const seen = new Set<string>();

  for (const item of capsule.items) {
    const norm = normalizedContent(item.content);
    if (seen.has(norm)) {
      // Intra-capsule dedupe (same normalized fact — ids may differ by
      // generation): skipped, but COUNTED — a silently vanishing item is
      // unobservable and looks like lost knowledge.
      plan.intraCapsuleDuplicates = (plan.intraCapsuleDuplicates ?? 0) + 1;
      continue;
    }
    seen.add(norm);
    // ONE dedupe rule everywhere: the exists callback receives the same
    // normalized content the intra-capsule set keys on — the service-side
    // store lookup must compare like-for-like, not raw vs normalized.
    if (existsByContent(norm)) {
      plan.duplicates.push(item);
      continue;
    }
    const similar = lookupSimilar(item.content, conflictThreshold);
    let conflicted = false;
    for (const s of similar) {
      const det = detectConflict(
        { id: item.id, content: item.content, score: 1 },
        { id: s.id, content: s.content, score: s.similarity },
      );
      if (det.conflict) {
        conflicted = true;
        plan.conflicts.push({
          capsuleItemId: item.id,
          capsuleContent: item.content,
          existingItemId: s.id,
          existingContent: s.content,
          reason: det.reason ?? 'contradiction',
        });
      }
    }
    if (conflicted) {
      plan.conflictOnly.push(item);
    } else {
      plan.toInsert.push(item);
    }
  }
  return plan;
}

/** Import-time visibility decision: importer chooses the tier; owners bind
 *  to the importer's identity at execution time (never from the capsule). */
export function importVisibility(
  requested: VisibilityTier | undefined,
  defaultTier: VisibilityTier = 'global',
): VisibilityTier {
  return requested ?? defaultTier;
}
