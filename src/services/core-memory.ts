/**
 * CoreMemoryService — the palace's persistent SELF.
 *
 * Three maintained blocks (profile / project / goals), each a tiny
 * line-oriented note hard-capped in tokens. Unlike archival memory, core
 * blocks are REWRITTEN: the agent edits them through the memory_core tool
 * (MemGPT-style self-editing), and the sleep cycle compacts them against
 * the current entity salience. Every rewrite is versioned into an audit
 * history so no version of the self is ever silently lost.
 *
 * Blocks live behind the same visibility-tier ACL as everything else:
 * one user's self never leaks into another's injection.
 */

import { randomUUID } from 'node:crypto';
import {
  compactBlock,
  mergeIntoBlock,
  type CompactResult,
} from '../utils/core-memory.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import type { MemoryEventBus, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';
import { invariant } from '../utils/invariants.js';
import { resolveWriteTier, scopeLevels, widestLevel, type ScopeLevelClause } from '../utils/scope.js';

export type CoreBlockName = 'profile' | 'project' | 'goals';

export const CORE_BLOCK_NAMES: readonly CoreBlockName[] = ['profile', 'project', 'goals'];
export const DEFAULT_BLOCK_CAP = 220;

export interface CoreBlock {
  id: string;
  name: CoreBlockName;
  content: string;
  tokenCap: number;
  version: number;
  updatedAt: number;
}

export interface CoreHistoryEntry {
  blockId: string;
  version: number;
  content: string;
  updatedAt: number;
}

export interface CoreWriteResult {
  block: CoreBlock;
  compaction?: CompactResult;
}

