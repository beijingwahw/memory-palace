# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.24.0] - 2026-10-06

Type-safety elevation — the static tier moves from `recommendedTypeChecked` to `strictTypeChecked`, and the compiler gains its four strictest remaining switches. Nothing behavioral ships in this release by design: the full test suite and audit gates run unchanged and green.

### Changed

- **ESLint src tier: recommendedTypeChecked → strictTypeChecked** — the strictest type-aware preset: `no-non-null-assertion` (narrow, or route impossible cases through the always-on `invariant()` guard), `no-unnecessary-condition`, `no-confusing-void-expression`, deprecated-call policing, `no-misused-spread`, `restrict-plus-operands`, `restrict-template-expressions` (configured to allow number/boolean — the rule targets null/undefined/objects interpolating as `"undefined"`/`"[object Object]"`). **src/bin joins the full strict tier** (it previously exempted the `any`/unsafe-* family; only `no-console` stays off there). Tests keep the documented fixture-hostile relaxations, now explicitly listing every exempted strict-tier rule (regression fixtures assert presence with `!`, deliberately double-check, interpolate loosely typed values, and pin deprecated APIs on purpose).
- **tsconfig**: `exactOptionalPropertyTypes` (optional properties can no longer be assigned explicit `undefined` — "absent" vs "present-undefined" is now a type-level distinction across the codebase), `verbatimModuleSyntax` (landed with **zero** violations — the tree was already `import type`-clean), `noUnusedLocals` / `noUnusedParameters` (dead code is a compile error, not an audit-afterthought — generalizing the dead-field class cleaned up by hand in 0.23).
- **~340 strict-tier + 113 compiler violations fixed across src**, all type-level rewrites with byte-identical behavior: local narrowing replaces ~150 `!` assertions (~30 of them converted to `invariant()` contract guards that fail loudly instead of silently), `prop: x ?? undefined` bindings became order-preserving conditional spreads, `capsule.ts` parses untrusted JSON through typed `unknown` wire views instead of inline coercion, and deprecated store reads migrated to scoped equivalents where semantics allowed — notably `ingestEntities` now builds its id→name map inline instead of N deprecated `getEntity` point reads. ~20 justified inline `no-deprecated` disables remain where every scoped equivalent is name-keyed and the call is id-keyed or admin-plane (each carries its reason in place).
- docs/INVARIANTS.md gate map: the type-level gate row now names the strict tier and the four new compiler switches.

## [0.23.0] - 2026-10-06

Housekeeping pass — every remaining minor quirk from the line-by-line deep read is either fixed below or explicitly documented as an accepted design decision.

### Fixed

