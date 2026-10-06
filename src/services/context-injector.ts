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
import type { CoreMemoryService } from './core-memory.js';
import type { MemoryGraph } from './memory-graph.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryItem, MemoryScopeKind } from '../types/index.js';

export interface InjectionConfig {
  enabled: boolean;
  maxTokens: number;
  systemPromptPrefix: string;
  /** Pre-warm personalized PageRank for the intent's entities (local, free). */
  warmRanks?: boolean;
  /** Fraction of the budget reserved for the core SELF (0 disables). Default 1/3. */
  coreBudgetFraction?: number;
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
    private core?: CoreMemoryService,
  ) {}

  async inject(input: InjectionInput): Promise<InjectionOutput> {
    // A non-positive budget can only produce an empty (or negative-
    // budgeted) injection — bail before any retrieval/store work. The
    // Number.isFinite guard matters because NaN passes `<= 0` yet poisons
    // EVERY downstream comparison (`cost > NaN` is false → nothing is ever
    // budget-checked, and the block grows unbounded before a nonsense
    // truncation). Non-finite budgets are config bugs: emit nothing.
    if (
      !this.cfg.enabled ||
      !Number.isFinite(this.cfg.maxTokens) ||
      this.cfg.maxTokens <= 0
    ) {
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

    // 0. The SELF first: core blocks are tiny, always-on identity — they
    //    get up to a bounded fraction of the budget BEFORE retrieval so a
    //    cold start opens with who the user is, not with what ranked well.
    const coreFraction = this.cfg.coreBudgetFraction ?? 1 / 3;
    let coreBlock = '';
    let coreTokens = 0;
    if (this.core && coreFraction > 0) {
      coreBlock = this.core.formatForPrompt(
        {
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          sessionId: input.sessionId,
        },
        Math.floor(budget * coreFraction),
      );
      coreTokens = coreBlock ? approximateTokenCount(coreBlock) : 0;
    }

    // 1. Retrieval, scoped to the caller
    const retrieval = await this.retriever.retrieve({
      query: input.intent,
      topK: 12,
      layers: ['semantic', 'procedural'],
      scope: {
        sessionId: input.sessionId,
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
      },
    });

    // 2. Procedural patterns (always included if room allows). Patterns are
    //    scoped by the SAME visibility-tier ACL as items: a session only
    //    ever sees patterns visible at its widest cumulative level, so one
    //    user's mined preferences never leak into another's context.
    const level = widestLevel(
      scopeLevels(this.scopeKind, {
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        sessionId: input.sessionId,
      }),
    );
    const patterns = this.store.listPatternsScoped(level).slice(0, 5);
    const patternLines: string[] = [];
    // Shared "extras" budget bucket: the procedural pattern lines AND the
    // graph subgraph block both draw from (and are charged against) this
    // one accumulator — patterns were its first tenant, hence the bucket's
    // budget/4 gate below, but it is not patterns-only.
    let extrasTokens = 0;
    for (const p of patterns) {
      const line = `- ${p.pattern} (confidence ${(p.confidence * 100).toFixed(0)}%): ${p.description}`;
      const cost = approximateTokenCount(line);
      if (extrasTokens + cost > budget / 4) break;
      patternLines.push(line);
      extrasTokens += cost;
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
      // By-id lookup: every scoped store read is by NAME, and the id was
      // itself produced by topRankedEntity over this caller's scoped rank
      // table (the ACL was applied upstream), so no scoped equivalent of
      // getEntity exists to migrate to.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- id-keyed read of an id the scoped ranking itself surfaced
      const ent = this.store.getEntity(leadEntityId);
      if (ent) {
        const desc = this.graph.describeSubgraph(ent.name, 1, 12, level);
        if (desc) {
          const cost = approximateTokenCount(desc);
          // The graph block shares the SAME budget the core SELF already
          // drew from — and lands in the shared extras bucket alongside
          // the pattern lines. Charge coreTokens + extrasTokens here, or a
          // large core block plus a full-size subgraph silently overdraws
          // the injection.
          if (coreTokens + extrasTokens + cost < budget / 2) {
            graphBlock = desc;
            leadEntity = ent.name;
            extrasTokens += cost;
          }
        }
      }
    }

    // 4. Memory context block — gets whatever the core SELF and the
    // shared extras bucket (patterns + graph subgraph) left of the budget.
    const contextBlock = this.retriever.formatAsContext(
      retrieval,
      budget - coreTokens - extrasTokens - 50,
    );
    const finalBlock = [
      coreBlock,
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
      // Report exactly the lines that MADE IT INTO the block — not the
      // full fetched set, which may have been budget-truncated above.
      proceduralPatterns: patternLines,
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
