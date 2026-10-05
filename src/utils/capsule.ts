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
 *   - DETERMINISTIC CONTENT IDS: every item's id is `cap:<fnv1a-32 of the
 *     normalized content>`, so the same fact exported from two palaces
 *     yields the same id and imports dedupe by construction, not by
 *     trusting the exporter.
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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { hash32 } from './embedding.js';
import { detectConflict } from './consensus.js';
import type { MemoryItem, MemoryLayer, MemoryMetadata } from '../types/index.js';
import type { VisibilityTier } from './scope.js';

export const CAPSULE_MAGIC = 'dsh-memory-capsule';
export const CAPSULE_VERSION = 1;

export interface CapsuleItem {
  /** Deterministic content id: `cap:<hash>` — same fact, same id, anywhere. */
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
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function signCapsule(capsule: MemoryCapsule, secret: string): MemoryCapsule {
  const unsigned: MemoryCapsule = { ...capsule, signature: undefined };
  const sig = createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('hex');
  return { ...unsigned, signature: sig };
}

/** True when the signature matches (unsigned capsules are rejected). */
export function verifyCapsule(capsule: MemoryCapsule, secret: string): boolean {
  if (!capsule.signature) return false;
  const expected = createHmac('sha256', secret)
    .update(canonicalJson({ ...capsule, signature: undefined }))
    .digest('hex');
  const a = Buffer.from(capsule.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ----- Build & parse ----------------------------------------------------------

/** Normalize content for content-addressing: collapse whitespace. */
export function normalizedContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

/** Deterministic capsule item id from content. */
export function capsuleItemId(content: string): string {
  return `cap:${hash32(normalizedContent(content)).toString(16).padStart(8, '0')}`;
}

/** Project a palace item into a capsule item (owner fields stripped). */
export function toCapsuleItem(item: MemoryItem): CapsuleItem {
  return {
    id: capsuleItemId(item.content),
    layer: item.layer,
    content: item.content,
    importance: item.importance,
    createdAt: item.createdAt,
    embedding:
      item.embedding && item.metadata.embeddingSpace
        ? {
            space: item.metadata.embeddingSpace,
            dim: item.embedding.length,
            b64: Buffer.from(
              item.embedding.buffer,
              item.embedding.byteOffset,
              item.embedding.byteLength,
            ).toString('base64'),
          }
        : undefined,
    entities: item.metadata.entities ?? [],
    tags: item.metadata.tags ?? [],
    source: item.metadata.source,
  };
}

/** Rehydrate an embedding from its serialized form (alignment-safe copy). */
export function capsuleEmbedding(item: CapsuleItem): Float32Array | undefined {
  if (!item.embedding) return undefined;
  const buf = Buffer.from(item.embedding.b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Float32Array(ab);
}

export function parseCapsule(json: string): MemoryCapsule {
  const raw = JSON.parse(json) as MemoryCapsule;
  if (raw.magic !== CAPSULE_MAGIC) throw new Error('not a memory capsule');
  if (raw.version !== CAPSULE_VERSION) throw new Error(`capsule version ${raw.version} unsupported`);
  if (!Array.isArray(raw.items)) throw new Error('capsule has no items array');
  for (const it of raw.items) {
    if (typeof it.content !== 'string' || it.content.length === 0) {
      throw new Error('capsule item missing content');
    }
    if (it.id !== capsuleItemId(it.content)) {
      throw new Error(`capsule item id mismatch (tampered content?)`);
    }
  }
  return raw;
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
  /** Items that FAILED the similarity check but conflict with stored facts. */
  conflictOnly: CapsuleItem[];
}

/**
 * Plan a capsule import against the receiving palace. `lookupSimilar`
 * returns the most similar stored contents above the given threshold
 * (the federation service implements it via the retriever); `existsByContent`
 * is an exact-content membership check. Every capsule item lands in
 * exactly one bucket.
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
  };
  const seen = new Set<string>();

  for (const item of capsule.items) {
    const norm = normalizedContent(item.content);
    if (seen.has(norm)) continue; // intra-capsule dedupe (same id anyway)
    seen.add(norm);
    if (existsByContent(item.content)) {
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