- The mid-session core-compaction fire-and-forget can never become an unhandled rejection (`Promise.resolve` wrap — `compactAll` is synchronous today, a throw lands in the tick's catch; a future async version is also covered).
- `ingestEntities`' dead `_itemId` parameter removed across all call sites (per-source backlinks have always lived in `item.entityId` + `metadata.entities`).
- PPR seed miss now degrades honestly: when none of the boosted seed entities exist in the scoped graph, the prior blends pure global PageRank and `explain` reports no `proximityRank` (previously the "personalized" half was uniform-teleport global PR wearing a misleading proximity number).
- Entity linking is word-boundary aware for ASCII names — a short entity like "May" no longer links into "may be" (CJK names keep substring matching, which is already boundary-safe).
- `truncateText` is code-point safe (no more lone surrogates when truncating emoji / extension-plane Han) with a defined `n <= 0` edge.
- `formatAsContext` skips oversized hits and keeps packing smaller successors instead of aborting the whole walk at the first overflow.
- `core_history` audit rows are immutable: re-archiving the same `(block_id, version)` is now `ON CONFLICT DO NOTHING` instead of `INSERT OR REPLACE` (a version rollback can no longer silently rewrite history); regression-pinned in genesis-store.
- The deprecated `deleteEntityCascade` no longer bumps the graph version when the entity doesn't exist (parity with the scoped variant); the store's dead `dims`/`scope` fields and the no-op `foreign_keys` PRAGMA (the schema deliberately declares no FKs — integrity is `integrityCheck`'s job) are gone.
- CRDT HTTP client caps response bodies at 64 MiB (content-length precheck + streamed counting) and destroys the socket after a streamed 413; the endpoint watermark key now includes the URL path prefix and IPv6 brackets (old keys miss once and fall back to a safe full resync).
- `reviveHit` throws on malformed federation embeddings (non-numeric entries, non-array) instead of silently trimming dimensions; the dead hex-decode try/catch is removed; `FederationServer` exposes a `transportErrors()` counter.
- `planImport` counts intra-capsule duplicates in a new optional `intraCapsuleDuplicates` field instead of silently dropping them; the misleading `conflictOnly` doc comment is corrected.
- The PageRank kernel defends itself against non-finite edge weights and edges referencing unknown nodes (mass can no longer be poisoned — property-tested); `buildAdjacency` drops self-loops (parity with communities, D-13); consensus `similarity` falls back to token-Jaccard on dimension mismatch (parity with fed-merge — a 0 score for incomparable vectors was a false "maximally different").
- The semantic query cache stores a defensive copy of the query vector (a reused caller buffer can no longer poison cached entries).
- `palace-cli` closes its store in `finally` for all three commands (a mid-ingest JSON crash used to leak the WAL handle — the regression test asserts the `-wal` file is gone after a crashed run).
- `facade.remember` accepts an explicit caller identity (`{ userId, workspaceId, sessionId, tags, importance }`) — programmatic callers were previously forced down the anonymous-write path, asymmetric with `facade.retrieve`.
- The stratifier now feeds graph-hot entities into `buildTree` (the `+0.15` line-salience bonus existed in the kernel but was never wired at the service layer).
- `CompressionReportWithRetention` is now a pure type alias (its four fields have lived in `types/index.ts` since 0.20); the injector's doubly-named `patternTokens` bucket is renamed `extrasTokens`; a dead `?? {}` guard and a redundant asOf `undefined` check are gone; a misplaced mid-file import moved to the top.

### Documented (accepted design decisions, now pinned in comments)

- PRF threshold softening: `minScore` gates the pre-PRF raw cosine by design; the PRF re-score does not re-filter the pool — do not "fix".
- `listCrdtOps(sinceCounter)`'s global-counter semantics remain for compatibility (per-replica watermarks are the correct path).

### Changed

- Version triple-sync to 0.23.0; POSTMORTEM's retired-decision count corrected (D-11 was missing) with a pointer that INVARIANTS' live count (90) supersedes its 0.20 snapshot.

## [0.22.0] - 2026-10-06

CJK graph elevation — Chinese conversations get a real knowledge graph (DECISIONS D-16).

### Added

- **CJK multi-signal entity extraction** (`memory-graph.extract`): Chinese conversations previously minted entities only via paths/URLs/@mentions/hashtags — bare Chinese nouns never became entities, leaving the co-occurrence graph, PageRank prior, entity-hop recall and `memory_why` sparse; and CN typed-relation connectors (依赖 / 部署在 / 使用 / …) never fired because their input is the entity list, so nightly transitive inference was dark on Chinese graphs. Three precision-tiered deterministic signals now feed a dedicated CJK channel (own sub-quota of 8 within the 32-message cap, so statistical candidates can never crowd out provenance-backed naturals):
  - **Quoted spans** — 「」『』【】“” contents (2–8 chars): the user's own term marking, highest precision.
  - **System-noun suffix anchoring** — ~48 curated domain suffixes (数据库 / 服务 / 集群 / 网关 / 计划 / …) matched longest-first, accepted only at noun-phrase-final position (run end, glue, or a connector follows — 告警 no longer leaks out of 告警服务), with a ≤5-char left walk that stops at clause glue or a **connector string**: 依赖 / 部署在 / 使用 are exactly the boundaries between two entity mentions, so 告警服务依赖时序数据库 yields both terms and nothing between them.
  - **Exact maximal repeats** — a 2–6 char Han span occurring ≥2 times in the message, glue-free, kept only in maximal form (a recurring 告警服务 suppresses its own substrings).
  All candidates pass a CJK stopword gate; **pure-ASCII text takes none of these paths — English extraction is byte-identical** (regression-pinned). The `project`-suffix classify rule additionally accepts Han compounds (`数据迁移项目` was always 'concept' before — a latent pre-existing gap surfaced by this work and fixed alongside).
- End-to-end effect, regression-pinned: a Chinese message now mints entities **and** CN connector sentences produce typed edges (`告警服务依赖 Kafka` → depends-on), re-enabling PageRank personalization, entity-hop recall and nightly inference for Chinese sessions.

### Changed

- Version triple-sync to 0.22.0 (package.json / plugin.json / src `VERSION`).
- docs/INVARIANTS.md grows 89 → 90 entries (new I-RC-16: CJK multi-signal gate, sub-quota, English-path invariance); docs/DECISIONS.md gains D-16 (design rationale, residual risks — middling recall for unquoted/suffix-less/single-occurrence terms is the accepted cost of a dictionary-free, noise-free graph).

## [0.21.0] - 2026-10-06

Correctness pass from a full-codebase line-by-line deep read — every fix below landed with its own regression test, and the invariant catalog grew 86 → 89 entries.

### Fixed

- Speculative warm-up now lands in the partition production reads actually hit: the `session.start` prefetch carries the fusion learner's greedy `fusionOverrides` (shape parity with `memory_retrieve` — the query-cache paramsKey includes `stableFusionKey`). Previously the warmed entry sat in a `fusionOverrides=undefined` partition that real queries — which always carry overrides while fusion learning is enabled — could never hit; the warm-up was pure wasted embedding calls. Every-10th-retrieval exploration steps intentionally keep their own partition.
- Bandit persistence is kind-namespaced (`user:<id>` / `workspace:<id>`): a userId and a workspaceId that share the same string no longer overwrite each other's persisted arm rows. The in-memory FeedbackLearner already namespaced; the durable `bandit_state` rows now match. Pre-0.21 bare-id rows orphan once on upgrade (arms re-seed from defaults; the reward journal is untouched).
- The store fails loud on quantization-mode mismatch: opening a database written in one mode with the other (`retrieval.quantization` int8 ⇄ float32) throws at construction instead of silently misinterpreting every embedding blob at the wrong byte width. Databases carry a `quantization` meta stamp from first open; pre-0.21 databases stamp on their first re-open under this version (the historical mode of an unstamped file is unknowable — the guard protects future switches).
- Capsule signatures are normalization-insensitive: `signCapsule`/`verifyCapsule` now compute over the same view `parseCapsule` normalizes to (missing per-item `tags`/`entities` and top-level `patterns` filled with `[]`), so third-party exporters that sign capsules with omitted optional fields verify after import instead of failing with a misleading "tampered?" error. Field-complete capsules sign to identical bytes — every pre-0.21 signature still verifies.
- Distillation inherits the cluster's NARROWEST visibility tier, and the distill partition key no longer includes the tier — same-owner near-duplicates written at different tiers now actually merge, at the narrowest one. Previously the partition split by tier (mixed-tier clusters were unreachable) while the merge code claimed plurality-based inheritance that could have widened private rows to global had they ever met. Pattern mining keeps the tier-scoped partition (a mixed-tier mining group could stamp private patterns `global`, which would widen). The merged item's `entityId` now follows the tier representative instead of `members[0]`.
- Content-dedupe probes honor TTL: `findItemIdsByContentScoped` / `findItemIdsByContentContaining` filter on LIVE + UNEXPIRED like every read path — an expired-but-unswept row no longer suppresses capsule-import dedupe or inferencer deduplication.
- The `graphBoost` fusion override goes through `ARM_RAILS` like the other four arms — it previously bypassed the rails and relied on the wider [0, 0.5] clamp inside `buildRetrievalPrior`, leaving a 0.25–0.4 dead zone the bandit could never learn but a bare caller could deliver.
- Federation member clients preserve reverse-proxy path prefixes (parity with the CRDT endpoint, which already kept them) and gain an opt-in `includeEmbeddings` option — cross-palace vector MMR no longer requires a hand-rolled fetch.
- `palace-cli query --explain` no longer swallows the first query word: only value flags (`--db`, `--user`, `--topk`) consume the following token.
- `MEMORY_PALACE_SCOPE` no longer accepts `global` — it is a visibility tier, not a home `MemoryScopeKind`; invalid values keep warning and falling back to `user`.
- The reflector locates the current sweep when the config carries more than three decimals (`keyOf` now normalizes with the same `toFixed(3)` as the grid), instead of silently reporting the most aggressive grid point as "current".
- `memory_remember`'s returns schema declares the `similarTo` field it has always returned.

### Changed

- Version triple-sync to 0.21.0 (package.json / plugin.json / src `VERSION`).
- docs/INVARIANTS.md: I-ACL-10 tightened to narrowest-tier inheritance; new I-DI-22 (quantization-mode guard), I-DI-23 (capsule signature normalization-blindness) and I-RC-15 (speculative warm-up shape parity).

## [0.20.0] - 2026-10-05

Operations & durability pass — the palace becomes self-diagnosing, self-healing, replay-resistant and continuously gated.

### Fixed

- Intent prediction no longer silently disables itself on workspace-scoped palaces: trajectory reads go through the new scope-aware `listRecentTrajectoriesFor` (userId first, workspaceId fallback), so sessions carrying no user id regain Markov prediction and speculative PPR/cache warm-up. Previously a workspace palace trained on an empty trajectory set — no predictions, no error, no way to notice.

### Fixed (post-audit)

Post-0.20.0 witch-hunt hardening round; version unchanged. Highlights:

- `memory_forget` purge mode honors `dryRun` (`wouldPurge` preview, nothing deleted) — the only irreversible branch was the only one that ignored the flag.
- `memory_era` refuses anonymous callers instead of returning the shared null-owner timeline digest bucket to anyone.
- Capsule imports land at the tier resolved by `resolveWriteTier` — the ghost-row class (visibility='user' with a NULL owner, invisible to every cascade level forever) is eradicated; entity/item/pattern writes share one `ingestTx`, and wire-supplied item fields (layer, importance range, tags/entities arrays, blank content) are validated in `parseCapsule` with per-item error ids.
- Core-block same-name ambiguity resolved narrowest-tier-first: reads shadow the anonymous global block with the caller's own, and set/append only ever rewrite the caller's own-layer block (minting a new one when absent) — user A's self-edit no longer lands on a shared global block.
- Stratifier digests exclude prior `stratified` items from their own input, ending the summary-of-summary prefix nesting, and are stamped source `system` so derived rows stay distinguishable and out of user-write bridges.
- CRDT sync computes the Lamport ceiling with a reducer instead of `Math.max(...spread)` — 125k-op syncs no longer blow the call stack; the plugin's CRDT mirror also excludes derived/legacy inferred entries.
- MCP stdio writes chunk payloads over 64 KB with `setImmediate` yields (surrogate-pair-safe), so a giant synchronous pipe write can no longer starve the 5s hard-exit timer into a zombie process on Windows.
- NaN/Infinity numeric inputs (topK, minScore, budget, era windows, fed-search topK, CLI `--topk`) fall back to defaults before the clamp chain instead of surfacing as SQL datatype mismatches; `memory_graph` expand defaults hops to 3 (schema value, was 1); `memory_bandit` reset validates the arm name; the CLI strips UTF-8 BOMs from ingested exports.
- `tool.call`/`tool.result` events carry the caller's scope into the ingestor (failed-tool result text no longer distills into the anonymous global tier); blank message payloads are dropped at the event boundary.
- Import planning probes run `speculative` (no access-count/trajectory pollution), capsule items missing embeddings are backfilled through the embedding gateway with reported degradation warnings, and audit/bench scripts resolve repo paths via `fileURLToPath` (space/non-ASCII checkout paths) with `xit(`/`xdescribe(` skip-prefix detection added to the audit gate.

### Verification elevation

- The 0.20.0 hardening closes with a verification-elevation pass: an exhaustive ACL truth-table suite (every caller identity × every row × every layer), physical error injection (disk/pipe/SQLite failures), metamorphic relation tests, and the chaos fuzz driver gaining multi-seed runs with a shrinker — landing with 0.20.0 alongside this entry. The five waves of bug knowledge are elevated into `docs/INVARIANTS.md`, a 60-entry named-invariant → enforcement-point matrix (with a gate map and a contributor workflow for registering new invariants) that future changes can consult before touching guarded behavior.
- A standing ghost-row self-check lands alongside this entry (in parallel): the post-audit eradication of `visibility='user'`-with-NULL-owner rows is guarded as a permanent regression, so the class stays eradicated.
- The release-hygiene audit grows from 6 to 11 tripwires (checks 7–11 landing in parallel with this entry).
- The five waves of findings are also elevated into `docs/POSTMORTEM.md` — a root-cause taxonomy mapping every confirmed bug to its failure class (identity propagation, dual-implementation drift, cache-key discipline, …), the guard layer that now watches each class, and what each layer honestly costs.

### Deferred findings retired

Twelve accepted risks from the decision record are retired this release — each flipped to "mitigated" (or eliminated) in `docs/DECISIONS.md` (full rationale, residual risk and watchpoints on file there):

- **D-01**: scoped observability becomes the first-class path — `store.statsScoped(level)` five scoped counts, a `facade.stats(scope?)` overload, a fully-scoped `memory_inspect` and `stats().byTier` tenant-distribution telemetry, with audit check 11 barring bare `stats()` from the tool layer — see "Scoped observability" below.
- **D-02**: capsule content addressing retired all the way to a cryptographic CAS — 128-bit truncated SHA-256 with all three id generations import-compatible (see "Cryptographic content addressing" below), so existing capsules never expire.
- **D-03**: the three implicit feedback channels (why / capsule export / forget) now carry graded, rank- and diversity-aware rewards instead of constants — see "Feedback signals made informative" below.
- **D-04**: `memory_migrate` live runs now require an explicit `confirm: true`; `dryRun` fragmentation previews stay free.
- **D-05**: `metadata.visibility` is no longer persisted — the `visibility` column is the single write-side source of truth (legacy rows remain read-side compatible via the vote chain).
- **D-06**: a built-in zero-dependency HTTP federation transport ships with this release — see "Built-in zero-dependency federation transport" below.
- **D-08**: the 32-bit `user_version` wrap no longer admits even a theoretical false-freshness window — version stamps become epoch-namespaced composite strings (see "Epoch-namespaced version stamps" below).
- **D-10**: semantic query-cache lookup gains a capacity-bounded full fallback scan — hit sufficiency no longer depends on anchor-bucket geometry (threshold-verified, miss-is-safe unchanged).
- **D-11**: write-time outcomes become transparent and tunable — `memory_remember` returns a four-state `writeOutcome` with evidence fields and a sparse-embedding advisory, the two thresholds become `retrieval.writeDedupeThreshold` / `retrieval.conflictScanThreshold`, and numeric-drift facts are pinned to the supersede/conflict path — see "Write-time outcome transparency" below.
- **D-12**: owner partition keys join with `\u0000` (a code point unforgeable in ids) instead of `|`; the pipe-joined pattern-id format stays stable so persisted ids don't churn.
- **D-13**: community cohesion statistics exclude self-loops — clustering output unchanged, inflated readings gone.
- **D-14**: `listEdgesScoped` display paths default to a 10000-edge limit; the PageRank path stays unbounded with zero result drift (mass conservation requires the full edge set).

### Cryptographic content addressing

- Capsule item ids are now 128-bit truncated SHA-256 content addresses (`cap:` + 32 hex, minted by `capsuleItemId`): the 50% birthday bound moves to ~2^64 ≈ 1.8×10^19 items, and — unlike the FNV family — SHA-256 resists deliberately constructed collisions, which matters because capsules travel an untrusted cross-agent channel where a hostile exporter can grind offline. Standard CAS discipline (git/Nix-style), zero new dependencies (`node:crypto`); D-02 flips to "eliminated (0.20.0)".
- `parseCapsule` dispatches id validation by hex length — 8-hex v1 / 16-hex v2 / 32-hex v3, each recomputed by its own generation's algorithm; anything else is rejected with all three expected formats named. After per-item validation it runs a fail-loud collision tripwire (`assertNoAddressCollisions`, exported for direct testing): two items sharing an id over different normalized content throw `[capsule] content-address collision detected` — mathematically reachable only through a genuine same-generation digest collision (for v3, only if the hash is broken; a deliberately ground 32-bit FNV collision among legacy items is the realistic trigger, and that is exactly when forensics beats silent wrong dedupe).
- Parsed capsules carry `legacyAddressCount` (8/16-hex item count) — an observation hook for a re-export hint, excluded from the HMAC canonical form so signing/verification is unaffected. Guarded as I-DI-20 (test/capsule-cas.test.ts: v3 determinism, three-generation coexistence, tripwire driven directly and through `parseCapsule` with a real v1 birthday collision, generational separation, 1 MiB performance anchor).

### Zero-LLM quality ceiling raised

- The deterministic path concedes less quality to LLM-backed pipelines. Retrieval-time lexical matching now folds English inflections through a lightweight deterministic stemmer (deploy ↔ deploys/deploys ↔ deployed, run ↔ running, studies → study): the keyword rerank compares in stem space while tokenize, the offline BM25 hash and every embedding input stay raw-domain, and the query-cache paramsKey gains a stem-ruleset version constant so rule changes can never cross-serve cached answers.
- Distillation and the stratified tree are lifted in parallel by the extractive summarization kernel (extractive digests, still zero-LLM).
- D-07 flips to "mitigated (partial)" in `docs/DECISIONS.md` — semantic-level rewriting still needs the optional `summarize` hook.

### Feedback signals made informative

- The three implicit feedback channels no longer feed the fusion bandit constant rewards. `memory_why` derives a DCG-flavored self-consistency reward — `1/log₂(rank+2)` by where the evidence items rank in a speculative, side-effect-free probe of the entity name. `memory_capsule_export` in query mode derives a score×diversity composite (`0.6·avgScore + 0.4·diversity`); entity/all exports keep reward 1 — bulk curation is not a ranking judgment. `memory_forget` keeps its reward-0 negative channel, so the bandit learns in both directions again.
- Guarded as new invariants I-RC-13 (derived rewards must vary with ranking quality) and I-PO-18 (explicit rewards: finite numbers via clamp01, NaN writes nothing) — test/feedback-signals.test.ts + test/feedback-bandit.test.ts; D-03 flips to "mitigated" in `docs/DECISIONS.md`.
- The signals remain implicit and derived — there is still no explicit user-rating API.

### Built-in zero-dependency federation transport

- Federation retrieval and CRDT sync no longer require the host to wire a transport by hand. `createFederationServer({ member, secret, serveScope?, host?, port? })` exposes any retrieve-contract member over HTTP and `httpFederationMember(url, secret, { name?, timeoutMs? })` is its peer client adapter — a `PalaceMember` you `addMember` straight into a `FederatedRetriever`; `createCrdtServer({ crdt, secret })` plus `syncOverHttp(local, url, secret)` lift CRDT anti-entropy onto the network with the incremental-watermark exchange intact. Built on `node:http` with zero new dependencies, re-exported through the services barrel (the library-level custom-channel wiring remains a legal topology).
- Security defaults are built in, not opt-in: HMAC peer authentication compared with `timingSafeEqual` (missing/wrong signature → 401 on both transports), a request-size guard (413), bounded timeouts so a slow or dead peer can never stall a round, and retrieval payloads shipping with embeddings stripped by default.
- The default serve face is the anonymous cascade — only the `global` tier ever crosses the wire, and a client-supplied scope cannot widen it, so private tiers (session/workspace/user) never leave the palace through the transport.
- Guarded as new invariants I-ACL-14, I-PO-19 and I-DI-19 — test/transport-http.test.ts, test/transport-crdt.test.ts and the dual-palace real-HTTP end-to-end test/transport-e2e.test.ts. D-06 flips to "mitigated (0.20.0)" in `docs/DECISIONS.md`; residual: the shared-secret model (no mTLS, discovery or multi-hop routing) — the host still owns channel isolation across trust boundaries.

### Explicit anonymous-write policy

- Writes from callers carrying **no identity at all** no longer fail open into the shared `global` tier as a silent, unconfigurable default: `scope.anonymousPolicy` makes the treatment an explicit three-state choice — `global` (default: zero-config boots stay byte-identical to every prior release), `quarantine` (anonymous writes land in the `__anonymous__` session bucket, invisible to identified users) or `reject` (fail-closed refusal for hosts that guarantee identity at their own boundary).
- Enforced at every user-facing write boundary: message and tool-event ingest, `memory_remember`, capsule import and `session.end` distillation; the standalone MCP server reads `MEMORY_PALACE_ANON_POLICY` (invalid values warn on stderr and fall back to `global`) and prints the effective policy on the startup banner.
- Guarded as new invariant I-ACL-15 — test/anonymous-policy.test.ts over the three states, with the exhaustive ACL truth table pinning the default face; D-15 logged in `docs/DECISIONS.md`.

### Admin allowlist for global side effects

- `scope.adminUserIds` turns the authorization of `memory_migrate` live runs from scope-derived (true by construction) into a true allowlist gate: once configured, a live migration requires BOTH the caller's userId being on the list AND the explicit `confirm: true` (a double gate) — anonymous and non-member callers are refused outright, fail-closed. Unconfigured keeps the single-user trust model (`confirm` alone, byte-identical zero-config behavior); `dryRun` previews stay free either way.
- The standalone MCP server reads the list from the `MEMORY_PALACE_ADMIN_IDS` environment variable; installation fails loud on an empty array or empty-string entries (an allowlist that gates nobody is a fake gate — refuse it at install time rather than silently disabling the gate).
- Guarded as new invariant I-PO-20 — test/migrate-admin.test.ts; D-04 flips to "eliminated (0.20.0)" in `docs/DECISIONS.md`, with the unconfigured single-user trust model logged as the residual — multi-tenant hosts should configure it (same family of wiring advice as D-15's `anonymousPolicy`).

### Epoch-namespaced version stamps

- The 32-bit `user_version` wrap-around false-freshness edge (D-08) is closed structurally by epoch namespace transfer: `dataVersionStamp()` returns the composite string `<epoch>:<version>`, and when the counter reaches INT32_MAX the wrap writes `user_version = 0` AND persistently increments an epoch (`palace_meta` key `dataVersionEpoch`, no 32-bit width limit) in one atomic transaction — no cache clearing, no clamping.
- Every version-keyed cache consumer (semantic query cache, retriever data stamp, PageRank SWR via `graphVersion()`) now compares the composite stamp: cross-epoch comparisons mismatch by construction, so wrap-around false freshness is unrepresentable rather than improbable; a lagging epoch view is directionally safe (miss = recompute, never a stale hit), and foreign wraps are picked up through a version-decrease read (WAL-visible) that re-reads the epoch.
- Guarded as new invariant I-DI-21 — test/fault-injection.test.ts scenario 3 (wrap increments the epoch durably and foreign-connection-visibly, pre-wrap cache entries can never compare fresh, post-wrap cycle, multi-process epoch adoption); D-08 flips to "eliminated (0.20.0)" in `docs/DECISIONS.md`.

### Scoped observability

- Counts follow the caller: the store gains `statsScoped(level)` — five visibility-scoped counts over the same window retrieval sees — and the facade gains a `facade.stats(scope?)` scoped overload; `memory_inspect` reports fully scoped counts, so tenant-facing observability never leaks another tenant's numbers.
- The unscoped `facade.stats()` stays as the documented management-plane API (an ontological property of an embedded library) and gets *more* informative: `stats().byTier` adds tenant-distribution telemetry for capacity planning.
- Guarded as new invariants I-ACL-16 (tool-layer counts must follow the caller's scope — audit check 11 bars bare `stats()` from the tool layer) and I-PO-21 (`statsScoped` ≡ `visibleAtLevel` filtering, differentially proven in test/stats-scoped.test.ts); D-01 flips to "mitigated (0.20.0)" in `docs/DECISIONS.md`.

### Session semantics pinned as a verified property

- Shared-session cross-user visibility is reclassified in `docs/DECISIONS.md` from an accepted risk (D-09) to a **verified property, not a risk**: session being a shared visibility group is core design semantics, and the exhaustive ACL suite's 2880-cell three-way truth table (960 cells × 3 layers, SQL ⇔ JS ⇔ prophecy) proves the implementation correct — the entry exits the risk register (register purity: only real risks and tradeoffs stay filed) and the semantics are guarded as new invariant I-ACL-17.
- test/session-semantics.test.ts pins three use cases — same sessionId = same group (across users and workspaces alike), different sessionIds mutually exclusive, session-group membership never widens into the user tier — so a future "fix" that adds userId checks to the session tier fails loudly instead of silently breaking collaboration.
- A runtime warning now fires on weak/guessable session ids: the threat model that sessionId is a bearer credential (possession = in-group visibility) is explicit and observable — hosts should mint unguessable session ids.

### Write-time outcome transparency

- `memory_remember` now tells the model what actually happened to the write: the response carries a `writeOutcome` — one of four exhaustive states (`created` / `deduplicated` / `superseded` / `conflict-flagged`) — with evidence fields (`matchedId`, `similarity`, `conflictReason`); under sparse embeddings (offline-bm25) any non-`created` outcome appends an advisory to reword genuinely-distinct facts, promoting D-11's prompt-level concern from a test comment into a runtime feedback loop.
- The two write-time thresholds become configuration: `retrieval.writeDedupeThreshold` (default 0.92, the near-duplicate merge line) and `retrieval.conflictScanThreshold` (default 0.75, the conflict-scan floor), byte-identical when unset — templated/numeric corpora can tighten them, other hosts can relax.
- The correctness core is pinned as new invariants: I-RC-14 (a high-similarity new fact carrying a conflict — numeric drift "v16"→"v17" — never silently merges into a near-duplicate; it always lands as a new row on the supersede/conflict path; test/write-outcome.test.ts flagship + the integration supersede segment) and I-PO-22 (four-state completeness with evidence fields). D-11 flips to "mitigated (0.20.0)" in `docs/DECISIONS.md`; residual: the similarity heuristic still rides embedding quality (deepseek deployments discriminate better — same family as D-03's residual).

### Changed

- Multi-process hardening on every store connection: WAL journaling with `busy_timeout = 5000` and tuned `wal_autocheckpoint`, so concurrent processes on one palace file get orderly queuing under write contention instead of immediate `SQLITE_BUSY` failures. Single-writer / multi-reader remains the recommended topology.
- `npm run verify` now chains the release-hygiene audit (`npm run audit`) alongside lint / build / test, so `prepublishOnly` fails on any metadata drift.
- CI runs the matrix on Node 22 and Node 24, with the audit gate as a required step.

### Added

- Store self-diagnostics and conservative recovery: `integrityCheck()` structural self-audit of the SQLite store, `repairIntegrity()` self-healing limited to provably-safe repairs, and `backupTo()` online backup via SQLite `VACUUM INTO` (consistent snapshot of a live palace).
- `memory_inspect` gains an integrity panel surfacing the self-check results next to the existing health metrics — a doctor-style green light after crashes, hand-restores or migrations.
- Capsule freshness validation: `parseCapsule(json, { maxAgeMs })` rejects a capsule whose `exportedAt` age exceeds the bound (error names the age and the limit), and `ImportOptions.maxAgeMs` threads the bound through `planImportFromJson` — replayed stale capsules can no longer land over fresher local knowledge. Omitted by default: byte-for-byte backwards compatible.
- Pipeline-level chaos fuzz suite with invariant monitoring — randomized fault injection across the ingest/compress/retrieve pipeline asserting the store's structural invariants after every storm.
- Performance benchmark gate: `npm run bench` runs the benchmark suite as a regression gate with budget enforcement.

## [0.19.0] - 2026-10-05

Correctness and wiring pass — the 0.10–0.18 frontier features are closed into their full pipelines, plus a CJK-aware tokenizer. (0.10–0.18 entries below were backfilled from the architecture roadmap's delivery log; see git history for detail.)

### Fixed

- Query cache keys now incorporate `filters` and `fusionOverrides` — two queries differing only in filters or learned fusion weights can no longer be served each other's cached results.
- Entity-hop expansion no longer bypasses tier/owner filtering, time windows and as-of flashback — the graph-guided second pass runs through the same gated scan as the vector pass.
- `insertItem` no longer resurrects tombstoned items on exact-content re-insert.
- Trajectory queries (intent-predictor) return the most recent matching trajectory instead of the oldest.
- Compression distillation runs as a strict two-phase transaction and preserves owner metadata on merged items.
- Stratifier digest-node ids are owner-qualified, preventing cross-user node overwrites.
- Core-block compression preview cap no longer interrupts eviction when the preview budget is exceeded.
- CRDT orTag uses `@`-separated tags with value-level fingerprints (unambiguous OR-Set tag parsing and merge).
- Capsule import validates patterns and embedding-space fields.
- Federation member timeouts and circuit-breaker transitions are observable (logged and surfaced, not silent).

### Changed

- Tokenizer: CJK bigram segmentation — runs of Chinese/Japanese/Korean text split into overlapping character pairs, so retrieval keyword fusion, consensus synthesis, pattern mining and the reflection benchmark all work on sub-word units for Chinese. Deterministic, zero-dependency, no dictionaries.
- Circuit breaker half-open state gates on a true single-probe latch.
- `scanBySimilarity` fully named-parameterized.
- IVF radius escalation probes only the bucket-set difference (no redundant re-probing of already-scanned buckets).
- MMR falls back to Jaccard token overlap for cross-space pairs (vectors from different embedding spaces are never dot-producted).
- PageRank edge set is consistent with the node set (edges to pruned entities no longer distort rank mass).
- The 5-arm fusion bandit now acts on real retrieval: `graphBoost` / `prfAlpha` / `prfBeta` are wired into the pipeline (previously only the vector/keyword blend moved).
- Inferencer visibility goes through `resolveWriteTier`; `inf:reaches` edges refresh only when the new inferred path is strictly stronger.
- MCP server: protocol version negotiation, `isError` on failed tool calls, serialized stdout writes, graceful drain on shutdown.
- CLI: directory-listing format, collision-safe session ids, unknown-flag handling.

### Added

- Bandit feedback loop closed with implicit engagement signals — a hit later inspected via `memory_why`, forgotten, or capsule-exported counts as reward — plus a scheduled exploration step on every 10th retrieval.
- `palaceId` persisted: stable identity for CRDT `(lamport, palaceId)` tie-breaking across restarts.
- CRDT federation service wired to the store: writes bridge in on `memory.after-store`, and the Lamport clock is recovered on restart so merged state survives restarts.

## [0.18.0] - 2026-10-05

Int8 vector quantization (P3.8 in the roadmap).

- Embeddings stored quantized (per-space scale vector + int8 payloads) with an int8 dot-product path inside `mp_cosine`; `retrieval.quantization: "int8" | "float32"` (default int8).
- ~4× denser vector storage with bounded cosine error measured against the exact float32 scan in the property suite; float32 remains available as exact mode.

## [0.17.0] - 2026-10-05

Federation router (P1.4) — query fan-out across palaces.

- `federated-retriever` service + `memory_fed_search` tool: one query fans out in parallel to registered member palaces with per-palace circuit breakers and timeouts; merged hits are tagged with their source palace. Each member applies its own scope/ACL — the federation merges only what each palace chose to return.
- Event `memory.federated-retrieved`.

## [0.16.0] - 2026-10-05

CRDT federation core (P1.3) — multi-master palace sync semantics.

- Items and core blocks merge as LWW-Maps keyed by content-hash ids (timestamp `(lamport, palaceId)`); tags/entities as add-wins OR-Sets whose removes reuse the tombstone machinery; supersession chains merge as causal DAGs with conflicting heads surfaced through the contradiction detector. Transport reuses the capsule HMAC + canonical-JSON framing with a `MergePlan` extending `planImport`.
- `crdt-federation` service; event `memory.crdt-synced`. (Store-level wiring — the after-store bridge and Lamport restart recovery — landed in 0.19.0.)

## [0.15.0] - 2026-10-05

Hierarchical summarization tree (P2.6).

- Sleep gains a `stratify` phase (`stratifier` service): session summaries → weekly → monthly → era nodes, each a deterministic extractive synthesis reusing the core-memory compaction kernel, children linked via `part-of` typed edges; re-stratification rides every sleep cycle.
- `memory_era` tool answers "what was this period about" from bounded digest nodes; event `memory.stratified`.

## [0.14.0] - 2026-10-05

Feedback-closed fusion learning (P2.5) — online retrieval tuning.

- `feedback-learner` service: a bounded contextual bandit (ε-greedy, per-scope-state features) nudges fusion knobs within fixed safety rails (±20% of defaults) using implicit engagement feedback; full audit log of weight evolution; reflection remains the offline sanity bound.
- `retrieval.fusionLearning` config (enabled / lr); `memory_bandit` tool; events `memory.bandit-learned` / `memory.bandit-reset`.

## [0.13.0] - 2026-10-05

Deterministic IVF vector index (P0.1) — delivered with an honest deviation from the plan: fixed-plane bucketing (the shared anchor-plane kernel) instead of k-means centroids.

- Persistent bucket partition maintained transactionally; queries probe Hamming-adjacent buckets with an escalating radius; escalation ends in all-keys = the exact scan, so the index is a pure accelerator and recall never depends on it. The planned k-means rebalance phase was dropped as unnecessary (see ARCHITECTURE-ROADMAP P0.1).
- `retrieval.ivf` config (enabled / radius / minItems).

## [0.12.0] - 2026-10-05

Intent-trajectory prefetch (P2.7) — speculative warmth.

- `intent-predictor` service: Markov chain over past sessions' query sequences (entity-tuple states, per-scope) stored as procedural patterns; at session start the top-3 predicted follow-ups' PPR ranks and semantic-cache entries are prefetched — pure local compute.
- Event `memory.prefetched`.

## [0.11.0] - 2026-10-05

Embedding-space migration daemon (P0.2).

- `space-migrator` service + `memory_migrate` tool: background, budget-bounded (N items per tick) re-embedding of items stranded in an old embedding space after a provider switch or model upgrade — transactional per batch, flashback integrity preserved, `migratedFrom` audit field, refuses to run while the embedder is degraded.
- Event `memory.space-migrated`; closes the silent-failure mode where retrieval returns zero after a failover window.

## [0.10.0] - 2026-10-05

Transitive inference over the knowledge graph.

- `memory-inferencer` service: typed relations yield derived facts through bounded transitive chains, with confidence-flagged provenance traces distinguishing direct from inferred knowledge.
- `memory_why` tool: the epistemic mirror of `memory_retrieve` — relations (direct and inferred), the evidence items that mention an entity, and where the knowledge originated. Event `memory.inferred`.
- Baseline at this release: 11 tools, 12 services, CLI shipping alongside the DSH plugin and MCP server.

## [0.9.0] - 2026-10-05

Genesis: the Living Core — the palace acquires a persistent SELF.

- Core memory (v6 schema): three hard-capped, line-oriented blocks (profile / project / goals) behind the same visibility-tier ACL as everything else; REWRITTEN not appended; every version kept in a bounded audit history (core_history, last 20 per block).
- Deterministic compaction kernel (utils/core-memory.ts): line scoring (entity salience via live PageRank, structure, goal markers, brevity), token-Jaccard dedupe, lowest-first eviction, survivor order preserved.
- SleepCycle: one failure-isolated consolidation pass — compression (evict + distill + mine + retention) then core compaction against current entity salience — emitting a deterministic dream report (memory.slept). Runs at session.end and the mid-session tick.
- Self-editing memory: memory_core tool (read / set / append / history / compact) with input clamps; the agent maintains its own identity blocks MemGPT-style. memory_sleep forces a night on demand.
- Core-first injection: session.start opens with the SELF (bounded by injection.coreBudgetFraction, default 1/3) BEFORE retrieved context — cold starts begin with who the user is, not with what ranked well.
- Services memory-core / sleep-cycle registered; MCP bin builds both; 10 model tools total.
## [0.8.0] - 2026-10-05

Code-quality elevation — the whole tree now passes a type-checked lint gate and two additional strict-compiler flags.

- ESLint 9 (flat) + typescript-eslint recommendedTypeChecked wired into npm run lint and CI; src runs strict (no-explicit-any, consistent-type-imports, no-console, eqeqeq), tests relax only the fixture-hostile rules.
- tsconfig hardened with noUncheckedIndexedAccess + noImplicitOverride; ~60 genuine index-access / possibly-undefined hazards fixed across services and kernels (typed-array indexing exempted where the flag does not apply).
- Tool input hardening: topK/minScore clamped, asOf sanity-checked, layers whitelist-validated at runtime, capsule JSON capped at 2 MiB before parsing.
- VisibilityTier type moved into types/ (breaks the types↔scope type-only import cycle); scope re-exports for compatibility.
- Tool contract run() may now be sync (Promise<O> | O); sync tools dropped their sham async.
- Zero-dependency property tests (seeded mulberry32): chunker offset/order/duplication invariants (200 inputs), PageRank mass conservation on 100 random graphs (weighted/temporal/personalized), capsule canonicalization + HMAC mutation resistance, PRF normalization/query-dominance.
- Suite: 96 tests green on real execution; coverage 93.9% lines / 80.4% branches (kernels ≈100%; known gaps: distill full pass, DeepSeek network paths).

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
