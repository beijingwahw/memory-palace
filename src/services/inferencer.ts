/**
 * Inferencer — materializes derived knowledge during the sleep cycle.
 *
 * Reads the caller's scoped graph, composes novel multi-hop chains over
 * typed relations (utils/inference.ts), and writes:
 *
 *   - inferred edges (`inf:reaches`, weight = chain confidence) so PPR
 *     proximity flows through derived structure too;
 *   - derived memory items ("Inferred (78%): Aurora —depends-on→ Kafka
 *     —deployed-on→ Kubernetes", source 'inferred', lineage in metadata)
 *     retrievable like any fact — but always branded as derived. Derived
 *     items are ingested with skipGraph: their template prose must never
 *     mint entities or bump mention counts in the caller's graph.
 *
 * Idempotence: an inferred edge whose (from,to) already exists is only
 * refreshed when the new chain is STRONGER (store.upsertEdgeIfStronger),
 * so nights never inflate confidence; derived items dedupe by their
 * deterministic CONFIDENCE-FREE statement, so drifting confidence does
 * not accumulate near-duplicate facts.
 *
 * Inference never consumes its own output: `inf:*` edges are filtered
 * out of the composer's input, preventing derived structure from
 * reinforcing itself night after night.
 */

import { chainStatement, composeChains, type ChainEdge } from '../utils/inference.js';
import {
  resolveWriteTier,
  scopeLevels,
  tierForKind,
  widestLevel,
  type ScopeLevelClause,
} from '../utils/scope.js';
import type { MemoryEventBus, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryIngestor } from './memory-ingestor.js';

export interface InferenceReport {
  /** Chains considered novel after composition. */
  chains: number;
  /** New/refreshed inferred edges written. */
  edgesWritten: number;
  /** New derived memory items stored. */
  itemsWritten: number;
  /** Strongest chain statement (for the dream report). */
  strongest?: string;
}

const MAX_DERIVED_ITEMS_PER_NIGHT = 5;

