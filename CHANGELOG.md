# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-10-05

- Dependency: better-sqlite3 ^11.3.0 → ^12.2.0 — v12 ships prebuilt binaries for Node 24 (ABI 137); v11 prebuilds stop at older ABIs and fall back to a node-gyp source build that fails without a toolchain. Verified end-to-end on Windows x64 + Node 24 with the full 92-test suite.
- Lockfile regenerated (also drops the stale sqlite-vec entries left over from 0.2.0).

## [0.7.0] - 2026-10-05

Dimensional elevation — the palace leaves the single-tenant, single-harness plane.

- Memory Capsules (inter-agent knowledge transport): signed (HMAC-SHA256 over canonical JSON), content-addressed bundles exported scope-bounded with owner identity stripped and imported with dedupe, contradiction flagging and importer-side ownership rebinding (utils/capsule.ts + services/memory-federation.ts + memory_capsule_export / memory_capsule_import).
- Reflection (self-improvement): a self-consistency benchmark built from stored memories sweeps a deterministic 36-point parameter grid through REAL throwaway retrievers, reporting MRR/recall@5 and a recommended retrieval.graphBoost / prf config (utils/reflection.ts + services/reflector.ts + memory_reflect).
- MCP server (ubiquity): a pure JSON-RPC 2.0 handler (src/mcp-server.ts) exposing all 8 tools via initialize / tools/list / tools/call, with a newline-delimited stdio entry point (memory-palace-mcp bin) — Claude Desktop, IDE agents and any MCP client can now mount the palace without DSH.
- New services memory-federation / memory-reflector; events memory.capsule-exported / memory.capsule-imported / memory.reflected; store.findItemIdsByContent for exact-content dedupe.
## [0.6.0] - 2026-10-05

Retrieval kernel v3 — five new capabilities on the recall path, all deterministic and zero-LLM.

- Pseudo-relevance feedback (Rocchio): the top-hit centroid is blended back into each space's query vector and the pool re-scored — vocabulary-mismatch mitigation for sparse embeddings at no API cost (retrieval.prf: enabled/alpha/beta/depth).
- Entity-anchor hop expansion: a graph-guided second pass recalls items linked to the top hits' entities that the vector gate missed (via: "entity-hop", bounded 0.55 anchor weight, scoped + asOf-aware).
- As-of flashback retrieval: asOfMs / memory_retrieve asOf reconstructs the store at a past instant using tombstone/supersession timestamps and TTL-vs-T expiry.
- Deterministic semantic query cache: anchor-bucketed, cosine-verified (≥ 0.985) near-duplicate query reuse, invalidated wholesale by the store's unified data-version stamp (PRAGMA user_version now bumped by item writes too).
- Session-start PPR warm-up: the injector pre-computes personalized PageRank for the opening intent's entities (injection.warmRanks, pure local compute).
- Shared anchor-plane kernel extracted to utils/anchors.ts (compressor + query cache); RetrievalHit.via and debug.prfApplied/entityHop/cacheHit surfaced; visibleAtLevel JS mirror of the tier ACL.
## [0.5.0] - 2026-10-05

Hardening wave — reliability, retention, and ACL audit across the ingest/compress/retrieve path, closing all 31 weaknesses found in the 0.4.0 line-by-line audit.

- Embedding gateway: fetch timeout for the DeepSeek embedding API via `AbortSignal` (15 s default) and circuit-breaker state-transition observability (open/half-open/closed transitions are now visible to the host instead of silent).
- Compressor: clustering is now space/owner-partitioned with deterministic anchor-projection (LSH-lite) bucketing, replacing the previous O(n²) pairwise-candidate scans.
- Retention: compression runs a retention pass — TTL sweep, 90-day episodic pruning, 7-day tombstone purge — and read-time TTL enforcement (`json_extract` on `expiresAt`) plus `sweepExpiredItems` as a maintenance entry point.
- Decay: access-refreshed decay uses `max(createdAt, lastAccessedAt)` as the age baseline, with bounded testing-effect reinforcement (+0.01 importance per recall, hard cap 0.95) so recalled memories strengthen without runaway feedback.
- Tools: ACL hardening — scoped `forget`/`restore`, scoped purge, redacted `apiKey` on the facade, and scoped `inspect` sampling, so no tool path can read or destroy rows outside the caller's visibility/ownership envelope.
- Ingest/retrieval: two-phase transactional ingest with batched embedding; SWR rank caches with a 500 ms staleness floor; retrieval widening gains a skip-rule for exhausted scans (no redundant re-query of an already-empty tier) and surfaces `scopeLevel` on each hit.
- Parsing: chunker strict-progress overlap cap (a chunk can never fail to advance the cursor); unit-aware numeric signatures so dates and versions stay atomic during dedup/conflict detection; Chinese negation bigram handling; temporal regex lookahead guards ("last weekly" no longer parses as "last week").
- Foundations: deterministic pattern miner (`src/utils/pattern-miner.ts`) preparing the procedural layer; per-subtest test isolation so each subtest builds its own store and cannot order-depend on its siblings.

