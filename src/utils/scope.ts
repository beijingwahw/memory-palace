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
 * only.
 *
 * WRITE resolution is privacy-first ("narrower is safer"): a requested
 * tier first collapses to the NARROWEST tier at or below it whose owner
 * id is actually present (requesting 'user' with only a sessionId lands
 * as 'session', not global), and only when no tier in that range is
 * backed by an id does it degrade toward global. The cascade start
 * follows the same rule, so a 'user'-kind caller holding a sessionId
 * reads through a session→…→global cascade instead of skipping its own
 * session rows.
 *
 * This module is pure and table-agnostic: the same tier conditions apply
 * to memory_items, entities and graph_edges, which is what makes the
 * KNOWLEDGE GRAPH itself scope-isolated (a user's entities, edges and
 * PageRank never leak into another user's view).
 *
 * ANONYMOUS WRITES (no owner id at all) are governed by an explicit
 * tri-state policy — applyAnonymousWritePolicy below — applied at the
 * ingestor / session.end boundaries BEFORE resolveWriteTier sees the
 * identity. The default 'global' reproduces the historical behavior
 * exactly.
 */

import type { AnonymousWritePolicy, MemoryScopeKind } from '../types/index.js';
import type { VisibilityTier } from '../types/index.js';
import { invariant } from './invariants.js';

// Re-export for historical import paths; the definition lives in types.
export type { VisibilityTier };
// Re-export so scope.ts stays the import surface for everything ACL —
// the union itself is declared in types (utils imports types, never the
// reverse).
export type { AnonymousWritePolicy };

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
 * Resolve the tier a WRITE actually lands on — privacy-first
 * ("narrower is safer"), in two phases:
 *
 *   1. Within [session … requested], pick the NARROWEST tier whose owner
 *      id is present. Requesting 'user' with only a sessionId lands as
 *      'session' — the memory stays as private as the identity allows,
 *      never wider than the request (no tier ABOVE the request is ever
 *      chosen in this phase).
 *   2. If no tier at or below the request is backed by an id, degrade
 *      toward global as before: requested → … → global, first tier with
 *      an id wins, global always usable.
 *
 * A row therefore never carries a tier its owner columns can't back, and
 * an over-wide request never widens past what the caller could have read.
 */
export function resolveWriteTier(
  tier: VisibilityTier,
  ids: ScopeIdentity,
): VisibilityTier {
  const requested = TIER_ORDER.indexOf(tier);
  if (requested < 0) return 'global';
  // Phase 1 — narrower is safer: narrowest owned tier at or below the ask.
  for (const t of TIER_ORDER.slice(0, requested + 1)) {
    if (t === 'session' && ids.sessionId) return 'session';
    if (t === 'workspace' && ids.workspaceId) return 'workspace';
    if (t === 'user' && ids.userId) return 'user';
  }
  // Phase 2 — nobody narrower-or-equal is owned: degrade toward global.
  for (const t of TIER_ORDER.slice(requested + 1, TIER_ORDER.length - 1)) {
    if (t === 'session' && ids.sessionId) return 'session';
    if (t === 'workspace' && ids.workspaceId) return 'workspace';
    if (t === 'user' && ids.userId) return 'user';
  }
  return 'global';
}

/**
 * Synthetic session id naming the QUARANTINE bucket: the single well-known
 * session under which policy-'quarantine' anonymous writes are isolated.
 * Rows land at visibility='session' with session_id = this constant, so
 * they are readable ONLY by callers presenting exactly this id — never by
 * an identified user (their cascade never includes a foreign session id).
 */
export const ANONYMOUS_SESSION_ID = '__anonymous__';

/** Exact message thrown by policy 'reject' (matched by boundary catchers). */
export const ANONYMOUS_REJECT_MESSAGE =
  '[scope] anonymous write rejected by policy';

/**
 * Apply the ANONYMOUS-WRITE POLICY to a write identity — the explicit
 * tri-state successor to what used to be an implicit fail-open.
 *
 * A write is ANONYMOUS when NONE of the three owner ids (userId /
 * workspaceId / sessionId) is present. Historically such writes silently
 * degraded through resolveWriteTier to the GLOBAL tier: any host that
 * simply forgot to stamp identity on its events was quietly publishing
 * into the shared knowledge base everyone reads. The policy makes that
 * outcome a CHOICE:
 *
 *   'global'     — legacy behavior, byte-for-byte: the identity is
 *                  returned unchanged and the write lands in the global
 *                  shared bucket (default; zero migration for existing
 *                  installs).
 *   'quarantine' — the identity is rewritten to
 *                  { sessionId: '__anonymous__' }; combined with
 *                  resolveWriteTier's narrowest-owned-tier rule the row
 *                  lands at visibility='session' in an isolation bucket
 *                  that NO identified user's cascade can ever reach
 *                  (their levels require exact owner-id equality, and no
 *                  real session is named '__anonymous__'). Anonymous
 *                  callers presenting the same bucket id stay
 *                  self-consistent — they can read back what they wrote.
 *   'reject'     — fail-closed: throws before ANY store write happens,
 *                  for hosts that carry an identity guarantee ("every
 *                  event MUST be attributable") and want the missing-id
 *                  bug to surface instead of being silently absorbed.
 *
 * Non-anonymous identities (ANY of the three ids present) are returned
 * AS-IS under every policy: the policy only governs the no-id-at-all
 * case; ownership attribution is never rewritten for identified callers.
 * The function is pure — no store access — so it is safe to call at any
 * boundary; the natural boundaries are the ingestor's three write
 * entrances and the session.end sleep hand-off.
 */
export function applyAnonymousWritePolicy(
  ids: ScopeIdentity,
  policy: AnonymousWritePolicy = 'global',
): ScopeIdentity {
  const anonymous =
    !ids.userId && !ids.workspaceId && !ids.sessionId;
  if (!anonymous) return ids;
  switch (policy) {
    case 'global':
      return ids;
    case 'quarantine':
      return { ...ids, sessionId: ANONYMOUS_SESSION_ID };
    case 'reject':
      throw new Error(ANONYMOUS_REJECT_MESSAGE);
  }
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
 * The cascade starts at the caller's EFFECTIVE home: the narrowest tier
 * in [session … kind] whose owner id is present (falling back to the
 * configured kind itself when none is). This is the read-side twin of
 * resolveWriteTier's privacy-first rule — when writes for a 'user'-kind
 * caller land at 'session' (because only a sessionId is known), the read
 * cascade must include the session tier too, or those rows would be a
 * black hole to their own author. Each level is the cumulative OR of
 * every tier from the effective home up to that level; levels never
 * widen across owner boundaries and the final level always includes
 * global. Anonymous callers (no ids at all) get a single global-only
 * level — exactly as before.
 */
export function scopeLevels(
  kind: MemoryScopeKind,
  ids: ScopeIdentity,
): ScopeLevelClause[] {
  const kindTier = tierForKind(kind);
  const kindIdx = TIER_ORDER.indexOf(kindTier);
  let home = kindTier;
  for (const t of TIER_ORDER.slice(0, kindIdx + 1)) {
    if (buildTierCondition(t, ids) !== null) {
      home = t;
      break;
    }
  }
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
    const g = buildTierCondition('global', ids);
    // 'global' never needs an owner id — its condition is always usable.
    invariant(g !== null, "the 'global' tier condition is always non-null");
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

/**
 * The widest cumulative level (what "scoped graph analytics" run over).
 *
 * Fails loud on an empty cascade: the old `levels[len-1]!` assertion
 * would silently return `undefined` (typed as a level) and surface much
 * later as a mysterious TypeError far from the cause. scopeLevels()
 * guarantees at least one level — anonymous callers get a global-only
 * fallback — so an empty array here is a caller bug worth throwing on.
 */
export function widestLevel(levels: ScopeLevelClause[]): ScopeLevelClause {
  const widest = levels[levels.length - 1];
  if (widest === undefined) throw new Error('[scope] empty cascade');
  return widest;
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
