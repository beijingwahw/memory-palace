/**
 * Inference engine — from storing beliefs to deriving them.
 *
 * The knowledge graph records what was SAID (co-occurrence). This kernel
 * adds the reasoning layer:
 *
 *   1. TYPED RELATIONS — deterministic bilingual patterns lift co-occurs
 *      into semantics: "A depends on B" / "A 部署在 B" → a `depends-on` /
 *      `deployed-on` edge. No LLM; pattern tables are auditable.
 *
 *   2. TRANSITIVE COMPOSITION — "Aurora depends-on Kafka, Kafka
 *      deployed-on Kubernetes" ⟹ "Aurora reaches Kubernetes" (chain
 *      confidence = ∏ edge weights × 0.85^(hops-1), hops = EDGE count:
 *      the decay multiplier applies only from the second edge onward, so
 *      a two-edge chain with unit weights carries 0.85). Chains with
 *      ≥ 2 hops are NOVEL knowledge: nobody said them, they follow.
 *
 *   3. CONTRADICTION DAMPENING — a chain whose members touch conflicting
 *      facts inherits reduced confidence (beliefs built on disputed
 *      ground are beliefs held loosely).
 *
 * Chains are materialized by the sleep cycle as inferred edges
 * (`inf:reaches`) and derived memory items (source: 'inferred') whose
 * lineage is fully traceable — the palace can always answer WHY it
 * believes something (memory_why).
 */

/** Semantic relation kinds the extractor can lift co-occurrence into. */
export type TypedRelation =
  | 'depends-on'
  | 'deployed-on'
  | 'uses'
  | 'part-of'
  | 'connects-to'
  | 'feeds';

export const TYPED_RELATIONS: readonly TypedRelation[] = [
  'depends-on',
  'deployed-on',
  'uses',
  'part-of',
  'connects-to',
  'feeds',
];

export interface ExtractedRelation {
  from: string; // entity NAME
  to: string; // entity NAME
  relation: TypedRelation;
}

export interface ChainEdge {
  from: string; // entity name
  to: string; // entity name
  relation: string; // typed or 'inf:reaches'
  weight: number;
}

export interface InferredChain {
  /** Full path of entity names, start → … → end. */
  path: string[];
  /** Relation labels along the path. */
  relations: string[];
  /** ∏ weights × 0.85^(hops-1) with hops = EDGE count (decay starts at
   *  the second edge), clamped to (0,1]. */
  confidence: number;
  /** Human-readable assertion: "Aurora —depends-on→ Kafka —deployed-on→ K8s". */
  statement: string;
  /** True when contradiction dampening reduced this chain's confidence —
   *  observable so callers can flag loosely-held derived beliefs. */
  dampened?: boolean;
}

/**
 * Length decay per extra hop — applied from the SECOND edge onward (a
 * chain pays 0.85^(hops-1), hops = edge count): longer chains are weaker
 * beliefs, but a single edge carries no length penalty.
 */
const HOP_DECAY = 0.85;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name made purely of ASCII identifier characters (a "Latin" name). */
const IDENT_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Regex source for an entity NAME match with identifier word boundaries.
 * Latin names (Aurora, NodeGraph, k8s) are wrapped in lookarounds so a
 * name that is a SUBSTRING of another identifier never matches:
 * "NodeGraph depends on Redis" must not lift a phantom
 * "Graph —depends-on→ Redis" edge. Names containing other-script
 * characters (告警服务, K8s集群) need no synthetic boundary — Han
 * characters are their own boundary next to any Latin text.
 */