export class Inferencer {
  constructor(
    private store: MemoryStore,
    private ingestor: MemoryIngestor,
    private scopeKind: MemoryScopeKind = 'user',
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  private levelFor(scope: { userId?: string; workspaceId?: string; sessionId?: string }): ScopeLevelClause {
    return widestLevel(scopeLevels(this.scopeKind, scope));
  }

  /**
   * One inference pass for a scope. All writes go through the ingestor's
   * transactional two-phase path (embed → single tx) so a night's
   * derivations commit atomically with their embeddings.
   */
  async infer(scope: {
    userId?: string;
    workspaceId?: string;
    sessionId?: string;
  }): Promise<InferenceReport> {
    const level = this.levelFor(scope);
    const entities = this.store.listEntitiesScoped(level, 1000);
    if (entities.length < 2) {
      return { chains: 0, edgesWritten: 0, itemsWritten: 0 };
    }
    const nameById = new Map(entities.map((e) => [e.id, e.name]));
    const idByName = new Map(entities.map((e) => [e.name, e.id]));

    // Resolve endpoint NAMES once, keeping only edges whose endpoints are
    // both in this scope's entity set (nameById.has was checked up front by
    // construction, so the resolved names can never be undefined here).
    const scopedEdges = this.store.listEdgesScoped(level).flatMap((e) => {
      const from = nameById.get(e.from);
      const to = nameById.get(e.to);
      if (from === undefined || to === undefined) return [];
      return [{ edge: e, from, to }];
    });
    const existingInferred = new Set(
      scopedEdges
        .filter((s) => s.edge.relation === 'inf:reaches')
        .map((s) => `${s.from}→${s.to}`),
    );
    // Inference must not consume inferred edges: feeding inf:* structure
    // back into the composer would let derived beliefs reinforce
    // themselves (and their weights) night after night.
    const edges: ChainEdge[] = scopedEdges
      .filter((s) => !s.edge.relation.startsWith('inf:'))
      .map((s) => ({
        from: s.from,
        to: s.to,
        relation: s.edge.relation,
        weight: s.edge.weight,
      }));
    if (edges.length === 0) {
      return { chains: 0, edgesWritten: 0, itemsWritten: 0 };
    }

    const chains = composeChains(edges, { maxDepth: 3, maxChains: 20, minConfidence: 0.3 });
    if (chains.length === 0) {
      return { chains: 0, edgesWritten: 0, itemsWritten: 0 };
    }

    // Writes land at the tier of the caller's STABLE identity (userId /
    // workspaceId) — NOT the ephemeral session that happened to trigger
    // the night. Derived knowledge is composed from the whole scoped
    // graph and belongs to the owner, so it must stay visible to every
    // later session: resolving with scope.sessionId stamped derived rows
    // and edges at 'session' tier, invisible to any reader that issues
    // its query WITHOUT that exact session id (e.g. a plain user-scoped
    // memory_retrieve). resolveWriteTier still degrades the configured
    // home tier to one the stable ids can actually back (a workspace
    // scope with no userId writes at 'workspace', not 'user'-with-NULL).
    const writeTier = resolveWriteTier(tierForKind(this.scopeKind), {
      ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
    });
    const edgeScope = {
      visibility: writeTier,
      ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
    };

    let edgesWritten = 0;
    for (const chain of chains) {
      const first = chain.path[0];
      const last = chain.path[chain.path.length - 1];
      // A composed chain always carries at least its two endpoints; the
      // undefined arms below only exist to satisfy index typing.
      if (first === undefined || last === undefined) continue;
      const fromId = idByName.get(first);
      const toId = idByName.get(last);
      if (!fromId || !toId || fromId === toId) continue;
      // ALWAYS write through upsertEdgeIfStronger: its MAX(old, new)
      // conflict semantics make the call idempotent — a re-derived chain
      // refreshes the edge only when strictly stronger. The previous
      // `existingInferred.has(key) → continue` guard made that
      // "stronger-only refresh" branch unreachable after the first night
      // (every later pass saw the pair as already-derived and skipped),
      // so rising confidence never actually reached the stored edge.
      this.store.upsertEdgeIfStronger(
        fromId,
        toId,
        'inf:reaches',
        Number(chain.confidence.toFixed(2)),
        edgeScope,
      );
      edgesWritten++;
    }

    // Derived items: dedupe by the CONFIDENCE-FREE statement (stable as
    // confidence drifts across nights), store the confidence-branded
    // version for display. Per-night cap keeps the dream bounded.
    let itemsWritten = 0;
    for (const chain of chains.slice(0, MAX_DERIVED_ITEMS_PER_NIGHT)) {
      const dedupeKey = chainStatement(chain, { withConfidence: false });
      const pairKey = `${chain.path[0]}→${chain.path[chain.path.length - 1]}`;
      // Cheap in-memory pre-check (the existingInferred set's only
      // remaining job): an endpoint pair that already carries an
      // inf:reaches edge from an earlier night needs no second derived
      // item, regardless of path confidence drift.
      if (existingInferred.has(pairKey)) continue;
      // Containment, not equality: stored rows carry the "Inferred (NN%): "
      // branding, so an exact match against the bare statement would never
      // hit and near-duplicates would pile up night after night. The scan
      // is now LEVEL-SCOPED (this pass's widest cumulative level): another
      // tenant's same-statement row no longer suppresses our derivation,
      // and tombstoned rows no longer blind the probe.
      //
      // Cost note (declared acceptable): this lookup is a full-table LIKE
      // scan over memory_items. It runs at most MAX_DERIVED_ITEMS_PER_NIGHT
      // (= 5) times per nightly pass, on a maintenance path — bounded and
      // rare enough to keep. The needle is passed as a BOUND PARAMETER; the
      // store itself escapes %/_/\, and no SQL is assembled on this side.
      if (this.store.findItemIdsByContentContaining(dedupeKey, 5, level).length > 0) continue;
      await this.ingestor.ingestUserMemory({
        content: chainStatement(chain),
        tags: ['inferred'],
        // skipGraph: the statement restates entity names as BRAND WORDS
        // inside a template ("Inferred (78%): Aurora —depends-on→ …") —
        // ingesting it would mint an "Inferred" entity and re-stamp
        // mention counts for entities the user never mentioned in this
        // sentence, night after night.
        skipGraph: true,
        source: 'inferred',
        importance: Math.min(0.85, 0.4 + chain.confidence * 0.4),
        // Stable-identity write (see writeTier above): sessionId is
        // deliberately NOT forwarded — ingestUserMemory re-tightens the
        // tier to 'session' when it sees one, and a session-scoped
        // derived fact is invisible to every other session of the user.
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        visibility: writeTier,
      });
      itemsWritten++;
    }

    this.bus.emit('memory.inferred', {
      chains: chains.length,
      edges: edgesWritten,
      items: itemsWritten,
      strongest: chains[0] ? chainStatement(chains[0]) : undefined,
    });
    const strongest = chains[0] !== undefined ? chainStatement(chains[0]) : undefined;
    return {
      chains: chains.length,
      edgesWritten,
      itemsWritten,
      ...(strongest !== undefined ? { strongest } : {}),
    };
  }
}