export class CoreMemoryService {
  constructor(
    private store: MemoryStore,
    private graph: MemoryGraph,
    private scopeKind: MemoryScopeKind = 'user',
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  private levelFor(scope: { userId?: string; workspaceId?: string; sessionId?: string }): ScopeLevelClause {
    return widestLevel(scopeLevels(this.scopeKind, scope));
  }

  /**
   * Blocks visible to the caller, deduplicated per NAME with the
   * NARROWEST-tier occurrence winning.
   *
   * The store's scoped block query answers at one cumulative level, so a
   * caller who owns a user-tier 'profile' next to an anonymous
   * predecessor's global 'profile' gets BOTH rows back — same name,
   * different owners. Walking the scope cascade narrow → wide and keeping
   * the FIRST occurrence per name resolves the ambiguity the way the ACL
   * intends: your own layer shadows the shared global layer. (Within one
   * cumulative level a same-name pair at two tiers remains possible in
   * exotic cascades; the narrow-first walk already resolved every tier
   * that has its own level, so the residual case cannot flip ownership.)
   */
  read(scope: { userId?: string; workspaceId?: string; sessionId?: string }): CoreBlock[] {
    const levels = scopeLevels(this.scopeKind, scope);
    const out = new Map<string, CoreBlock>();
    const seenIds = new Set<string>();
    for (const lvl of levels) {
      // narrow → wide: first sighting of a name is its narrowest tier
      for (const b of this.store.listCoreBlocks(lvl)) {
        if (seenIds.has(b.id)) continue;
        seenIds.add(b.id);
        if (!out.has(b.name)) out.set(b.name, b);
      }
    }
    return [...out.values()];
  }

  readBlock(
    name: CoreBlockName,
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
  ): CoreBlock | null {
    const blocks = this.read(scope);
    return blocks.find((b) => b.name === name) ?? null;
  }

  /**
   * The caller's OWN-layer block of the given name: whatever lives at the
   * NARROWEST cascade level — the caller's home tier (for an anonymous
   * caller, the global-only fallback, which IS their degraded home tier).
   *
   * set/append target exactly this block and NEVER a same-named block at a
   * wider tier: user A's self-edit must not rewrite the global block some
   * anonymous predecessor created (that block is shared infrastructure —
   * A's palace-mates read it too). When no own-layer block exists, the
   * caller gets a freshly minted one at their own write tier.
   */
  private ownLayerBlock(
    name: CoreBlockName,
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
  ): CoreBlock | null {
    const levels = scopeLevels(this.scopeKind, scope);
    // scopeLevels guarantees at least one level (global-only fallback).
    const narrowest = levels[0];
    invariant(narrowest !== undefined, 'scopeLevels always returns at least the global-only fallback level');
    return this.store.listCoreBlocks(narrowest).find((b) => b.name === name) ?? null;
  }

  /** Replace a block outright (agent self-edit). Versioned + audited. */
  set(
    name: CoreBlockName,
    content: string,
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
    tokenCap?: number,
  ): CoreWriteResult {
    // Own-layer target only: a same-named global/shared block is never
    // the rewrite target — absence mints a new own-tier block below.
    const existing = this.ownLayerBlock(name, scope);
    const cap = tokenCap ?? existing?.tokenCap ?? DEFAULT_BLOCK_CAP;
    // A set() is an intentional rewrite — compact to honor the cap but
    // keep the author's ordering semantics (dedupe + evict only).
    const result = compactBlock(content, { maxTokens: cap, hotEntities: this.hotEntities(scope) });
    const block = this.store.upsertCoreBlock(
      {
        id: existing?.id ?? randomUUID(),
        name,
        content: result.content,
        tokenCap: cap,
        version: (existing?.version ?? 0) + 1,
        updatedAt: Date.now(),
      },
      { visibility: resolveWriteTier(this.scopeKind, scope), ...scope },
    );
    this.bus.emit('memory.core-updated', { block: name, version: block.version, via: 'set' });
    return { block, compaction: result };
  }

  /** Append lines (merged, deduped, capped). Additions win score ties. */
  append(
    name: CoreBlockName,
    additions: string[],
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
    tokenCap?: number,
  ): CoreWriteResult {
    // Own-layer target only — same rule as set(): never merge into a
    // same-named shared block owned by a wider (e.g. anonymous global) tier.
    const existing = this.ownLayerBlock(name, scope);
    const cap = tokenCap ?? existing?.tokenCap ?? DEFAULT_BLOCK_CAP;
    const result = mergeIntoBlock(existing?.content ?? '', additions, {
      maxTokens: cap,
      hotEntities: this.hotEntities(scope),
    });
    const block = this.store.upsertCoreBlock(
      {
        id: existing?.id ?? randomUUID(),
        name,
        content: result.content,
        tokenCap: cap,
        version: (existing?.version ?? 0) + 1,
        updatedAt: Date.now(),
      },
      { visibility: resolveWriteTier(this.scopeKind, scope), ...scope },
    );
    this.bus.emit('memory.core-updated', { block: name, version: block.version, via: 'append' });
    return { block, compaction: result };
  }

  /**
   * Sleep-time maintenance: re-compact every visible block against the
   * CURRENT entity salience (hot concepts shift; stale lines age out).
   * Version bumps only when compaction actually changed the content.
   */
  compactAll(scope: { userId?: string; workspaceId?: string; sessionId?: string }): Array<{
    name: CoreBlockName;
    version: number;
    compaction: CompactResult;
    changed: boolean;
  }> {
    const hot = this.hotEntities(scope);
    const out: Array<{ name: CoreBlockName; version: number; compaction: CompactResult; changed: boolean }> = [];
    for (const block of this.read(scope)) {
      const result = compactBlock(block.content, {
        maxTokens: block.tokenCap,
        hotEntities: hot,
      });
      const changed = result.content !== block.content;
      if (!changed) {
        out.push({ name: block.name, version: block.version, compaction: result, changed: false });
        continue;
      }
      const updated = this.store.upsertCoreBlock(
        {
          id: block.id,
          name: block.name,
          content: result.content,
          tokenCap: block.tokenCap,
          version: block.version + 1,
          updatedAt: Date.now(),
        },
        { visibility: resolveWriteTier(this.scopeKind, scope), ...scope },
      );
      this.bus.emit('memory.core-updated', { block: block.name, version: updated.version, via: 'sleep' });
      out.push({ name: block.name, version: updated.version, compaction: result, changed: true });
    }
    return out;
  }

  history(
    name: CoreBlockName,
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
    limit = 10,
  ): CoreHistoryEntry[] {
    const block = this.readBlock(name, scope);
    if (!block) return [];
    return this.store.listCoreHistory(block.id, limit);
  }

  /** Format the whole core for prompt injection (bounded). */
  formatForPrompt(
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
    maxTokens: number,
  ): string {
    const blocks = this.read(scope);
    const lines: string[] = [];
    let used = 0;
    for (const name of CORE_BLOCK_NAMES) {
      const b = blocks.find((x) => x.name === name);
      if (!b || !b.content) continue;
      const header = `[${name}]`;
      // The inter-block separator is part of what the model actually sees,
      // so it is charged to the budget too (≈1 token for '\n\n').
      const sepCost = lines.length > 0 ? approximateTokenCount('\n\n') : 0;
      const cost =
        sepCost + approximateTokenCount(header) + approximateTokenCount(b.content);
      // SKIP, don't abort: an oversized block yields its slot to the NEXT
      // block instead of terminating the whole injection — a bloated
      // profile must not push project/goals out entirely. Priority order
      // (profile → project → goals) is still honored among blocks that fit.
      if (used + cost > maxTokens) continue;
      lines.push(header + '\n' + b.content);
      used += cost;
    }
    return lines.join('\n\n');
  }

  /**
   * Currently hot entity names (top PageRank, normalized), for scoring.
   * One scoped entity listing builds the id→name map for every rank hit —
   * no per-id getEntity round-trips (the old N+1 walked the store once per
   * ranked entity on EVERY compaction).
   */
  private hotEntities(scope: { userId?: string; workspaceId?: string; sessionId?: string }): Set<string> {
    const level = this.levelFor(scope);
    const ranks = this.graph.getNormalizedRanks(level);
    const nameById = new Map(
      this.store.listEntitiesScoped(level).map((e) => [e.id, e.name] as const),
    );
    const top: Array<{ name: string; rank: number }> = [];
    for (const [id, rank] of ranks) {
      const name = nameById.get(id);
      if (name) top.push({ name, rank });
    }
    top.sort((a, b) => b.rank - a.rank);
    return new Set(top.slice(0, 25).map((t) => t.name.toLowerCase()));
  }
}
