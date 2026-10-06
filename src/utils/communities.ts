/**
 * Community detection via weighted Label Propagation (LPA).
 *
 * LPA is near-linear in edges and needs no hyperparameters beyond
 * iteration count, which makes it the right complexity class for an
 * agent-memory graph that must be analyzed inside a tool call. Two
 * determinism guarantees over textbook LPA:
 *
 *   - initial labels derive from a stable hash of node ids (no RNG)
 *   - ties break toward the smallest label, and nodes update in sorted
 *     order, so the same graph always yields the same communities
 */

export interface WeightedEdge {
  a: string;
  b: string;
  weight: number;
}

export interface CommunityReport {
  /** node id → community label */
  labels: Map<string, number>;
  /** communities sorted by size desc, members sorted for readability */
  communities: Array<{ label: number; size: number; members: string[] }>;
  /** fraction of edge weight that stays inside a community (cohesion 0..1) */
  cohesion: number;
}

/** FNV-1a-ish stable hash for deterministic seeding. */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function labelPropagation(
  nodes: string[],
  edges: WeightedEdge[],
  opts: { maxIterations?: number } = {},
): CommunityReport {
  const maxIterations = opts.maxIterations ?? 20;
  const sorted = [...nodes].sort();

  // Undirected weighted adjacency
  const adj = new Map<string, Map<string, number>>();
  const addEdge = (a: string, b: string, w: number) => {
    if (a === b) return;
    let m = adj.get(a);
    if (!m) {
      m = new Map();
      adj.set(a, m);
    }
    m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const e of edges) {
    addEdge(e.a, e.b, e.weight);
    addEdge(e.b, e.a, e.weight);
  }

  const labels = new Map<string, number>();
  for (const n of sorted) labels.set(n, stableHash(n));

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (const n of sorted) {
      const neighbors = adj.get(n);
      if (!neighbors || neighbors.size === 0) continue;
      // weighted vote: strongest neighboring label wins, ties → min label
      const votes = new Map<number, number>();
      for (const [nb, w] of neighbors) {
        const l = labels.get(nb);
        if (l === undefined) continue;
        votes.set(l, (votes.get(l) ?? 0) + w);
      }
      let bestLabel: number | null = null;
      let bestWeight = -Infinity;
      for (const [l, w] of [...votes].sort((x, y) => x[0] - y[0])) {
        if (w > bestWeight) {
          bestWeight = w;
          bestLabel = l;
        }
      }
      if (bestLabel !== null && labels.get(n) !== bestLabel) {
        labels.set(n, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Relabel communities 0..k-1 by descending size then smallest hash.
  const groups = new Map<number, string[]>();
  for (const [node, label] of labels) {
    const arr = groups.get(label) ?? [];
    arr.push(node);
    groups.set(label, arr);
  }
  const ordered = [...groups.entries()]
    .map(([hash, members]) => ({ hash, members: members.sort() }))
    .sort((x, y) => y.members.length - x.members.length || x.hash - y.hash);
  const canonical = new Map<number, number>();
  ordered.forEach((g, i) => canonical.set(g.hash, i));

  const finalLabels = new Map<string, number>();
  for (const [node, label] of labels) finalLabels.set(node, canonical.get(label) ?? 0);

  // Cohesion: share of total edge weight whose endpoints share a label.
  // Self-loops are skipped under the same policy as the adjacency build
  // above (addEdge drops a===b): a self-loop's endpoints trivially share
  // a label, so counting it would inflate both `intra` and `total` toward
  // 1 and make cohesion look artificially high on self-looping input.
  // Upstream callers currently never emit self-loops — this is defensive
  // consistency, not a behavior change for them.
  let intra = 0;
  let total = 0;
  for (const e of edges) {
    if (e.a === e.b) continue;
    total += e.weight;
    if (finalLabels.get(e.a) === finalLabels.get(e.b)) intra += e.weight;
  }

  return {
    labels: finalLabels,
    communities: ordered.map((g) => ({
      label: canonical.get(g.hash) ?? 0,
      size: g.members.length,
      members: g.members,
    })),
    cohesion: total > 0 ? intra / total : 1,
  };
}
