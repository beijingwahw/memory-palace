/**
 * ContextInjector — runs at session.start and other hooks to assemble
 * the right memory context for the LLM.
 *
 *   1. Pull top-K hits for the user's latest intent / opening message
 *      (scope-filtered: the session's user/workspace see their own memory)
 *   2. Pull high-importance procedural patterns
 *   3. Expand a small subgraph around the LEAD ENTITY of the retrieved
 *      hits — picked by PageRank centrality among the entities actually
 *      linked to those hits (the old implementation used metadata tags,
 *      which are not graph nodes, so the subgraph was always empty)
 *   4. Format within maxTokens budget and append a Tool-Contract hint so the
 *      model knows the memory_retrieve tool is available
 */

import { approximateTokenCount, truncateToTokens } from '../utils/tokenizer.js';
import { scopeLevels, widestLevel } from '../utils/scope.js';
import type { MemoryRetriever } from './memory-retriever.js';
import type { MemoryGraph } from './memory-graph.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryItem, MemoryScopeKind } from '../types/index.js';

export interface InjectionConfig {
  enabled: boolean;
  maxTokens: number;
  systemPromptPrefix: string;
  /** Pre-warm personalized PageRank for the intent's entities (local, free). */
  warmRanks?: boolean;
}

export interface InjectionInput {
  sessionId: string;
  /** The user's opening message / current intent — drives retrieval */
  intent: string;
  workspaceId?: string;
  userId?: string;
}

export interface InjectionOutput {
  systemPromptAddition: string;
  contextBlock: string;
  retrievedItemIds: string[];
  proceduralPatterns: string[];
  /** Name of the entity whose subgraph was expanded, if any. */
  leadEntity: string | null;
  budgetUsed: number;
}

export class ContextInjector {
  constructor(
    private retriever: MemoryRetriever,
    private graph: MemoryGraph,
    private store: MemoryStore,
    private cfg: InjectionConfig,
    private scopeKind: MemoryScopeKind = 'user',
  ) {}

  async inject(input: InjectionInput): Promise<InjectionOutput> {
    if (!this.cfg.enabled) {
      return {
        systemPromptAddition: '',
        contextBlock: '',
        retrievedItemIds: [],
        proceduralPatterns: [],
        leadEntity: null,
        budgetUsed: 0,
      };
    }

    const budget = this.cfg.maxTokens;

    // 1. Retrieval, scoped to the caller
    const retrieval = await this.retriever.retrieve({
      query: input.intent,
      topK: 12,
      layers: ['semantic', 'procedural'],
      scope: {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
    });

    // 2. Procedural patterns (always included if room allows). Patterns are
    //    scoped by the SAME visibility-tier ACL as items: a session only
    //    ever sees patterns visible at its widest cumulative level, so one
    //    user's mined preferences never leak into another's context.
    const level = widestLevel(
      scopeLevels(this.scopeKind, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      }),
    );
    const patterns = this.store.listPatternsScoped(level).slice(0, 5);
    const patternLines: string[] = [];
    let patternTokens = 0;
    for (const p of patterns) {
      const line = `- ${p.pattern} (confidence ${(p.confidence * 100).toFixed(0)}%): ${p.description}`;
      const cost = approximateTokenCount(line);
      if (patternTokens + cost > budget / 4) break;
      patternLines.push(line);
      patternTokens += cost;
    }

    // 3. Subgraph around the PageRank-leading entity of the retrieved
    //    hits, ranked on the caller's scoped graph. Entity ids come from
    //    ingest-time linkage, so the subgraph is guaranteed relevant.
    //    (`level` was already derived above for the pattern read — the
    //    widest cumulative scope is the same for the whole injection.)
    //
    //    Warm-up: pre-compute the personalized PageRank seeded by the
    //    intent's linked entities — pure local graph math, zero API cost —
    //    so the first memory_retrieve of the session starts from a hot
    //    cache instead of a cold O(iterations×edges) walk.
    if (this.cfg.warmRanks !== false) {
      try {
        const seeds = uniqueEntityIds(retrieval.hits.map((h) => h.item));
        if (seeds.length > 0) this.graph.getPersonalizedRanks(seeds, level);
      } catch {
        // warm-up is best-effort; never block injection on it
      }
    }
    let graphBlock = '';
    let leadEntity: string | null = null;
    const leadEntityId = this.graph.topRankedEntity(
      uniqueEntityIds(retrieval.hits.map((h) => h.item)),
      level,
    );
    if (leadEntityId) {
      const ent = this.store.getEntity(leadEntityId);
      if (ent) {
        const desc = this.graph.describeSubgraph(ent.name, 1, 12, level);
        if (desc) {
          const cost = approximateTokenCount(desc);
          if (patternTokens + cost < budget / 2) {
            graphBlock = desc;
            leadEntity = ent.name;
            patternTokens += cost;
          }
        }
      }
    }

    // 4. Memory context block
    const contextBlock = this.retriever.formatAsContext(
      retrieval,
      budget - patternTokens - 50,
    );
    const finalBlock = [
      graphBlock,
      patternLines.join('\n'),
      contextBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    const truncated = truncateToTokens(finalBlock, budget);
    const promptAddition =
      this.cfg.systemPromptPrefix +
      (truncated ? '\n\nKnown long-term context for this user:\n' + truncated : '');

    return {
      systemPromptAddition: promptAddition,
      contextBlock: truncated,
      retrievedItemIds: retrieval.hits.map((h) => h.item.id),
      proceduralPatterns: patterns.map((p) => p.pattern),
      leadEntity,
      budgetUsed: approximateTokenCount(promptAddition),
    };
  }
}

/** Deduped entity ids linked to a set of items. */
function uniqueEntityIds(items: MemoryItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.entityId) ids.add(item.entityId);
  }
  return [...ids];
}
