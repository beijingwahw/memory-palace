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
## The Living Core (persistent self)

Beyond archival recall, the palace maintains a SELF: three hard-capped core blocks — **profile**, **project**, **goals** — that are ALWAYS injected first at session start (bounded by `injection.coreBudgetFraction`, default 1/3 of the injection budget). The agent edits them directly (`memory_core`: read/set/append/history/compact); the **sleep cycle** (session.end + every 25th message, or `memory_sleep` on demand) re-compacts them against current entity salience with a deterministic kernel: line scoring (PageRank-hot entities, structure, goal markers, brevity), token-Jaccard dedupe, lowest-first eviction. Every rewrite is versioned into a bounded audit trail — no version of the self is silently lost. Blocks live behind the same four-tier ACL: one agent's self never leaks into another's injection.

## A platform, not just a plugin

Three dimensions beyond a single-tenant memory store:

- **Transport — Memory Capsules.** One agent hands another a signed, content-addressed bundle of distilled knowledge: HMAC tamper evidence over canonical JSON, deterministic ids (same fact exported anywhere dedupes on import), owner identity stripped on export and rebound to the importer on arrival, contradictions flagged on the way in. Capsule ids are 128-bit truncated-SHA-256 content addresses (cryptographic-CAS discipline, resistant to deliberately ground collisions on the untrusted cross-agent channel), and the importer accepts all three id generations — 8/16/32 hex — so capsules minted by older palaces never expire. Tools: `memory_capsule_export` / `memory_capsule_import`. Imports can also enforce freshness: pass `maxAgeMs` in the import options and a capsule older than that is rejected at the parse boundary — replayed stale knowledge never lands.
- **Self-improvement — Reflection.** `memory_reflect` builds a self-consistency benchmark (each memory's first sentence must retrieve that memory), sweeps a 36-point parameter grid through real throwaway retrievers, and reports MRR / recall@5 plus a recommended `retrieval.graphBoost` / `prf` configuration. Evidence, not folklore.
- **Ubiquity — MCP.** `npx memory-palace-mcp` runs the palace as a standalone Model Context Protocol stdio server: Claude Desktop, IDE agents and custom orchestrators mount the same 15 tools, the same ACL, the same store — no DSH required.


## What it does

1. **Hooks into every `message.user` / `message.assistant` / `tool.*` event** from DSH.
2. **Chunks long messages** respecting markdown structure (headings, code fences — with a fence-state machine so code blocks stay intact and separated from prose; every chunk carries exact source offsets).
3. **Embeds chunks** with the DeepSeek Embedding API, with runtime failover: a circuit breaker opens when the API is unreachable and the offline BM25-style provider takes over. Vectors are **space-tagged** (`deepseek:…` / `offline-bm25:…`) so vectors from different spaces are never compared.
4. **Extracts entities** (paths, URLs, `@mentions`, identifiers, capitalized terms) with provenance hints (`@alice` → person, `src/app.ts` → file, …) and builds a co-occurrence knowledge graph. CJK terms are extracted through three tiered deterministic signals — quoted spans (「」/【】/“”), system-noun suffixes with connector boundaries (依赖/部署在 are exactly the boundaries between two entity mentions), and exact repeats (DECISIONS D-16; English extraction is byte-identical). Each semantic item is linked to the most-mentioned entity that literally occurs in its text.
5. **Retrieves via SQL pushdown**: an `mp_cosine(embedding, query)` scalar function is registered inside SQLite, so scoring, ordering and LIMIT all run in the database engine — exact search over the whole store with O(topK) JS heap, no scan caps.
6. **Compresses aggressively** when memory grows past the trigger count — low-importance old items get evicted, related items get distilled (optionally through an LLM summarize callback). Distillation clustering is **space- and owner-partitioned**: candidates are drawn exclusively from the same `(embeddingSpace, owner)` partition, so a cluster never crosses a space or an owner boundary. Bucketing uses deterministic anchor projection (LSH-lite sign keys over fixed pseudo-random planes, neighbors within Hamming distance 1) instead of O(n²) pairwise scans — the cosine gate remains the final arbiter. `savedTokens` in the report is computed honestly from the actual merged text versus the sum of its parts, clamped at zero per cluster and in total, so an expanding summary can never report negative savings.
7. **Injects relevant context** at `session.start`, scoped to the caller, so the agent opens with what it already knows about this user.
8. **Exposes 15 tools** (`memory_retrieve` … `memory_fed_search`) via the DSH TypeScript Tool Contract when the host supports `ctx.tool`.

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

Retrieval widens cumulatively (`session → workspace → user → global`) only while the candidate pool is thin, and **never crosses an owner boundary**. The knowledge graph is scoped with the same ACL: a private mention creates a private entity, so one user's entities, co-occurrence edges and PageRank never leak into another user's analytics (subgraphs, paths, communities, ranks). Distillation inherits the **narrowest** tier present in its cluster — compression can narrow visibility but never widen it (a private row keeps the merged item private), and the tier is no longer part of the distill partition key, so same-owner near-duplicates written at different tiers actually merge. Anonymous callers see the `global` tier only. `memory_remember` accepts a per-item `visibility` override ("remember this globally").

Writes from callers carrying **no identity at all** (no user / workspace / session id) are governed by `scope.anonymousPolicy` — an explicit three-state choice instead of a silent fail-open into the shared tier, enforced at every user-facing write boundary (message/tool ingest, `memory_remember`, capsule import, `session.end`):

| Policy       | Anonymous writes…                                                       |
| ------------ | ----------------------------------------------------------------------- |
| `global`     | land in the shared global tier — the default; byte-identical to every prior release |
| `quarantine` | land in the `__anonymous__` session bucket, invisible to identified users |
| `reject`     | are refused outright — fail-closed, for hosts that guarantee identity at their own boundary |

The `session` tier is a **shared visibility group with a bearer credential**: anyone holding the same sessionId sees the session tier — across users and across workspaces alike — and impersonating a sessionId to gain in-group visibility is in-design (possession *is* the authorization; that's what makes collaborative sessions and agent hand-offs work). Hosts should therefore mint **unguessable** session ids; weak or predictable ones trigger a runtime warning. The semantics is verified, not merely tolerated — pinned as invariant I-ACL-17 (docs/INVARIANTS.md), proven cell-by-cell by the exhaustive ACL truth table and locked by a dedicated pinning test so it can never be "fixed" into a bug.

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

### CJK-aware tokenization

The tokenizer applies **CJK bigram segmentation**: runs of Chinese/Japanese/Korean characters are split into overlapping character pairs (unigrams for single-character runs), so keyword rerank, consensus synthesis, contradiction detection, pattern mining and the reflection benchmark all operate on sub-word units that match between two Chinese sentences sharing no whole "word". Latin text tokenizes as before. Deterministic and zero-dependency — no external segmenter, no dictionaries — so Chinese recall quality improves across the whole chain without configuration.

### Feedback learning loop

Fusion weights are no longer static between reflection runs: a **5-arm contextual bandit** (ε-greedy, per-scope-state features) adjusts the retrieval knobs — vector/keyword blend, `graphBoost`, `prf.alpha`, `prf.beta` — within fixed safety rails (±20% of defaults). It learns from **implicit engagement signals** (a hit re-retrieved later in the session, inspected via `memory_why`, forgotten, or capsule-exported) and reserves an exploration step on every 10th retrieval. The three tool channels are graded, not boolean: `memory_why` derives a rank-aware self-consistency reward (DCG-style discount by where the evidence ranks in a speculative, side-effect-free probe), query-mode capsule exports derive a score×diversity composite (entity/all exports keep full reward — bulk curation is not a ranking judgment), and `memory_forget` stays the reward-0 negative channel. These remain implicit, derived signals — there is no explicit user-rating API. All five arms act on the real retrieval pipeline; the weight-evolution audit is readable through `memory_bandit` (or reset per arm), and reflection remains the offline sanity bound.

### CRDT federation

Multi-agent palace sync is now **wired end-to-end**: store writes bridge into the CRDT federation service on `memory.after-store`, and the Lamport clock is recovered on restart so merged state survives process restarts. Items, edges, patterns and core blocks merge as LWW-Maps / OR-Sets keyed by content-hash ids over the capsule HMAC framing — no coordinator, offline agents reconcile on reconnect. On top of sync, the federation router (`memory_fed_search`) fans queries out across member palaces in parallel with per-palace circuit breakers and source-tagged hits.

Since 0.20 the palace also ships its own **built-in zero-dependency HTTP transport** (plain `node:http`, no new npm packages), so standing up a federation is four calls instead of a hand-wired channel — both server factories and both client adapters are re-exported from the services barrel:

```ts
import {
  createCrdtServer, createFederationServer, httpFederationMember, syncOverHttp,
} from '@dsh-plugins/memory-palace/services';

const fed  = createFederationServer({ member: { name: 'palace-a', retrieve: (q) => retriever.retrieve(q) }, secret }); // → { url, port, close }
const crdt = createCrdtServer({ crdt: crdtFederation, secret });                                                       // → { url, port, close }
myPalace.federationRouter.addMember(httpFederationMember(fed.url, secret, { name: 'palace-a' }));                       // remote member joins the router
await syncOverHttp(localCrdt, crdt.url, secret);                                                                       // one CRDT anti-entropy round
```

The security defaults are deliberate, not opt-in: peers authenticate with an **HMAC shared secret** (compared via `timingSafeEqual`; any missing or wrong signature is a 401 on both transports), oversized request bodies are rejected with 413, slow or dead peers are cut off by bounded timeouts, retrieval payloads cross the wire with **embeddings stripped**, and — most importantly — the default serve face is the **anonymous cascade**: only `global`-tier rows ever leave the palace through the transport, and a client-supplied scope cannot widen that face, so session/workspace/user tiers never leak via federation. Mind the shared-secret model: one secret defines one trust domain (no mTLS, node discovery or multi-hop routing) — treat it like a database password, and keep the library-level custom-channel wiring in mind for cross-trust-boundary topologies.

Intent-trajectory prediction (the session-start speculative warm-up of PPR ranks and the semantic cache) is scope-aware since 0.20: palaces running `scope: workspace` — where sessions carry no user id — now train on workspace trajectories too (userId first, workspaceId fallback), so team palaces get predictions and warm caches again instead of a silent no-op.

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

All fifteen tools are far more than thin CRUD — each carries a specialized capability:

| Tool                | Capability                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `memory_retrieve`   | **Self-query understanding** ("last week"/"最近"/"top 20"/quoted phrases are parsed automatically; temporal windows push down into SQL; entity mentions are graph-linked and boosted) + `mode:"synthesis"` clusters hits into **corroborating groups and flags contradictions** (differing version numbers, negation flips) + every hit carries a **score decomposition** (raw cosine / decay / importance / graph prior / keyword) |
| `memory_remember`   | **Write-time intelligence**: near-duplicates are detected and deduplicated (returns the existing id); conflicting memories are reported, and `supersede:true` tombstones outdated versions behind an auditable supersession chain. Dedup-vs-update is decided by similarity **and** contradiction, not similarity alone — "v16"→"v17" is an update, not a clone |
| `memory_forget`     | **Right-to-be-forgotten with safety rails**: by id, by entity (cascades to linked items + graph edges), or by semantic query; `dryRun:true` previews; deletes are soft (undo via `restore:true`) until `purge:true` hard-deletes tombstones |
| `memory_inspect`    | **Memory observability**: per-layer/space counts, graph shape, recent items — plus a health panel (signal ratio, duplication ratio, age distribution, PageRank **Gini concentration**, orphan entities) and concrete maintenance recommendations |
| `memory_graph`      | **Graph analytics**: `expand` (ranked neighborhood), `path` (shortest co-occurrence chain between two entities — "how are X and Y related?"), `communities` (**label-propagation topic clustering**, deterministic) |
| `memory_capsule_export` | Export a signed, content-addressed Memory Capsule of this palace's knowledge (HMAC tamper evidence, owner identity stripped; only memories visible to this session are exportable) |
| `memory_capsule_import` | Import a capsule from another palace: HMAC verification, deterministic-id dedupe, contradiction flagging, ownership rebinding to the importer |
| `memory_core`       | Read / edit the persistent SELF (profile, project, goals) — always injected first; versioned audit |
| `memory_sleep`      | Force a consolidation cycle now: compress + mine + core compaction, with a dream report |
| `memory_reflect`    | Self-consistency benchmark + 36-point parameter sweep; recommends a better retrieval config |
| `memory_why`        | Provenance trace — WHY the palace believes something about an entity: typed relations (direct and inferred, chains flagged with confidence), the evidence items that mention it, and where the knowledge originated |
| `memory_migrate`    | Heal embedding-space fragmentation after a provider switch: budget-bounded re-embedding of stranded old-space items into the current space (content, timestamps, visibility and flashback integrity untouched) |
| `memory_bandit`     | Inspect / control the online fusion learner: read the arm snapshot + recent rewards of the retrieval-weight bandit, or reset an arm |
| `memory_era`        | Long-horizon comprehension: query the stratification tree's week / month / era digest nodes — "what was this period about" from one bounded digest |
| `memory_fed_search` | Search across federated palaces (personal + team + project) in one call: parallel fan-out with per-palace circuit breakers, every hit tagged with its source palace |

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

Exact scan remains the correctness floor, but since 0.13 a deterministic IVF (inverted-file) index over the shared anchor-plane kernel ships built in: it engages above `retrieval.ivf.minItems` (default 2000) items per space, probes Hamming-adjacent buckets with an escalating radius, and escalates all the way to all-keys — the exact scan — when the candidate pool is not satisfied. It is a pure accelerator: recall never depends on the index, and the retrieval API is unchanged.

### Benchmarks (performance regression gate)

`npm run bench` runs four fixed benchmarks (scan exact vs IVF, int8 vs float cosine, PageRank, tokenizer) against `scripts/bench-baseline.json` — any timed metric exceeding 2× its baseline fails the run. `npm run bench:update` re-records the baseline (only after a deliberate, explained performance change); `node scripts/bench.mjs --smoke` is a 1/5-scale print-only run for CI.

## Operations

**Doctor — the `memory_inspect` integrity panel.** The store ships a structural self-audit (`integrityCheck()`), and `memory_inspect` surfaces its verdict in an `integrity` field next to the existing health metrics. Treat it like SQLite's own `PRAGMA integrity_check` for the palace: run it after a hard crash, after restoring a file by hand, or before a provider migration. Findings point at what drifted; `repairIntegrity()` then performs only conservative, provably-safe repairs — it never guesses.

**Scoped stats.** Counts follow the caller: `facade.stats(scope?)` accepts a caller scope and returns the store's scoped counts (`statsScoped(level)` — the same visibility window retrieval sees), and `memory_inspect` reports fully scoped counts, so tenant-facing observability never leaks another tenant's numbers. The unscoped `facade.stats()` remains the documented management-plane API — an ontological property of an embedded library — and it gains `stats().byTier` tenant-distribution telemetry for capacity planning. The tool layer is barred from bare `stats()` by audit check 11, and scoped-count correctness is differentially guarded against `visibleAtLevel` filtering (test/stats-scoped.test.ts; invariants I-ACL-16 / I-PO-21).

**Write-time outcome transparency.** `memory_remember` tells the model what actually happened to the write: the response carries `writeOutcome` — one of four exhaustive states (`created` / `deduplicated` / `superseded` / `conflict-flagged`) with evidence fields (`matchedId`, `similarity`, `conflictReason`), and under sparse embeddings (offline-bm25) any non-`created` outcome appends an advisory to reword genuinely-distinct facts — a prompt-level concern (D-11) promoted into a runtime feedback loop. The two write-time thresholds are configuration, not constants: `retrieval.writeDedupeThreshold` (default 0.92, the near-duplicate merge line) and `retrieval.conflictScanThreshold` (default 0.75, the conflict-scan floor), byte-identical when unset. The correctness core is pinned as invariant I-RC-14: a high-similarity new fact carrying a conflict (numeric drift, "v16"→"v17") never silently merges into a near-duplicate — it always lands as a new row on the supersede/conflict path; four-state completeness is I-PO-22 (test/write-outcome.test.ts).

**Backups.** `backupTo(path)` takes a consistent online snapshot of a live palace via SQLite `VACUUM INTO` — no read lock, safe while the palace is serving:

```ts
store.backupTo("/backups/memory-palace-2026-10-05.db");
```

**Gates.** `npm run audit` enforces release hygiene (version triple-sync across `package.json` / `plugin.json` / the source `VERSION`, the 15-tool count sync between `plugin.json`, the README tool table and the tool registry, plus repo-invariant lint rules) and `npm run bench` runs the performance benchmark suite as a regression gate. `npm run verify` chains lint + build + test + audit, so `prepublishOnly` fails on any drift before anything ships.

**Invariant catalog.** Every property these gates and the test suite watch — 86 named invariants across privacy/ACL, data integrity, retrieval contracts, numeric/text safety and protocol/operations, each mapped to its enforcement point — is cataloged in [docs/INVARIANTS.md](./docs/INVARIANTS.md). Check it before changing guarded behavior.

**Postmortem taxonomy.** The root-cause taxonomy of every finding from the hardening waves — ten classes of failure mechanism, each with its real cases, its count, and the defense layer that now watches it — lives in [docs/POSTMORTEM.md](./docs/POSTMORTEM.md). Read it before writing a fix: your bug almost certainly belongs to a known class.

**Accepted-risk decisions.** Every explicitly accepted risk and deferred finding from the audit waves — each with its rationale, residual risk and watchpoint — is logged in [docs/DECISIONS.md](./docs/DECISIONS.md).

**Multi-process deployments.** Every connection runs WAL journaling with `busy_timeout = 5000` and tuned `wal_autocheckpoint`, so several processes may open the same palace file concurrently — under write contention they queue for up to 5 s instead of failing with `SQLITE_BUSY`. The supported topology is **single writer, multiple readers**: route writes through one agent (or one gateway) and let observers, MCP mounts and cron jobs read; two concurrent writers on one file are tolerated by the timeout but throughput will suffer.

**Anonymous-write policy.** What happens when a caller with no identity writes is configured, not accidental: `scope.anonymousPolicy` selects `global` (default — zero-config compatible, byte-identical to prior behavior), `quarantine` (anonymous writes land in the `__anonymous__` session bucket, invisible to identified users) or `reject` (fail-closed refusal; the rejection is an observable business error, never a crashed handler). **Multi-tenant hosts should set `quarantine` or `reject` explicitly** — the default optimizes the single-user zero-config experience. The standalone MCP server reads the same policy from the `MEMORY_PALACE_ANON_POLICY` environment variable (invalid values warn on stderr and fall back to `global`; the effective policy prints on the startup banner). Guarded as invariant I-ACL-15.

**Admin allowlist.** Global side effects — today `memory_migrate` live runs — can be gated on identity, not just confirmation. Setting `scope.adminUserIds` (a list of userIds) makes a live migration require BOTH that the caller's userId is on the list AND the explicit `confirm: true` (a double gate); anonymous callers and non-members are refused outright, fail-closed. Unconfigured, the palace keeps the single-user trust model — `confirm` alone, byte-identical to prior behavior — so **multi-tenant hosts should set `adminUserIds` explicitly**, the same wiring responsibility as `anonymousPolicy` above (D-15 in the decision record). The standalone MCP server reads the list from the `MEMORY_PALACE_ADMIN_IDS` environment variable (empty lists and empty-string entries fail loud rather than silently disabling the gate). The concept is deliberately general: any future global-side-effect operation should sit behind this same double gate. Guarded as invariant I-PO-20.

## Migrating from 0.1.x – 0.7.x

The palace is currently at **0.24.0** (CORDIS kernel compatibility `>=0.6.0 <3.0.0`); the waves after 0.7 — inference, migration daemon, IVF, fusion learning, stratification, federation, quantization, the 0.19 correctness/feedback pass, the 0.20 self-healing/operations wave (integrity self-check, conservative repair, VACUUM INTO backups, multi-process hardening, chaos fuzz suite, bench + audit gates), the 0.21 deep-read correctness pass, the 0.22 CJK graph elevation, the 0.23 housekeeping pass, and the 0.24 type-safety elevation (strictTypeChecked + exactOptionalPropertyTypes) — are documented in [CHANGELOG.md](./CHANGELOG.md).

- 0.2: `session_id` + `embedding_space` columns; scope filtering; SQL-pushdown cosine scan; PageRank retrieval prior; runtime embedding failover; tool registration; tombstone/supersession **groundwork only** (fields kept auditable — the `deleted_at`/`superseded_by` columns and chains themselves shipped in 0.3).
- 0.3: `deleted_at` / `superseded_by` (tombstones + supersession chains); self-query understanding; consensus synthesis; dedup/conflict-aware writes; health observability; graph path/communities.
- 0.4: **visibility-tier ACL** — `visibility` (+ owner) columns on memory items, entities and graph edges; the knowledge graph is now scope-isolated; retrieval widens over tiers and anonymous callers see only `global`. PageRank became weighted + temporal + personalized (PPR), with graph-version-stamped caches. `RetrievalHit.explain` gained a graph breakdown (`graphEntity.globalRank / proximityRank`). Distillation inherits its cluster's dominant tier.
- 0.5: hardening wave — fetch timeout + breaker observability, space/owner-partitioned distillation, TTL + retention lifecycle, access-refreshed decay, visibility-checked tools, transactional two-phase ingest, procedural pattern mining, SWR rank caches.
- 0.6: **retrieval kernel v3** — pseudo-relevance feedback (Rocchio second pass), entity-anchor hop expansion, as-of flashback queries (asOfMs / memory_retrieve asOf), a deterministic semantic query cache (invalidated by the store data-version stamp), and session-start PPR warm-up. RetrieverConfig gained prf/entityHop/queryCache; hits gained via (vector | entity-hop).
- 0.7: **dimensional elevation** — Memory Capsules (inter-agent transport), reflection-based self-tuning, MCP stdio server (memory-palace-mcp); 8 tools, 2 new services.
- `retrieval.minScore` gates on **raw cosine** (pre-decay); 0.1 remains the default.
- `sqlite-vec` was removed from dependencies (it was never imported); vector search runs through the SQL-pushdown cosine scan.

## License

MIT
