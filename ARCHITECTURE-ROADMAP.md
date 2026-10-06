# Architecture Roadmap — Frontier Upgrades, Innovation Plans & Returns

> Baseline: v0.10.0 — 10,435 lines, 11 tools, 12 services, 118 tests (real execution),
> ESLint(type-checked)+strict-tsc zero findings, 93.9% line coverage, dist shipping
> DSH plugin + MCP server + CLI. Every plan below is grounded in THIS codebase's
> actual modules and verified behaviors.

> **v0.20.0 status: operations wave delivered — self-healing / durability /
> chaos-suite / bench gate.** Beyond the planned initiatives above, the store
> gained a structural self-audit (`integrityCheck`) with conservative
> self-repair (`repairIntegrity`), online `backupTo` backups via SQLite
> `VACUUM INTO`, multi-process hardening (WAL + `busy_timeout = 5000` +
> `wal_autocheckpoint`), a pipeline-level chaos fuzz suite with invariant
> monitoring, and CI gates: the performance benchmark (`npm run bench`) and
> the audit-inclusive `verify` chain on a Node 22/24 matrix. See the
> CHANGELOG [0.20.0] entry for detail.

---

## P0 — Scale Frontier

### 1. Deterministic IVF Vector Index (native ANN, zero dependencies) — **DELIVERED v0.13.0** (fixed-plane bucketing instead of k-means; see CHANGELOG entry [0.13.0] for the honest deviation note)

**Problem.** Retrieval is exact linear scan via `mp_cosine` SQL pushdown
(`memory-store.ts: scanBySimilarity`). Measured honest at 10k items (~25ms p50);
at 100k+ items it degrades linearly and dominates latency.

**Innovation.** Promote the existing anchor-plane kernel (`utils/anchors.ts`, already
shared by compressor + query cache) into a **persistent IVF partition table**:
`vec_buckets(space, bucket_key, item_id)` maintained transactionally inside
`ingestTx`; queries embed once, probe the query's bucket + Hamming-1 neighbors
(already implemented as `neighborKeys`) + a deterministic residual scan of the
remaining buckets' centroids, guaranteeing **exact-recall fallback** (the index is a
pure accelerator — recall never depends on it, mirroring the SQL-pushdown
philosophy). Bucket rebalance is a sleep-cycle phase (k-means over anchor
projections, bounded iterations, deterministic seeds).

**Returns.**
- 100k items: p50 250ms → **~15–30ms** (probe ≈ n/16 buckets), p99 950ms → <100ms
- Enables the 1M-item "team palace" tier on the same SQLite file
- Zero new native deps (no sqlite-vec); correctness identical by construction

**Cost / Risk.** M-size: bucket table + write-path hook + sleep rebalance + fallback
probe logic. Risk: stale buckets after bulk import → mitigated by rebuild-on-version.

**Acceptance.** Recall@10 == exact scan on a 50k synthetic corpus (property test);
p50/p99 benchmarks in CI.

---

### 2. Embedding-Space Migration Daemon (re-index on provider change) — **DELIVERED v0.11.0**

**Problem.** Vector spaces are tagged and never cross-compared (correct), but a
provider switch (deepseek → offline failover ≥ cooldown, or model upgrade) leaves
old-space items **permanently invisible to retrieval** until re-ingested. This is
the known honesty gap from v0.2, still unfixed at the architecture level.

**Innovation.** `SpaceMigrator` service: background, budget-bounded (N items /
tick, circuit-breaker-aware — only re-embeds while the primary provider is healthy),
transactional per batch. Items are re-embedded into the active space, old vector
replaced atomically inside `ingestTx` with a `migratedFrom` audit field; flashback
integrity preserved (content and timestamps unchanged — only the vector moves).

**Returns.**
- Eliminates the largest silent-failure mode in the system (retrieval zeroes after
  failover windows)
- Unlocks model upgrades without palace rebuilds (one overnight migration)
- Closes the last documented TODO from the 0.2.0 era

**Cost / Risk.** S-size (all primitives exist: breaker, ingestTx, space tags).
Risk: API cost during migration → capped by per-tick budget + degraded-skip.

**Acceptance.** Integration test: two-space store → migrator runs → single-space
retrieval returns previously invisible items; flashback unchanged.

---

## P1 — Multi-Agent Frontier

