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
    // Self-loops are dropped, aligned with communities' D-13 policy
    // (addEdge skips a===b): a self-loop's endpoints are trivially in the
    // same cluster and at distance 0, so keeping x in its own neighbor
    // table only inflates degree statistics without carrying information.
    if (e.from === e.to) continue;
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
  const frontierF = [from];
  const frontierB = [to];
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

  for (;;) {
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
  // Every walked node was assigned a parent by expand(); the root maps to
  // itself, so the lookup never misses on this walk.
  for (;;) {
    const parent = parentF.get(cur);
    if (parent === undefined || parent === cur) break;
    head.push(cur);
    cur = parent;
  }
  head.push(cur);
  head.reverse();
  const tail: string[] = [];
  cur = meeting;
  for (;;) {
    const parent = parentB.get(cur);
    if (parent === undefined || parent === cur) break;
    cur = parent;
    tail.push(cur);
  }
  return [...head, ...tail];
}
