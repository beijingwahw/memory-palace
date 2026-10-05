/**
 * Visibility-tier scope ACL — the single source of truth for who may see
 * what in the memory palace.
 *
 * Every scoppable row (memory items, entities, graph edges) carries a
 * `visibility` tier plus owner columns:
 *
 *   session    → only the owning session          (session_id = ?)
 *   workspace  → only the owning workspace        (workspace_id = ?)
 *   user       → only the owning user             (user_id = ?)
 *   global     → everyone (shared knowledge base)
 *
 * Retrieval walks a CUMULATIVE cascade: each level ORs in the next wider
 * tier, and never crosses an owner boundary. For an identified caller the
 * widest level is "own tiers + global"; anonymous callers see global
 * only. Tiers whose owner id is absent degrade to the next wider tier
 * (e.g. a session-scoped write without a sessionId lands as workspace /
 * user / global, in that order).
 *
 * This module is pure and table-agnostic: the same tier conditions apply
 * to memory_items, entities and graph_edges, which is what makes the
 * KNOWLEDGE GRAPH itself scope-isolated (a user's entities, edges and
 * PageRank never leak into another user's view).
 */

import type { MemoryScopeKind } from '../types/index.js';

export type VisibilityTier = 'global' | 'user' | 'workspace' | 'session';

/** Narrowest → widest. */
export const TIER_ORDER: readonly VisibilityTier[] = [
  'session',
  'workspace',
  'user',
  'global',
] as const;

export interface ScopeIdentity {
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

/** One cumulative step of the widening cascade. */
export interface ScopeLevelClause {
  /** SQL fragment starting with " AND (...)" — cumulative OR of tiers. */
  sql: string;
  params: unknown[];
  /** 0-based cascade index (0 = narrowest). */
  index: number;
  /** Tiers accumulated at this level, narrowest first. */
  tiers: VisibilityTier[];
  /** The identity the tiers were resolved against (for re-derivation). */
  ids: ScopeIdentity;
}

/** Map a configured scope kind to its home (narrowest) tier. */
export function tierForKind(kind: MemoryScopeKind): VisibilityTier {
  return kind; // 'user' | 'workspace' | 'session' are already tier names
}

/**
 * Degrade a tier when its owner id is missing: session→workspace→user→
 * global (walking TIER_ORDER toward global). Used at WRITE time so a row
 * never carries a tier its owner columns can't back.
 */
export function resolveWriteTier(
  tier: VisibilityTier,
  ids: ScopeIdentity,
): VisibilityTier {
  for (let i = TIER_ORDER.indexOf(tier); i < TIER_ORDER.length; i++) {
    const t = TIER_ORDER[i];
    if (t === 'global') return 'global';
    if (t === 'session' && ids.sessionId) return 'session';
    if (t === 'workspace' && ids.workspaceId) return 'workspace';
    if (t === 'user' && ids.userId) return 'user';
  }
  return 'global';
}

/** SQL condition for ONE tier at the given identity (null = unusable). */
export function buildTierCondition(
  tier: VisibilityTier,
  ids: ScopeIdentity,
): { sql: string; params: unknown[] } | null {
  switch (tier) {
    case 'session':
      return ids.sessionId
        ? { sql: "(visibility = 'session' AND session_id = ?)", params: [ids.sessionId] }
        : null;
    case 'workspace':
      return ids.workspaceId
        ? { sql: "(visibility = 'workspace' AND workspace_id = ?)", params: [ids.workspaceId] }
        : null;
    case 'user':
      return ids.userId
        ? { sql: "(visibility = 'user' AND user_id = ?)", params: [ids.userId] }
        : null;
    case 'global':
      // NULL visibility = legacy pre-ACL rows; they read as global.
      return { sql: "(visibility = 'global' OR visibility IS NULL)", params: [] };
  }
}

/**
 * Build the progressive widening cascade for a retrieval request.
 *
 * Each level is the cumulative OR of every tier from the configured home
 * tier up to that level; levels never widen across owner boundaries and
 * the final level always includes global. Anonymous callers (no ids at
 * all) get a single global-only level.
 */
export function scopeLevels(
  kind: MemoryScopeKind,
  ids: ScopeIdentity,
): ScopeLevelClause[] {
  const home = tierForKind(kind);
  const seq = TIER_ORDER.slice(TIER_ORDER.indexOf(home));
  const levels: ScopeLevelClause[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < seq.length; i++) {
    const conds = seq
      .slice(0, i + 1)
      .map((t) => buildTierCondition(t, ids))
      .filter((c): c is { sql: string; params: unknown[] } => c !== null);
    if (conds.length === 0) continue;
    const inner = conds.map((c) => c.sql).join(' OR ');
    const sql = ` AND (${inner})`;
    if (seen.has(sql)) continue; // identical level after a missing tier
    seen.add(sql);
    levels.push({
      sql,
      params: conds.flatMap((c) => c.params),
      index: levels.length,
      tiers: seq.slice(0, i + 1),
      ids,
    });
  }

  if (levels.length === 0) {
    const g = buildTierCondition('global', ids)!;
    levels.push({
      sql: ` AND (${g.sql})`,
      params: [],
      index: 0,
      tiers: ['global'],
      ids,
    });
  }
  return levels;
}

/** The widest cumulative level (what "scoped graph analytics" run over). */
export function widestLevel(levels: ScopeLevelClause[]): ScopeLevelClause {
  return levels[levels.length - 1];
}

/**
 * Standalone WHERE body (no leading AND) for a cumulative tier set —
 * used by scoped queries over entities / graph_edges, whose tier
 * columns mirror memory_items'.
 */
export function tierDisjunction(
  tiers: readonly VisibilityTier[],
  ids: ScopeIdentity,
): { sql: string; params: unknown[] } | null {
  const conds = tiers
    .map((t) => buildTierCondition(t, ids))
    .filter((c): c is { sql: string; params: unknown[] } => c !== null);
  if (conds.length === 0) return null;
  return {
    sql: conds.map((c) => c.sql).join(' OR '),
    params: conds.flatMap((c) => c.params),
  };
}

/**
 * JS-side mirror of the tier ACL for rows already materialized in memory
 * (e.g. entity-hop candidates fetched by id): does `row` belong to one of
 * the level's cumulative tiers? Legacy NULL visibility reads as global.
 */
export function visibleAtLevel(
  row: {
    visibility?: VisibilityTier | null;
    userId?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
  },
  level: ScopeLevelClause,
): boolean {
  const tier = row.visibility ?? 'global';
  for (const t of level.tiers) {
    if (t === 'global' && tier === 'global') return true;
    if (t === 'user' && tier === 'user' && level.ids.userId && row.userId === level.ids.userId) {
      return true;
    }
    if (
      t === 'workspace' &&
      tier === 'workspace' &&
      level.ids.workspaceId &&
      row.workspaceId === level.ids.workspaceId
    ) {
      return true;
    }
    if (
      t === 'session' &&
      tier === 'session' &&
      level.ids.sessionId &&
      row.sessionId === level.ids.sessionId
    ) {
      return true;
    }
  }
  return false;
}