function namePattern(name: string): string {
  const body = escapeRe(name);
  return IDENT_NAME_RE.test(name)
    ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`
    : body;
}

/** Word-boundary-aware `sent.includes(name)` (see namePattern). */
function namePresent(sent: string, name: string): boolean {
  if (!IDENT_NAME_RE.test(name)) return sent.includes(name);
  return new RegExp(namePattern(name)).test(sent);
}

interface PatternSpec {
  relation: TypedRelation;
  /** EN verb patterns between subject and object. */
  en: string[];
  /** CN connector patterns. */
  cn: string[];
}

const PATTERNS: PatternSpec[] = [
  {
    relation: 'depends-on',
    en: ['(?:directly\\s+)?depends\\s+(?:heavily\\s+)?on', 'relies\\s+on', 'requires'],
    cn: ['依赖', '依赖于', '需要'],
  },
  {
    relation: 'deployed-on',
    en: ['(?:is\\s+)?deployed\\s+(?:on|to|in)', 'runs\\s+on', 'hosted\\s+on'],
    cn: ['部署在', '部署于', '运行在'],
  },
  {
    relation: 'uses',
    en: ['uses', 'utilizes', 'built\\s+with', 'written\\s+in'],
    cn: ['使用', '采用', '用'],
  },
  {
    relation: 'part-of',
    en: ['is\\s+part\\s+of', 'belongs\\s+to', 'is\\s+a\\s+module\\s+of'],
    cn: ['属于', '是.{0,4}的一部分', '包含于'],
  },
  {
    relation: 'connects-to',
    en: ['connects\\s+to', 'talks\\s+to', 'calls'],
    cn: ['连接', '调用'],
  },
  {
    relation: 'feeds',
    en: ['feeds', 'streams\\s+into', 'writes\\s+(?:results\\s+)?into', 'publishes\\s+to'],
    cn: ['流入', '写入', '推送到'],
  },
];

/**
 * Lift typed relations out of a text for pairs of KNOWN entity names.
 * Bounded: at most `maxPairs` subject-object regex probes, sentence-scoped
 * so distant mentions never fabricate relations.
 */
export function extractTypedRelations(
  text: string,
  entityNames: readonly string[],
  maxPairs = 80,
): ExtractedRelation[] {
  const names = [...new Set(entityNames)].filter((n) => n.length >= 2 && !n.includes('/'));
  const out: ExtractedRelation[] = [];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  let probes = 0;

  for (const sent of sentences) {
    const present = names.filter((n) => namePresent(sent, n));
    if (present.length < 2) continue;
    for (const a of present) {
      for (const b of present) {
        if (a === b) continue;
        if (probes >= maxPairs) return dedupe(out);
        probes++;
        for (const spec of PATTERNS) {
          // EN connectors require trailing whitespace (\s+); CN connectors
          // make it OPTIONAL (\s*) so "A依赖B" with no space extracts
          // exactly like "A depends on B".
          const connectors = [
            ...spec.en.map((p) => `${p}\\s+`),
            ...spec.cn.map((p) => `${p}\\s*`),
          ].join('|');
          const re = new RegExp(
            `${namePattern(a)}\\s*[—-]?\\s*(?:${connectors})(?:the\\s+)?${namePattern(b)}`,
            'i',
          );
          if (re.test(sent)) {
            out.push({ from: a, to: b, relation: spec.relation });
            break;
          }
        }
      }
    }
  }
  return dedupe(out);
}

function dedupe(rels: ExtractedRelation[]): ExtractedRelation[] {
  const seen = new Set<string>();
  const out: ExtractedRelation[] = [];
  for (const r of rels) {
    const key = `${r.from}|${r.relation}|${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface ComposeOptions {
  /** Max hops per chain (≥2 makes chains novel); clamped to [2, 3].
   *  Default 3. */
  maxDepth?: number;
  /** Max chains returned (strongest first). Default 20. */
  maxChains?: number;
  /** Minimum chain confidence. Default 0.25. */
  minConfidence?: number;
  /** Endpoints of low-confidence (contradicted) facts — their chains dampen. */
  contradictedEntities?: ReadonlySet<string>;
}

/**
 * Compose novel multi-hop chains over TYPED edges (co-occurs excluded).
 * DFS from every node, depth-bounded; dedupe by (start,end) keeping the
 * highest-confidence path; contradictions dampen member confidence.
 * Chains below `minConfidence` are dropped — except contradiction-dampened
 * ones, which may dip to 0.75× the bar (beliefs weakened by dispute, not
 * weak beliefs).
 */
export function composeChains(
  edges: ChainEdge[],
  opts: ComposeOptions = {},
): InferredChain[] {
  const maxDepth = Math.max(2, Math.min(3, opts.maxDepth ?? 3));
  const maxChains = opts.maxChains ?? 20;
  const minConf = opts.minConfidence ?? 0.25;
  const contradicted = opts.contradictedEntities ?? new Set<string>();

  const typed = edges.filter(
    (e) => TYPED_RELATIONS.includes(e.relation as TypedRelation) && e.weight > 0,
  );
  const adj = new Map<string, ChainEdge[]>();
  for (const e of typed) {
    const arr = adj.get(e.from) ?? [];
    arr.push(e);
    adj.set(e.from, arr);
  }

  const best = new Map<string, InferredChain>();
  const dfs = (
    start: string,
    node: string,
    path: string[],
    relations: string[],
    conf: number,
    dampened: boolean,
  ) => {
    if (path.length > maxDepth) return;
    for (const e of adj.get(node) ?? []) {
      if (path.includes(e.to)) continue; // no cycles
      const hopConf = Math.min(1, e.weight);
      const edgeDampened = contradicted.has(e.from) || contradicted.has(e.to);
      const dampen = edgeDampened ? 0.75 : 1;
      // Hop decay applies only from the SECOND edge onward: chain
      // confidence is ∏w × 0.85^(hops-1) with hops = edge count, so a
      // single-edge traversal carries no length penalty.
      const hopDecay = relations.length >= 1 ? HOP_DECAY : 1;
      const nextConf = conf * hopConf * hopDecay * dampen;
      const nextDampened = dampened || edgeDampened;
      const nextPath = [...path, e.to];
      const nextRels = [...relations, e.relation];
      // The sub-bar floor is reserved for DAMPENED chains (contradiction
      // touchers) only: an ordinary chain below minConfidence must NOT be
      // returned — the shared floor used to let clean 0.257-confidence
      // chains through on the strength of a dampening they never had.
      // nextDampened is settled BEFORE this gate, and pruning is safe:
      // chain confidence never rises along a path, so a non-dampened
      // prefix below minConf can never recover above it.
      const floor = nextDampened ? minConf * 0.75 : minConf;
      if (nextPath.length >= 3 && nextConf >= floor) {
        const key = `${start}→${e.to}`;
        const existing = best.get(key);
        if (!existing || nextConf > existing.confidence) {
          best.set(key, {
            path: nextPath,
            relations: nextRels,
            confidence: Number(nextConf.toFixed(3)),
            statement:
              nextPath
                .map((n, i) => (i === 0 ? n : `—${nextRels[i - 1]}→ ${n}`))
                .join(' '),
            // Same value shape as `nextDampened || undefined`: the key is
            // present exactly when dampening fired (explicit undefined is
            // forbidden under exactOptionalPropertyTypes, and JSON encoding
            // dropped it anyway).
            ...(nextDampened ? { dampened: true } : {}),
          });
        }
      }
      if (nextConf >= floor) dfs(start, e.to, nextPath, nextRels, nextConf, nextDampened);
    }
  };

  for (const start of adj.keys()) dfs(start, start, [start], [], 1, false);

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || a.statement.localeCompare(b.statement))
    .slice(0, maxChains);
}

/**
 * Render a chain as a natural derived assertion for storage.
 * `withConfidence` (default true) keeps the display format
 * "Inferred (78%): …"; false yields the bare statement — the stable,
 * confidence-free form used as a DEDUPE key, so a fact whose confidence
 * drifted between nights still maps to the same key.
 */
export function chainStatement(
  chain: InferredChain,
  opts?: { withConfidence?: boolean },
): string {
  return (opts?.withConfidence ?? true)
    ? `Inferred (${(chain.confidence * 100).toFixed(0)}%): ${chain.statement}`
    : chain.statement;
}
