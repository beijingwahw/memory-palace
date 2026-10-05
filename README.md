# Memory Palace — DSH Plugin

Long-term layered memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents. Solves cold-start token waste, lost context between sessions, and long-context quality decay.

## Why

DeepSeek Harness (DSH) provides a strong runtime for agents, but every new session starts cold:

- the user re-explains the project
- the agent re-reads files it already read yesterday
- tool results the user already saw are recomputed
- context windows fill with low-value history, pushing useful context out
- the model's effective context is much shorter than the advertised 64K/128K

`@dsh-plugins/memory-palace` gives the agent a persistent, structured memory across sessions:

| Layer    | What lives here                                          | Lifetime      |
| -------- | -------------------------------------------------------- | ------------- |
| episodic | Raw event log of each session (messages, tool calls)     | Session       |
| semantic | Distilled, vectorized facts and chunks                   | Cross-session |
| procedural | User preferences, habits, working style patterns       | Cross-user    |

Plus a **knowledge graph** built automatically from entity co-occurrence and an **incremental PageRank** that acts as a zero-mean retrieval prior and picks the lead entity for cold-start subgraph injection.
## A platform, not just a plugin

Three dimensions beyond a single-tenant memory store:

- **Transport — Memory Capsules.** One agent hands another a signed, content-addressed bundle of distilled knowledge: HMAC tamper evidence over canonical JSON, deterministic ids (same fact exported anywhere dedupes on import), owner identity stripped on export and rebound to the importer on arrival, contradictions flagged on the way in. Tools: `memory_capsule_export` / `memory_capsule_import`.
- **Self-improvement — Reflection.** `memory_reflect` builds a self-consistency benchmark (each memory's first sentence must retrieve that memory), sweeps a 36-point parameter grid through real throwaway retrievers, and reports MRR / recall@5 plus a recommended `retrieval.graphBoost` / `prf` configuration. Evidence, not folklore.
- **Ubiquity — MCP.** `npx memory-palace-mcp` runs the palace as a standalone Model Context Protocol stdio server: Claude Desktop, IDE agents and custom orchestrators mount the same 8 tools, the same ACL, the same store — no DSH required.


## What it does

1. **Hooks into every `message.user` / `message.assistant` / `tool.*` event** from DSH.
2. **Chunks long messages** respecting markdown structure (headings, code fences — with a fence-state machine so code blocks stay intact and separated from prose; every chunk carries exact source offsets).
3. **Embeds chunks** with the DeepSeek Embedding API, with runtime failover: a circuit breaker opens when the API is unreachable and the offline BM25-style provider takes over. Vectors are **space-tagged** (`deepseek:…` / `offline-bm25:…`) so vectors from different spaces are never compared.
4. **Extracts entities** (paths, URLs, `@mentions`, identifiers, capitalized terms) with provenance hints (`@alice` → person, `src/app.ts` → file, …) and builds a co-occurrence knowledge graph. Each semantic item is linked to the most-mentioned entity that literally occurs in its text.
5. **Retrieves via SQL pushdown**: an `mp_cosine(embedding, query)` scalar function is registered inside SQLite, so scoring, ordering and LIMIT all run in the database engine — exact search over the whole store with O(topK) JS heap, no scan caps.
6. **Compresses aggressively** when memory grows past the trigger count — low-importance old items get evicted, related items get distilled (optionally through an LLM summarize callback). Distillation clustering is **space- and owner-partitioned**: candidates are drawn exclusively from the same `(embeddingSpace, owner)` partition, so a cluster never crosses a space or an owner boundary. Bucketing uses deterministic anchor projection (LSH-lite sign keys over fixed pseudo-random planes, neighbors within Hamming distance 1) instead of O(n²) pairwise scans — the cosine gate remains the final arbiter. `savedTokens` in the report is computed honestly from the actual merged text versus the sum of its parts, clamped at zero per cluster and in total, so an expanding summary can never report negative savings.
7. **Injects relevant context** at `session.start`, scoped to the caller, so the agent opens with what it already knows about this user.
8. **Exposes five tools** (`memory_retrieve` … `memory_graph`) via the DSH TypeScript Tool Contract when the host supports `ctx.tool`.

The **procedural layer** is populated the same LLM-free way: during compression, a deterministic pattern miner scans user-voice memories and writes preference (`prefers-<token>`) and topic (`topic:<a>+<b>`) patterns into the procedural tier, which the context injector surfaces at session start. Mining is contrast-gated — a token qualifies only when it recurs across ≥3 items, on ≥2 distinct days, in memories whose mean importance is at least the corpus mean, separating deliberate habits from incidental vocabulary — and each pattern is written visibility-scoped with up to five pieces of supporting evidence.

### Retrieval pipeline

```
query ─▶ semantic cache (anchor-bucketed, cosine ≥ 0.985, version-stamped)
      ─▶ embed once per stored space ─▶ SQL pushdown cosine scan
        (delta-tier widening; since/until windows; as-of flashback)
      ─▶ pseudo-relevance feedback (Rocchio: top-hit centroid re-blend,
        per-space, pure local math)
      ─▶ entity-anchor hop expansion (items linked to top-hit entities,
        bounded 0.55 anchor weight — same topic, different wording)
      ─▶ time-decay × importance × zero-mean PPR prior (SWR caches)
      ─▶ MMR diversification ─▶ keyword rerank + phrase emphasis ─▶ topK
```

`minScore` gates on **raw cosine** (pre-decay), so its meaning doesn't drift with item age. The PageRank prior is zero-mean — `1 + g·(p − p̄)` clamped to `[1−g, 1+g]` — so central-entity items are boosted without shifting overall score calibration.

Each widening level scans only its **delta tiers** — the tiers it newly adds, not the full cumulative clause — so every row is scored exactly once across the cascade. Hits carry `scopeLevel` (the cascade level that surfaced them; also reported on `memory.after-retrieve`), and quoted phrases in the query add **keyword-rerank emphasis**: quoted spans parse into emphasis phrases that weight the keyword fusion on top of token overlap.

### Scopes — a four-tier visibility ACL

Every scoppable row — memory items, **knowledge-graph entities and their edges** — carries a `visibility` tier plus owner columns:

| Tier        | Who sees it                          |
| ----------- | ------------------------------------ |
| `session`   | only the owning session              |
| `workspace` | only the owning workspace            |
| `user`      | only the owning user                 |
| `global`    | everyone (shared knowledge base)     |

Retrieval widens cumulatively (`session → workspace → user → global`) only while the candidate pool is thin, and **never crosses an owner boundary**. The knowledge graph is scoped with the same ACL: a private mention creates a private entity, so one user's entities, co-occurrence edges and PageRank never leak into another user's analytics (subgraphs, paths, communities, ranks). Distillation inherits the dominant tier of its cluster — compression can't launder private memories into the global tier. Anonymous callers see the `global` tier only. `memory_remember` accepts a per-item `visibility` override ("remember this globally").

### Lifecycle & retention

Memory has an enforced lifecycle, not just a growth path:

- **Read-time TTL enforcement** — every read path filters on `metadata.expiresAt` inline (`json_extract` in the SQL WHERE clause), so an expired item is invisible even between sweeps. `sweepExpiredItems()` tombstones expired rows recoverably and doubles as a maintenance entry point.
- **Retention pass during compression** — after a real (non-skipped) pass, episodic event rows are pruned after 90 days and tombstones purged after 7 days; the counts surface on the `memory.compressed` report as `expiredSwept` / `eventsPruned` / `tombstonesPurged`.
- **Mid-session compression checks** — compression no longer waits for `session.end`: every 25 ingested message events the same gates are re-checked (and embedder health re-probed), so a marathon session cannot grow memory unbounded between checks.
- **Best-effort close** — SIGINT/SIGTERM close the store on the way out when the host hasn't disposed the plugin first.

### Security notes

- The `memory-palace` facade service publishes its config with the embedding `apiKey` **redacted** — the public service cannot leak the real key.
- `memory_forget` — including `restore` and `purge` — is **visibility-checked**: ids resolve only inside the caller's scope, and purge hard-deletes only the caller's tombstones, never another tenant's.
- Anonymous callers see only the `global` tier (see Scopes above).
- Embedding fetches are bounded by a **15 s timeout** (`AbortSignal`), and the circuit breaker's open/half-open/closed **transitions are logged** instead of failing silently.

### Ranking — weighted, temporal, personalized PageRank

The retrieval prior is built from one PageRank kernel with three extensions:

- **weighted** — edge mass flows by accumulated co-occurrence count, not degree;
- **temporal** — edge weights decay with a configurable half-life (`pagerankEdgeDecayDays`), so ranks track current focus;
- **personalized (PPR)** — when the query mentions known entities, teleport mass concentrates on them (random-walk-with-restart): memories linked to entities *near the question* are boosted over equally-central-but-unrelated ones. The blend with global rank is `personalizationWeight` (0.6 default).

Both rank maps are cached against the store's monotonic graph-version stamp (`PRAGMA user_version`), immune to count-collision staleness; PPR results are cached per seed-set with LRU eviction. The prior stays zero-mean — `1 + G·(r − r̄)` clamped to `[1−G, 1+G]` — so it reorders without shifting score calibration, and every hit's `explain` names the entity that ranked it with its global rank and PPR proximity.

The decay clock is **access-refreshed**: age is measured from `max(createdAt, lastAccessedAt)`, and every recall bumps importance by a bounded epsilon (+0.01, hard cap 0.95) — the testing effect, so memories strengthen with use without runaway reinforcement. Rank caches serve **stale-while-revalidate with a 500 ms staleness floor**: a query may be answered from cache while revalidation runs, but ranks never lag graph writes by more than that floor.

## Install

```yaml
# dsh.yaml
plugins:
  - "@dsh-plugins/memory-palace"

memoryPalace:
  storagePath: "${workspace}/.dsh/memory-palace.db"
  embedding:
    provider: deepseek          # or "offline-bm25"; runtime failover either way
    model: deepseek-embed
    apiKey: ${DEEPSEEK_API_KEY}
    baseUrl: https://api.deepseek.com
    dimensions: 1024
  retrieval:
    topK: 8
    mmrLambda: 0.5
    minScore: 0.1               # raw-cosine floor; ~0.3 for dense providers
    rerank: true
    graphBoost: 0.15            # PageRank prior weight (0 disables)
  compression:
    enabled: true
    triggerCount: 200
    importanceThreshold: 0.35
    decayHalfLifeDays: 14
  graph:
    enabled: true
    maxEntities: 5000
    pagerankDamping: 0.85
    pagerankIterations: 20
    pagerankEdgeDecayDays: 30   # edge-weight recency half-life; 0 disables
    personalizationWeight: 0.6  # PPR vs global blend when query entities are known
  injection:
    enabled: true
    maxTokens: 2000
    systemPromptPrefix: |
      You have access to a long-term memory palace. When the user references
      past context, consult it via the memory_retrieve tool before answering.
  scope: user   # user | workspace | session
```

## Tools exposed to the model

All five tools are far more than thin CRUD — each carries a specialized capability:

| Tool                | Capability                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `memory_retrieve`   | **Self-query understanding** ("last week"/"最近"/"top 20"/quoted phrases are parsed automatically; temporal windows push down into SQL; entity mentions are graph-linked and boosted) + `mode:"synthesis"` clusters hits into **corroborating groups and flags contradictions** (differing version numbers, negation flips) + every hit carries a **score decomposition** (raw cosine / decay / importance / graph prior / keyword) |
| `memory_remember`   | **Write-time intelligence**: near-duplicates are detected and deduplicated (returns the existing id); conflicting memories are reported, and `supersede:true` tombstones outdated versions behind an auditable supersession chain. Dedup-vs-update is decided by similarity **and** contradiction, not similarity alone — "v16"→"v17" is an update, not a clone |
| `memory_forget`     | **Right-to-be-forgotten with safety rails**: by id, by entity (cascades to linked items + graph edges), or by semantic query; `dryRun:true` previews; deletes are soft (undo via `restore:true`) until `purge:true` hard-deletes tombstones |
| `memory_inspect`    | **Memory observability**: per-layer/space counts, graph shape, recent items — plus a health panel (signal ratio, duplication ratio, age distribution, PageRank **Gini concentration**, orphan entities) and concrete maintenance recommendations |
| `memory_graph`      | **Graph analytics**: `expand` (ranked neighborhood), `path` (shortest co-occurrence chain between two entities — "how are X and Y related?"), `communities` (**label-propagation topic clustering**, deterministic) |

| `memory_capsule_export` / `memory_capsule_import` | Signed, content-addressed inter-agent knowledge bundles (dedupe + conflict flags + owner rebinding) |
| `memory_reflect`    | Self-consistency benchmark + 36-point parameter sweep; recommends a better retrieval config |

Registered automatically when the host kernel provides `ctx.tool` (DSH TypeScript Tool Contract). Hosts without it simply run the plugin as services.

## Events

| Event                     | Payload                                            |
| ------------------------- | -------------------------------------------------- |
| `memory.before-retrieve`  | `{ query, layers, topK, minScore, scope }`         |
| `memory.after-retrieve`   | `{ query, hits, totalTokens, elapsedMs, scopeLevel }` |
| `memory.before-store`     | `{ id, layer, scope }`                             |
| `memory.after-store`      | `{ id, layer, embeddingSpace }`                    |
| `memory.remembered`       | `{ id, conflicts, superseded }`                    |
| `memory.forgotten`        | `{ mode, count, ... }`                             |
| `memory.compressed`       | `CompressionReport`                                |
| `memory.graph-updated`    | `{ entityIds }`                                    |
| `memory.context-injected` | `InjectionOutput`                                  |

## Programmatic use

```ts
import MemoryPalacePlugin from "@dsh-plugins/memory-palace";
import { createCordisApp } from "@cordis/core";

const app = createCordisApp();
await app.plugin(MemoryPalacePlugin, {
  storagePath: "./memory.db",
});

const palace = app.service("memory-palace");

await palace.remember(
  "Project Phoenix uses Postgres 16 with pgvector for similarity search",
  { tags: ["project", "phoenix"] },
);

const hits = await palace.retrieve("How is Phoenix deployed?");
console.log(hits.hits.map((h) => h.item.content));
```

## Architecture

```
                ┌───────────────────────────────────────────┐
                │           DSH Cordis Kernel               │
                └───────────────────────────────────────────┘
                                  ▲
              on('message.user')   │   ctx.emit('memory.*') via event bus
              on('session.start')  ▼
        ┌───────────────────────────────────────────────────┐
        │              @dsh-plugins/memory-palace           │
        │                                                   │
        │  Ingestor ─▶ Chunker ─▶ EmbeddingGateway          │
        │                  │        (space-tagged,          │
        │                  │         circuit-breaker)       │
        │                  ▼                                │
        │            MemoryStore (SQLite + mp_cosine)       │
        │            ├ episodic  ├ semantic  ├ procedural    │
        │                  │                                │
        │   MemoryGraph ───┘ (hints, co-occurrence, PR)     │
        │                  │                                │
        │            MemoryCompressor                       │
        │            (eviction + distillation + retention)  │
        │                  │                                │
        │            MemoryRetriever                        │
        │            (scopes + PR prior + MMR + rerank)     │
        │                  │                                │
        │            ContextInjector ─▶ systemPrompt        │
        └───────────────────────────────────────────────────┘
```

## Performance

The numbers below were measured on the original 0.1 single-user prototype; the SQL-pushdown path changed the profile — re-measure before relying on them. Vector scoring is pushed into SQLite as a registered scalar function, so retrieval streams best-first rows out of the engine: JS heap is O(topK), not O(store), and there is no scan cap. On a single SQLite file (M2 MacBook Pro, offline provider):

- **Insert throughput**: ~600 items/sec (offline), ~80 items/sec (DeepSeek API)
- **Retrieval latency (10k items)**: ~25 ms p50
- **Retrieval latency (100k items)**: ~250 ms p50 (exact scan; every item is a candidate)

If you outgrow exact scan, an IVF (inverted-file) index over the same `mp_cosine` primitive is the natural next step — buckets via k-means, `nprobe` nearest centroids per query — without changing the retrieval API.

## Migrating from 0.1.x – 0.6.x / 0.4.x

- 0.2: `session_id` + `embedding_space` columns; scope filtering; SQL-pushdown cosine scan; PageRank retrieval prior; runtime embedding failover; tool registration; tombstone/supersession **groundwork only** (fields kept auditable — the `deleted_at`/`superseded_by` columns and chains themselves shipped in 0.3).
- 0.3: `deleted_at` / `superseded_by` (tombstones + supersession chains); self-query understanding; consensus synthesis; dedup/conflict-aware writes; health observability; graph path/communities.
- 0.7: **dimensional elevation** — Memory Capsules (inter-agent transport), reflection-based self-tuning, MCP stdio server (memory-palace-mcp); 8 tools, 2 new services.
- 0.6: **retrieval kernel v3** — pseudo-relevance feedback (Rocchio second pass), entity-anchor hop expansion, as-of flashback queries (asOfMs / memory_retrieve asOf), a deterministic semantic query cache (invalidated by the store data-version stamp), and session-start PPR warm-up. RetrieverConfig gained prf/entityHop/queryCache; hits gained via (vector | entity-hop).
- 0.5: hardening wave — fetch timeout + breaker observability, space/owner-partitioned distillation, TTL + retention lifecycle, access-refreshed decay, visibility-checked tools, transactional two-phase ingest, procedural pattern mining, SWR rank caches.
- 0.4: **visibility-tier ACL** — `visibility` (+ owner) columns on memory items, entities and graph edges; the knowledge graph is now scope-isolated; retrieval widens over tiers and anonymous callers see only `global`. PageRank became weighted + temporal + personalized (PPR), with graph-version-stamped caches. `RetrievalHit.explain` gained a graph breakdown (`graphEntity.globalRank / proximityRank`). Distillation inherits its cluster's dominant tier.
- `retrieval.minScore` gates on **raw cosine** (pre-decay); 0.1 remains the default.
- `sqlite-vec` was removed from dependencies (it was never imported); vector search runs through the SQL-pushdown cosine scan.

## License

MIT