### 3. CRDT Federation (multi-master palace sync) — **DELIVERED v0.16.0**

**Problem.** Capsules (v0.7) are one-shot, single-direction handoff. Real teams
need **multi-device / multi-agent shared palaces**: concurrent writes, offline
agents, merge without a coordinator.

**Innovation.** Items/edges/patterns/core-blocks become CRDT entities:
- items & core blocks: **LWW-Map** keyed by content-hash id (capsule ids already
  are content-addressed — the merge key exists), timestamp = (lamport, palaceId)
- tags/entities: **OR-Sets** (add wins, tombstoned remove reuses the existing
  tombstone machinery)
- supersession chains: causal-DAG merge (chain heads win; conflicting heads
  surface through the existing consensus/contradiction detector)
Transport reuses capsules' HMAC + canonical-JSON framing; sync = three-way
capsule exchange with a `MergePlan` that extends `planImport` to CRDT semantics.

**Returns.**
- Team palace: N agents share one memory with per-user ACL intact (tiers are
  preserved through merge — visibility is part of the LWW payload)
- Offline-first agents (laptop/CI robot) reconcile on reconnect
- Turns the capsule format into a **wire protocol** — one format, handoff AND sync

**Cost / Risk.** L-size (semantics design + extensive property tests). Risk:
conflict storms → bounded by contradiction dampening already in the graph.

**Acceptance.** Property test: N=3 palaces, randomized concurrent ops, converge to
identical state (strong eventual consistency) across all interleavings.

> **v0.19.0 status: wired end-to-end.** The service is bridged to the store —
> writes feed CRDT state on `memory.after-store` — and the Lamport clock is
> recovered on restart, so merged state survives process restarts. orTag uses
> `@`-separated tags with value-level fingerprints.

---

### 4. Federation Router (query fan-out across palaces) — **DELIVERED v0.17.0**

**Problem.** Even with sync, an agent may hold personal + team + project palaces;
every query must currently hit one store.

**Innovation.** `FederatedRetriever` implements the same `retrieve()` contract but
fans out to N palace connections (local store + MCP-remote palaces), merges with
the existing MMR (cross-palace diversity for free), and tags every hit with its
source palace — `explain` gains a `palace` field. Scope ACL evaluated per-palace.

**Returns.** Org-scale memory without a monolithic store; per-palace sovereignty
(ACL, retention, core SELF stay local). Composite answers cite their palace.

**Cost / Risk.** M-size. Risk: latency fan-out → parallel probes + per-palace
timeouts riding the circuit-breaker pattern.

**Acceptance.** Integration: 2 palaces, disjoint knowledge, one federated query
returns merged ranked hits with correct provenance.

---

## P2 — Cognition Frontier

### 5. Feedback-Closed Fusion Learning (online retrieval tuning) — **DELIVERED v0.14.0**

**Problem.** Reflection (v0.7) recommends configs offline via a grid sweep; fusion
weights (0.7 vector / 0.3 keyword, graphBoost, PRF α/β) are static between runs.

