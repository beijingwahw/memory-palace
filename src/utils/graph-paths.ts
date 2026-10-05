/**
 * Shortest path over the (undirected view of the) co-occurrence graph.
 *
 * Bidirectional BFS: expands from both endpoints alternately, meeting in
 * the middle — halves the effective branching factor, which matters on
 * hub-heavy co-occurrence graphs. Depth-capped so a query between
 * disconnected components returns quickly instead of walking the whole
 * graph. Deterministic: neighbors are visited in sorted order.
 */

export function buildAdjacency(
  edges: Array<{ from: string; to: string }>,
): Map<string, string[]> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adj.get(a);
    if (!s) {
      s = new Set();
      adj.set(a, s);
    }
    s.add(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const out = new Map<string, string[]>();
  for (const [k, s] of adj) out.set(k, [...s].sort());
  return out;
}

/**
 * Shortest node path from `from` to `to` (inclusive), or null when
 * unreachable within `maxDepth` total hops.
 */
export function shortestPath(
  adjacency: Map<string, string[]>,
  from: string,
  to: string,
  maxDepth = 6,
): string[] | null {
  if (from === to) return [from];
  if (!adjacency.has(from) || !adjacency.has(to)) return null;

  const parentF = new Map<string, string>([[from, from]]);
  const parentB = new Map<string, string>([[to, to]]);
  let frontierF = [from];
  let frontierB = [to];
  let depthF = 0;
  let depthB = 0;

  const expand = (
    frontier: string[],
    parent: Map<string, string>,
    other: Map<string, string>,
  ): { meeting: string } | null => {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of adjacency.get(node) ?? []) {
        if (parent.has(nb)) continue;
        parent.set(nb, node);
        if (other.has(nb)) return { meeting: nb };
        next.push(nb);
      }
    }
    frontier.length = 0;
    frontier.push(...next);
    return null;
  };

  while (true) {
    // Alternate sides; expand the smaller frontier first. Guard BEFORE
    // expanding: the resulting path depth is (depth+1) + otherDepth.
    if (frontierF.length <= frontierB.length) {
      if (depthF + 1 + depthB > maxDepth) return null;
      depthF++;
      const met = expand(frontierF, parentF, parentB);
      if (met) return reconstruct(parentF, parentB, met.meeting);
      if (frontierF.length === 0) return null;
    } else {
      if (depthF + 1 + depthB > maxDepth) return null;
      depthB++;
      const met = expand(frontierB, parentB, parentF);
      if (met) return reconstruct(parentF, parentB, met.meeting);
      if (frontierB.length === 0) return null;
    }
  }
}

function reconstruct(
  parentF: Map<string, string>,
  parentB: Map<string, string>,
  meeting: string,
): string[] {
  const head: string[] = [];
  let cur = meeting;
  while (parentF.get(cur) !== cur) {
    head.push(cur);
    cur = parentF.get(cur)!;
  }
  head.push(cur);
  head.reverse();
  const tail: string[] = [];
  cur = meeting;
  while (parentB.get(cur) !== cur) {
    cur = parentB.get(cur)!;
    tail.push(cur);
  }
  return [...head, ...tail];
}