## [0.4.0]

- Visibility-tier ACL: `visibility` (plus owner) columns on memory items, knowledge-graph entities, and graph edges — a four-tier system (`session` / `workspace` / `user` / `global`) enforced on every scoppable read and write.
- Scoped knowledge graph: a private mention creates a private entity, so one user's entities, co-occurrence edges, and PageRank never leak into another user's analytics (subgraphs, paths, communities, ranks).
- Retrieval widens cumulatively over tiers (`session → workspace → user → global`) only while the candidate pool is thin and never crosses an owner boundary; anonymous callers see the `global` tier only; `memory_remember` accepts a per-item `visibility` override.
- PageRank prior became weighted (edge mass flows by accumulated co-occurrence count), temporal (edge-weight recency half-life, `pagerankEdgeDecayDays`), and personalized (PPR teleport on query entities, blended with global rank via `personalizationWeight`).
- Rank maps are cached against the store's monotonic graph-version stamp (`PRAGMA user_version`), immune to count-collision staleness; PPR results are cached per seed-set with LRU eviction.
- `RetrievalHit.explain` gained a graph breakdown (`graphEntity.globalRank` / `proximityRank`) naming the entity that ranked each hit.
- Distillation inherits its cluster's dominant visibility tier, so compression cannot launder private memories into the global tier.

## [0.3.0]

- Tool v2: the five tools (`memory_retrieve` … `memory_graph`) were rebuilt as specialized capabilities rather than thin CRUD.
- `memory_retrieve`: self-query understanding ("last week" / "最近" / "top 20" / quoted phrases parsed automatically; temporal windows pushed down into SQL; entity mentions graph-linked and boosted) plus `mode:"synthesis"`, which clusters hits into corroborating groups and flags contradictions (differing version numbers, negation flips); every hit carries a score decomposition (raw cosine / decay / importance / graph prior / keyword).
- `memory_remember`: dedup/conflict-aware writes — near-duplicates return the existing id, conflicts are reported, and `supersede:true` tombstones outdated versions behind an auditable supersession chain; dedup-vs-update is decided by similarity and contradiction ("v16"→"v17" is an update, not a clone).
- `memory_forget`: right-to-be-forgotten with safety rails — by id, by entity (cascading to linked items and graph edges), or by semantic query; `dryRun:true` previews, deletes are soft and undoable (`restore:true`) until `purge:true` hard-deletes tombstones.
- `memory_inspect`: health observability — signal ratio, duplication ratio, age distribution, PageRank Gini concentration, orphan entities — with concrete maintenance recommendations; `memory_graph`: `path` (shortest co-occurrence chain between two entities) and `communities` (deterministic label-propagation clustering) alongside `expand`.
- Schema: `deleted_at` / `superseded_by` columns back the tombstone and supersession-chain machinery.

## [0.2.0]

- SQL-pushdown cosine scan: `mp_cosine(embedding, query)` registered as a SQLite scalar function, so scoring, ordering, and LIMIT run inside the database engine — exact search over the whole store with O(topK) JS heap and no scan caps.
- Vector-space tagging + runtime failover: vectors are tagged per provider space (`deepseek:…` / `offline-bm25:…`) and never compared across spaces; a circuit breaker opens when the embedding API is unreachable and the offline BM25-style provider takes over until recovery.
- Scope cascades: retrieval widens session → workspace → user (+global) without ever crossing into other users' memories.
- PageRank retrieval prior: incremental PageRank over the co-occurrence graph acts as a zero-mean prior — `1 + g·(p − p̄)` clamped to `[1−g, 1+g]` — boosting central-entity items without shifting score calibration; it also picks the lead entity for cold-start subgraph injection.
- Tool registration: the five `memory_*` tools are registered via the DSH TypeScript Tool Contract when the host provides `ctx.tool`; hosts without it run the plugin as services.
- Tombstones/supersession groundwork: soft-delete and supersession fields keep outdated versions auditable behind their replacements.

## [0.1.0]

- Initial release: layered long-term memory (episodic / semantic / procedural) for DeepSeek Harness agents, persisted in a single SQLite file via the Cordis kernel.
- Ingestion hooks on `message.user` / `message.assistant` / `tool.*` events; chunking of long messages respects markdown structure (headings, code fences via a fence-state machine) with exact source offsets on every chunk.
- Embedding of chunks through the DeepSeek Embedding API.
- Entity extraction (paths, URLs, `@mentions`, identifiers, capitalized terms) with provenance hints (`@alice` → person, `src/app.ts` → file), feeding a co-occurrence knowledge graph linked to semantic items.
- Compression pass: eviction of low-importance aged items plus distillation of related items, optionally through an LLM summarize callback.
- Scoped context injection at `session.start`, so the agent opens with what it already knows about the caller.