**Innovation.** Every retrieval already records telemetry (`touchAccess`,
`memory.after-retrieve`). Close the loop: a bounded **contextual bandit**
(ε-greedy, per-scope-state features: layer mix, pool size, has-seeds) nudges one
fusion knob per query within safety rails (±20% of defaults), learning from
implicit feedback (hit re-retrieved within session / item accessed by a tool call
= reward). Full audit log of weight evolution; reflection remains the offline
sanity bound (bandit weights clamped into the reflected optimum's neighborhood).

**Returns.**
- Retrieval quality adapts per-user without host intervention (measurable via
  reflection MRR delta before/after enabling)
- Eliminates hand-tuning folklore with an evidence trail

**Cost / Risk.** M-size. Risk: feedback loops (popular items reinforced) →
bounded rails + decay on reward history + the existing importance cap.

**Acceptance.** A/B in the reflection harness: bandit-tuned ≥ static config MRR
on replayed sessions, with weight drift inside rails.

> **v0.19.0 status: loop fully closed.** All 5 bandit arms act on the real
> retrieval pipeline (graphBoost / prfAlpha / prfBeta wired through alongside
> the vector/keyword blend), implicit engagement signals (re-retrieval,
> `memory_why`, forget, capsule export) feed the reward, and every 10th
> retrieval takes an exploration step.

---

### 6. Hierarchical Summarization Tree (hippocampus → neocortex) — **DELIVERED v0.15.0**

**Problem.** Distillation merges flat clusters; a 2-year-old palace has no
"era view" — long-horizon questions ("what did we believe in Q2?") rely on
flashback scans, not comprehension.

**Innovation.** Sleep gains a `stratify` phase: session summaries → weekly →
monthly → era nodes, each a deterministic extractive synthesis (the core-memory
compaction kernel, reused at tree scale) linked to children via a `part-of`
typed edge — the inference engine (v0.10) then reasons across levels for free.
Drill-down = `memory_why` on a tree node.

**Returns.** Constant-size era context regardless of age; "what changed between
eras" becomes a subgraph diff; cold-start injection picks the right resolution
(intent matches era → inject era node + top children).

**Cost / Risk.** M-size (kernel reuse makes this cheap). Risk: summary staleness
→ re-stratification rides every sleep.

**Acceptance.** Synthetic 6-month palace: era query answered from ≤3 tree nodes;
flashback equivalence on ground-truth checks.

---

### 7. Intent-Trajectory Prefetch (speculative warmth) — **DELIVERED v0.12.0**

**Problem.** Session-start warms PPR for the opening intent (v0.6) but not the
FOLLOW-UP queries the session will actually ask.

**Innovation.** `IntentPredictor`: Markov chain over past sessions' query
sequences (entity-tuple states, per-scope), stored as a procedural pattern
(pattern-mining infrastructure reused). At session start, prefetch the top-3
predicted follow-ups' PPR ranks + semantic-cache entries — pure local compute.

**Returns.** Perceived latency drop on 2nd/3rd queries (warm caches); the palace
"knows where the conversation is going".

**Cost / Risk.** S-size. Risk: prediction waste → bounded by pattern confidence.

**Acceptance.** Replay benchmark: ≥40% of follow-up queries hit warm PPR/cache.

---

## P3 — Efficiency Frontier

### 8. Int8 Vector Quantization (halve storage, ~2–4× scan) — **DELIVERED v0.18.0**

**Innovation.** Store embeddings quantized (per-space scale vector + int8 payloads);
`mp_cosine` gains an int8 dot-product path; exact top-K on int8, then re-rank the
top 64 against full-precision vectors kept only for core/anchored items — or
accept quantized-final (bounded error, measured in the property suite).

**Returns.** DB size −50%+; scan throughput ×2–4; pairs naturally with the IVF
index (P0.1).

**Cost / Risk.** M-size. Risk: recall degradation → measured against exact scan
in the same property harness; migration via the SpaceMigrator (P0.2).

---

## Priority Matrix (ROI = Δcapability × reach ÷ cost)

| # | Upgrade | Cost | Benefit horizon | ROI |
|---|---------|------|-----------------|-----|
| 2 | Space Migration Daemon | S | immediate honesty win | ★★★★★ |
| 7 | Intent Prefetch | S | latency, 1 sprint | ★★★★ |
| 1 | Deterministic IVF | M | scale tier unlock | ★★★★ |
| 5 | Bandit Fusion Learning | M | per-user quality | ★★★★ |
| 6 | Summarization Tree | M | long-horizon coherence | ★★★☆ |
| 8 | Int8 Quantization | M | efficiency ×2–4 | ★★★ |
| 4 | Federation Router | M | multi-palace org | ★★★ |
| 3 | CRDT Federation | L | multi-agent teams | ★★★ (strategic) |

**ALL 8 INITIATIVES DELIVERED (v0.11–v0.18).** Original sequence: ~~P0.2~~ ✅ (v0.11.0) → ~~P2.7~~ ✅ (v0.12.0) → ~~P0.1~~ ✅ (v0.13.0) → ~~P2.5~~ ✅ (v0.14.0) → ~~P2.6~~ ✅ (v0.15.0) → ~~P1.3~~ ✅ (v0.16.0) / ~~P1.4~~ ✅ (v0.17.0) → P3.8.
Each phase ships behind the existing quadruple gate (ESLint / strict-tsc /
full suite / property tests) with its acceptance criteria wired as tests.

---

*Grounding note: every "already exists" reference above was verified against the
v0.10.0 tree (anchors kernel, planImport, tombstones, pattern mining, sleep
phases, reflection harness, telemetry events). No plan item depends on
infrastructure that is not already green in CI.*
