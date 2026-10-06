# 不变量规格书 — Invariant Catalog

> 组织级记忆：**任何一条系统性质被测试、门禁或运行时断言看守，都能在本表查到"由谁看守"。**
> 改代码前先查此表——你动的这条性质如果在这里，打破它的人会立刻收到一张红色的 CI 单。

本表把 0.2–0.20 五轮工程（分层基座 → 工具化 → 维度升维 → 正确性收口 → 运维韧性 + 审后加固）沉淀的全部 bug 知识，升维为"**命名不变量 → 强制执行点**"的可追溯矩阵。每条不变量以可执行断言的语气写成；执行点全部与仓库现状逐一对过。

**状态图例**

- 无标记：执行点今日已在树中（`test/*.test.ts`、`scripts/audit.mjs`、`scripts/bench.mjs`、`.github/workflows/ci.yml`、`src/**` 运行时守卫）。
- **▲**：执行点随 0.20.0 *Verification elevation* 波落地（穷举 ACL 真值表、物理错误注入、蜕变关系、fuzz 多种子 + 收缩器——见 CHANGELOG 0.20.0；现已全部落地）。带 ▲ 的行同时给出今日已在树中的兜底执行点，矩阵在两个状态下都成立。

---

## 1. 总览矩阵

| 编号 | 不变量 | 类别 | 强制执行点（测试 / 门禁 / 运行时） | 来源轮次 |
|---|---|---|---|---|
| I-ACL-01 | 全路径四层 ACL：一切可作用域化的读写（含 forget/restore/purge/inspect）都过 tier+owner 过滤 | 隐私与 ACL | chaos.test.ts 每步复查 / integration.test.ts | 0.4, 0.5 |
| I-ACL-02 | 匿名调用者只见 global 层 | 隐私与 ACL | chaos.test.ts 匿名探针 + endgame 三方复证 | 0.4 |
| I-ACL-03 | 任意非 global 行对无任何身份的调用者不可见（全格真值表） | 隐私与 ACL | ▲ 穷举 ACL 真值表套件（exhaustive-acl，0.20.0 已落地：test/exhaustive-acl.test.ts）/ chaos.test.ts 匿名探针 | 0.4 → 0.20▲ |
| I-ACL-04 | SQL tier 过滤 ≡ JS `visibleAtLevel` 镜像，逐格等价 | 隐私与 ACL | genesis-retrieval.test.ts G1 差分等价 | 0.19 |
| I-ACL-05 | 逐层加宽（session→workspace→user→global）永不跨 owner；已空的层不再重查 | 隐私与 ACL | chaos.test.ts / integration.test.ts | 0.4, 0.5 |
| I-ACL-06 | 知识图谱全域隔离：实体/边/子图/路径/社区/PageRank 不跨用户 | 隐私与 ACL | integration.test.ts（scope 过滤 + rank 隔离） | 0.4 |
| I-ACL-07 | `memory_era` 拒绝匿名调用者 | 隐私与 ACL | 0.20 post-audit 回归（实现 src/index.ts / stratifier） | 0.20 |
| I-ACL-08 | 幽灵行防绝：不存在 `visibility='user'` 而 owner 为 NULL 的行 | 隐私与 ACL | genesis-services.test.ts / 0.20 post-audit 回归（运行时：`resolveWriteTier` 单一落层入口） | 0.20 |
| I-ACL-09 | 核心块同名歧义窄层优先：set/append 只写调用者自有层块 | 隐私与 ACL | living-core.test.ts / core-memory.test.ts | 0.20 |
| I-ACL-10 | 蒸馏继承簇内最窄 tier（narrowest-wins：含任何私有行的簇在该私有行的 tier 合并——压缩可收窄、永不拓宽可见性）；蒸馏分区键不含 tier（同 owner 跨 tier 近重复可合并），模式挖掘保留含 tier 分区；两 owner 近同内容各蒸馏各的 | 隐私与 ACL | test/utils.test.ts（narrowest-tier 回归）/ genesis-services.test.ts #2 | 0.4, 0.19, 0.21 |
| I-ACL-11 | 分层摘要树按 owner 不相交；摘要输入排除既有 stratified 行 | 隐私与 ACL | genesis-services.test.ts #1 / stratify.test.ts | 0.15, 0.20 |
| I-ACL-12 | 胶囊导出剥除 owner 身份，导入按 importer 重绑所有权 | 隐私与 ACL | dimensions.test.ts | 0.7 |
| I-ACL-13 | tool.call / tool.result 事件携带调用者 scope；空消息负载在事件边界丢弃 | 隐私与 ACL | 0.20 post-audit 回归 / chaos.test.ts 工具事件乱流 | 0.20 |
| I-ACL-14 | 默认联邦服务面 = 仅 global 层：传输服务器以匿名级联（serveScope 缺省 `{}`）求值检索，私有层（session/workspace/user）不经传输外泄，客户端自带 scope 不可加宽服务面 | 隐私与 ACL | test/transport-e2e.test.ts（用例 4：A 的 user 层条目对 B 联邦检索 0 命中 + 夹带 scope 探针）+ test/transport-http.test.ts（serveScope 边界） | 0.20 |
| I-ACL-15 | 匿名写入策略三态在所有用户面写入边界（message / tool / remember / import / session.end）强制：默认行为与显式 global 策略逐字节等价；quarantine 行（`__anonymous__` session 桶）对已识别用户不可见；reject 拒绝且不崩 handler | 隐私与 ACL | test/anonymous-policy.test.ts + test/exhaustive-acl.test.ts（默认面） | 0.20 |
| I-ACL-16 | 可观测性隔离：工具层计数必须随调用者作用域求值——`memory_inspect` 等观测工具永不报告跨租户计数；scoped 计数一律走 `store.statsScoped(level)` / `facade.stats(scope?)`，工具面禁裸 `stats()` | 隐私与 ACL | test/stats-scoped.test.ts + scripts/audit.mjs check 11（工具层禁裸 stats()） | 0.20 |
| I-ACL-17 | session = 共享可见组：同 sessionId 即同组——组内 session 行互见（跨用户、跨 workspace 亦然；冒充 sessionId 获得组内可见性是设计内 bearer-credential 语义：sessionId 是进入会话可见组的凭证，持有即授权，弱号触发运行时告警）；异 sessionId 互斥；组不放大层级（session 组成员不见 user 层——加宽仍逐层 delta 且不跨 owner） | 隐私与 ACL | test/session-semantics.test.ts（钉死三用例）+ test/exhaustive-acl.test.ts（穷举面：960 格真值表 × 3 层 = 2880 格三方评估） | 0.20 |
| I-DI-01 | 墓碑不复活：对已软删内容的精确重插不复活旧行 | 数据完整性 | genesis-store.test.ts #2 | 0.19 |
| I-DI-02 | src 全树禁 `INSERT OR REPLACE INTO memory_items` | 数据完整性 | scripts/audit.mjs check 4 | 0.19 |
| I-DI-03 | 两阶段事务：ingestTx 批量原子 + 压缩蒸馏严格事务，提交后深度归零 | 数据完整性 | genesis-store.test.ts（commit-stamp 检查） | 0.5, 0.19 |
| I-DI-04 | FLASHBACK 保留：重嵌入迁移不动删除/取代时间戳，asOf 视图不变 | 数据完整性 | space-migrator.test.ts（flashback unchanged） | 0.11 |
| I-DI-05 | 迁移幂等且预算化：再跑无新效果、分批事务、embedder 降级拒跑 | 数据完整性 | space-migrator.test.ts | 0.11 |
| I-DI-06 | 自检-自愈对：integrityCheck 净库全零/脏态全报；repairIntegrity 保守且幂等 | 数据完整性 | genesis-integrity.test.ts #1/#2 | 0.20 |
| I-DI-07 | backupTo 产出可挂载的 VACUUM INTO 快照，拒绝覆盖既有目标 | 数据完整性 | genesis-integrity.test.ts #3 | 0.20 |
| I-DI-08 | JSON 列解析降级不抛：safeJson 以 fallback 返回，行永不整体失败 | 数据完整性 | 运行时 memory-store.ts `safeJson` / chaos.test.ts 风暴后 stats 存活 | 0.20 |
| I-DI-09 | dataVersion（PRAGMA user_version）单调非降（回绕点降 0 除外——跨回绕比较由 I-DI-21 的 epoch 复合戳接管；chaos 风暴量级不可达回绕） | 数据完整性 | chaos.test.ts 不变量 b | 0.6 |
| I-DI-10 | 同文件多实例经 WAL + busy_timeout 互见写（SWR 失效正确） | 数据完整性 | genesis-integrity.test.ts #4 | 0.20 |
| I-DI-11 | CRDT 最终一致性：(lamport, palaceId) 全序、palaceId 重启稳定、orTag 无歧义、多序同步收敛 | 数据完整性 | crdt-federation.test.ts | 0.16, 0.19 |
| I-DI-12 | Lamport 天花板 reducer 归约：12.5 万 op 同步不炸调用栈 | 数据完整性 | 0.20 post-audit 回归 / crdt-federation.test.ts | 0.20 |
| I-DI-13 | 胶囊完整性：HMAC 逐字节突变抵抗、b64 非法字符拒收、maxAgeMs 拒陈旧重放、2 MiB 上限、逐项字段验证 | 数据完整性 | properties.test.ts / genesis-services.test.ts #5 / dimensions.test.ts / 0.20 post-audit | 0.7, 0.8, 0.20 |
| I-DI-14 | 幽灵行必须被审计看见：tier 有值而 owner 列为 NULL 的 LIVE 行由 integrityCheck 计数并使 ok=false；修复仅经显式 opt-in，repair 默认不猜不动 | 数据完整性 | test/genesis-integrity.test.ts + integrityCheck 运行时（src/services/memory-store.ts） | 0.20 |
| I-DI-15 | CRDT 同步增量水位：每对端 per-replica 水位持久化于 `crdt:wm:<peerId>`（store.getMeta/setMeta），缺水位 / 解析失败回退全量交换，指纹校验恒全量重放——增量只省传输与对端 apply 量，收敛语义不变 | 数据完整性 | test/crdt-federation.test.ts（增量 / 回退用例）+ crdt-federation 运行时（src/services/crdt-federation.ts） | 0.20 |
| I-DI-16 | 胶囊内容寻址 legacy 永久兼容（0.20.0 首缓解为 64 位 + 8-hex 双格式；寻址宽度已由 I-DI-20 升维 128 位，本条看守的兼容语义不变）：旧格式 id 永久可导入（存量胶囊不过期，各代格式互不污染） | 数据完整性 | test/dimensions.test.ts / test/properties.test.ts（capsule 用例，0.20.0 随缓解补强）+ 实现 src/utils/capsule.ts | 0.20 |
| I-DI-17 | `metadata.visibility` 不持久化：写路径落库前剥除该键，`visibility` 列是唯一事实源（外部载荷携带仅作写入派生的解释性输入；legacy 行读侧投票链兼容） | 数据完整性 | 实现 src/services/memory-store.ts `insertItem`（剥除点）+ test/genesis-services.test.ts | 0.20 |
| I-DI-18 | owner 复合分区键以 `\u0000` 拼接（ids 中不可能出现的码位，复合键不可由分段内容伪造）；模式 id 保持稳定 `\|` 格式（存量 id 不 churn） | 数据完整性 | 运行时 src/services/memory-compressor.ts（ownerKey / 分区键）+ test/genesis-services.test.ts / test/pattern-miner.test.ts | 0.20 |
| I-DI-19 | CRDT 跨网交换与进程内同步同一收敛语义：HTTP anti-entropy 双向收敛（指纹相等）、增量水位只省传输不改收敛、水位持久化且崩溃回退全量（方向安全） | 数据完整性 | test/transport-crdt.test.ts + test/transport-e2e.test.ts（用例 2：双宫殿真实 HTTP 收敛、2-op 增量精确计数）+ src/services/crdt-federation.ts（水位语义，I-DI-15 的网络面） | 0.20 |
| I-DI-20 | 胶囊内容寻址为 SHA-256 截断 128 位（`cap:` + 32 hex）密码学 CAS：新导出一律 v3；解析三代按长度分派兼容（8/16/32 hex 各按本代算法重算，其他长度/非 hex 拒收并列全三代格式）；同胶囊同 id 异 normalizedContent 即地址碰撞 → fail-loud（`assertNoAddressCollisions`） | 数据完整性 | test/capsule-cas.test.ts | 0.20 |
| I-DI-21 | 版本戳为 epoch 命名空间复合串：`dataVersionStamp()` = `<epoch>:<user_version>`；回绕（计数器抵 INT32_MAX 的下一次 bump）必在同一事务内 `user_version = 0` ∧ 持久 epoch +1（palace_meta `dataVersionEpoch`，无宽度限制）；跨 epoch 比较必失配（假新鲜不可表示）；缓存消费面（语义查询缓存 / 检索器 / PageRank SWR）一律以复合戳为键；多进程 epoch 滞后方向安全（version-下降检测刷新，滞后只 miss 永不假命中） | 数据完整性 | test/fault-injection.test.ts（场景 3：回绕升 epoch 且持久可见、假新鲜死亡证明、回绕后周期、多进程 epoch 采纳）+ 实现 src/services/memory-store.ts | 0.20 |
| I-DI-22 | 量化模式守卫：库文件携带 `quantization` 元数据戳（首开落戳）；以与落戳不同的模式重开同一库必须在构造期 fail-loud（先关句柄再抛），绝不以错误字节宽度静默解释全部 embedding blob——int8 ⇄ float32 误开是最安静的全文向量损坏 | 数据完整性 | test/genesis-store.test.ts（quantization guard 回归）+ 运行时 src/services/memory-store.ts（构造器 meta 戳检查） | 0.21 |
| I-DI-23 | 胶囊签名对解析归一化不敏感：sign/verify 一律在"补齐缺失可选字段（逐 item 的 tags/entities 与顶层 patterns → `[]`）后的 unsigned 视图"上计算——第三方导出者省略可选字段签名的胶囊，经 parseCapsule 补默认后仍可验签；字段齐全胶囊的字节不变（旧签名全兼容）；`legacyAddressCount` 观测字段仍排除在规范形外 | 数据完整性 | test/capsule-cas.test.ts（稀疏 capsule sign→parse→verify 回归）+ 实现 src/utils/capsule.ts（unsignedView） | 0.21 |
| I-RC-01 | 查询缓存键完备：文本 + filters + fusionOverrides 全进键；覆写归一为同一分区 | 检索契约 | genesis-retrieval.test.ts G4（六变体互不命中） | 0.6, 0.19 |
| I-RC-02 | 缓存命中须锚桶 + cosine ≥ 0.985 双验；写入按版本戳整体失效（复合戳 `dataVersionStamp()`，见 I-DI-21） | 检索契约 | retrieval-kernel.test.ts | 0.6 |
| I-RC-03 | finalScore 恒在 [0, 1]：各因子钳制 + 融合 clamp01 关两端 + bandit 覆写先入 ARM_RAILS | 检索契约 | chaos.test.ts 不变量 e / feedback-bandit.test.ts | 0.5, 0.19 |
| I-RC-04 | hits.length ≤ topK；via ∈ {vector, entity-hop} | 检索契约 | chaos.test.ts 不变量 e | 0.6 |
| I-RC-05 | 跨空间向量永不被点积：MMR 对跨空间对回退 Jaccard token 重叠 | 检索契约 | memory-retriever.ts 跨空间守卫（空间隔离另见 quantize.test.ts 双维语料） | 0.19 |
| I-RC-06 | IVF 精确性梯子：全半径探查 === 精确扫描；升级只探桶集差集；累计键并集 === 全键 === 精确键集，终于精确 | 检索契约 | ivf-index.test.ts C1/C3 / genesis-retrieval.test.ts G2a | 0.13, 0.19 |
| I-RC-07 | IVF radius-1 实测 recall@10 ≥ 0.8（确定性语料，128 与 256 维双档） | 检索契约 | ivf-index.test.ts C2 / genesis-retrieval.test.ts G2b | 0.19 |
| I-RC-08 | 实体跳扩二过走与向量一遍相同的门控扫描（tier/owner/时间窗/asOf） | 检索契约 | genesis-retrieval.test.ts / integration.test.ts | 0.19 |
| I-RC-09 | graphBoost 服务端钳位 [1−0.5, 1+0.5]；PageRank 质量守恒 Σrank ≈ 1 | 检索契约 | genesis-retrieval.test.ts G3 / properties.test.ts | 0.4, 0.19 |
| I-RC-10 | 轨迹读取 owner 锚定：userId 优先、workspace 回退、双无返回空 | 检索契约 | genesis-integrity.test.ts #5 | 0.20 |
| I-RC-11 | 联邦合并只含各成员宫选择返回的行；故障成员被断路器隔离不拖垮整体 | 检索契约 | federated-retriever.test.ts | 0.17 |
| I-RC-12 | 语义缓存命中充分性由全量兜底保证：锚桶定位未命中时执行容量有界的全量扫描再裁决，近重复命中不依赖锚桶几何；宁失勿陈不变 | 检索契约 | test/retrieval-kernel.test.ts + 实现 src/utils/query-cache.ts | 0.20 |
| I-RC-13 | 反馈信号信息量：why / export(query) 派生 reward 必须随排序质量变化（why 按零副作用探针排位 DCG 衰减 1/log₂(rank+2)，export 按 0.6·avgScore + 0.4·diversity 复合）——恒定值即违规（entity/all 模式 bulk 策展除外） | 检索契约 | test/feedback-signals.test.ts（双向信息量断言）+ 实现 src/index.ts（memory_why / memory_capsule_export learn 接线） | 0.20 |
| I-RC-14 | 写时数值漂移必走替代/冲突路径：相似度达去重线（`retrieval.writeDedupeThreshold`，缺省 0.92）且矛盾检测命中的新事实（"v16"→"v17" 类数值漂移）永不静默丢失或被静默吞并——绝不走去重合并返回既有 id，必落新行；`supersede:true` 时旧版本入墓碑替代链，未替代时以冲突报告浮出；去重合并仅在"高相似 ∧ 无矛盾"时发生（相似度与矛盾共同裁决） | 检索契约 | test/write-outcome.test.ts（旗舰）+ test/integration.test.ts（supersede 段） | 0.20 |
| I-RC-15 | 投机预热形状齐平：learner 启用时 `session.start` 预热必须携带与生产 `memory_retrieve` 相同的贪婪 `fusionOverrides`（paramsKey 含 stableFusionKey——形状不同即分区永不相交，预热成纯浪费）；每第 10 次检索的探索步故意自成分区，不预热 | 检索契约 | test/intent-trajectory.test.ts（session.start 预热 → memory_retrieve cacheHit 回归）+ 实现面 src/index.ts（session.start warm 接线） | 0.21 |
| I-RC-16 | 中文实体抽取多信号门（D-16）：引号 ▸ 系统名词后缀（名词短语结尾约束 + 连接词/胶着字边界走查）▸ 消息内精确最长重复，各过停用词与长度门；CJK 通道独立子配额 8、naturals 优先级与总配额 32 不变；纯 ASCII 文本不进任何 CJK 路径（英文抽取逐字节不变）；CJK 名单抵达 CN 连接词 typed-relation 抽取（可产边）；项目/计划后缀对 Han 复合词生效 | 检索契约 | test/utils.test.ts（CJK 多信号/边界/停用词/子配额/英文不变/classify + 端到端 CN depends-on 边）+ 实现面 src/services/memory-graph.ts（extract CJK 三档） | 0.22 |
| I-NT-01 | 分块器码点安全（永不切代理对）且严格推进（有序/无重复/偏移精确） | 数值与文本 | genesis-utils.test.ts / properties.test.ts（200 输入）/ chaos.test.ts emoji 载荷 | 0.1, 0.8, 0.19 |
| I-NT-02 | CJK bigram：连续段切重叠双字、孤字单列、英文不受扰、token 预算按字计 | 数值与文本 | hardening.test.ts B1 | 0.19 |
| I-NT-03 | int8 量化有界：量化余弦误差对精确 float32 有界、端到端召回保持、float32 恒可回退 | 数值与文本 | quantize.test.ts | 0.18 |
| I-NT-04 | 熔断 half-open 真·单探针闩：一次试探定开合，不并发放行 | 数值与文本 | genesis-utils.test.ts（CircuitBreaker） | 0.19 |
| I-NT-05 | bandit 硬轨 ±20% 默认值：内核与消费端双端钳，越轨覆写永不触达融合 | 数值与文本 | feedback-bandit.test.ts / genesis-retrieval.test.ts G3（融合侧见 I-RC-03） | 0.19 |
| I-NT-06 | 零命中零学习：无 0/0 NaN 路径、无奖励事件落账、不可能过度参与被钳 | 数值与文本 | genesis-services.test.ts #4 | 0.19 |
| I-NT-07 | NaN/Infinity 数值输入回退默认后再钳（topK/minScore/budget/era 窗/fed topK/CLI --topk 等） | 数值与文本 | chaos.test.ts 畸形输入 / 0.20 post-audit 回归 | 0.20 |
| I-NT-08 | 数值签名原子性：日期/版本整体成签（padding 归一），不碎成数字碎片 | 数值与文本 | consensus.test.ts | 0.5 |
| I-NT-09 | 中文否定极性：不错/不断等肯定习语不计为否定，不会/没有计为否定 | 数值与文本 | consensus.test.ts | 0.5 |
| I-NT-10 | 时间习语 lookahead 守卫："last weekly report" 不解析为"上周" | 数值与文本 | query-understanding.test.ts | 0.5 |
| I-NT-11 | 字节流边界卫生：stdio >64 KB 分块 setImmediate 让写（代理对安全）；CLI 剥 UTF-8 BOM | 数值与文本 | ▲ 物理错误注入套件（0.20.0 已落地：test/exhaustive-acl.test.ts）/ 0.20 post-audit 回归 | 0.20 |
| I-NT-12 | 检索期词干折叠边界：stem 域仅限关键词匹配阶段（overlapScore / phraseHits），禁入 embedding tokenize 与 offline BM25 哈希；paramsKey 除 STEM_RULESET_VERSION 常量外语义不变；折叠双侧同规则、确定性 | 数值与文本 | test/stemmer.test.ts + test/retrieval-kernel.test.ts（retriever 接入 + 旗舰 deploy↔deploys 回归） | 0.20 |
| I-PO-01 | tools/call `arguments` 为数组时 -32602 拒收，绝不当参数袋解构 | 协议与运维 | genesis-entries.test.ts | 0.20 |
| I-PO-02 | 未知工具 -32602、未知方法 -32601——码位分工是契约 | 协议与运维 | genesis-entries.test.ts | 0.20 |
| I-PO-03 | 业务失败 → `isError: true`，成功 → false——客户端不解析 content 即可分支 | 协议与运维 | genesis-entries.test.ts | 0.19 |
| I-PO-04 | notification（无 id）永不产生带 id 响应；initialize 只回显本地方言 | 协议与运维 | genesis-entries.test.ts | 0.19, 0.20 |
| I-PO-05 | 元数据三同步：版本 package.json === plugin.json === src/types VERSION；工具数 plugin.json === README 工具表 === buildToolDefinitions（现 15 个） | 协议与运维 | scripts/audit.mjs check 1 + check 2 | 0.20 |
| I-PO-06 | 静默绿灯与噪音禁令：src 无 console.*（src/bin 豁免）；test 无 `.skip(`/`xit(`/`xdescribe(` | 协议与运维 | scripts/audit.mjs check 3 + check 6 / eslint no-console | 0.20 |
| I-PO-07 | 删除语句可移植：memory-store 禁单句 `DELETE … ORDER BY … LIMIT` | 协议与运维 | scripts/audit.mjs check 5 | 0.19 |
| I-PO-08 | SQL 具名参数双向奇偶：每个 @ref 有 bind 键、每个 bind 键被引用，违者抛 `[invariant]` | 协议与运维 | 运行时 src/utils/invariants.ts `assertNamedParamParity` + genesis-store.test.ts #3 | 0.19 |
| I-PO-09 | dryRun 覆盖全部变更分支——含 purge 这一最后不可逆分支（wouldPurge 只预览） | 协议与运维 | 0.20 post-audit 回归（实现 src/index.ts） | 0.20 |
| I-PO-10 | 导入规划探针 speculative 运行（不污染访问计数/轨迹）；缺嵌入项经网关回填并报降级 | 协议与运维 | 0.20 post-audit 回归 / genesis-services.test.ts | 0.20 |
| I-PO-11 | verify 链 lint→build→test→audit 为发布必经；CI 双 Node 矩阵、audit 必过、MCP 二进制冒烟 | 协议与运维 | package.json（verify / prepublishOnly）/ .github/workflows/ci.yml | 0.20 |
| I-PO-12 | bench 门禁：计时指标超基线 2× 即红；信息性比值永不门禁；基线只可整尺度重录 | 协议与运维 | scripts/bench.mjs + scripts/bench-baseline.json | 0.20 |
| I-PO-13 | src/ 禁 `Math.max(...)` / `Math.min(...)` 直接 spread 展开——每个元素一个调用实参，大数组炸调用栈 | 协议与运维 | scripts/audit.mjs check 7 | 0.20 |
| I-PO-14 | memory-store.ts 的 `JSON.parse(` 全文件恰好 1 处（safeJson 内部；其余 JSON 列解码一律经降级 helper） | 协议与运维 | scripts/audit.mjs check 8 | 0.20 |
| I-PO-15 | scripts/ 路径解析必须 fileURLToPath，禁裸取 URL pathname（空格/非 ASCII checkout 路径全门禁误红） | 协议与运维 | scripts/audit.mjs check 9 | 0.20 |
| I-PO-16 | INVARIANTS.md 引用的每个 test/*.test.ts 执行点文件必须存在于仓库（规格防漂移） | 协议与运维 | scripts/audit.mjs check 10 | 0.20 |
| I-PO-17 | `memory_migrate` live 迁移需显式 `confirm: true` 才执行（缺失即拒绝并说明确认要求）；dryRun 碎片化诊断无需确认自由调用 | 协议与运维 | test/space-migrator.test.ts + 实现 src/index.ts（memory_migrate 确认门） | 0.20 |
| I-PO-18 | 显式 reward 通道合法域：经显式 reward 入账的信号必须是有限数、经 clamp01 钳入 [0,1]；NaN / Infinity 零写入（不进 bandit、不落事件账） | 协议与运维 | test/feedback-bandit.test.ts + 运行时 src/services/feedback-learner.ts（learn 钳制链） | 0.20 |
| I-PO-19 | 传输认证与线上守卫：联邦检索 / CRDT 传输对无签名与错签名请求一律 401（HMAC 对等认证，`timingSafeEqual` 恒时比较——杜绝时序侧信道逐字节猜测）；请求体超限 413；慢端 / 死端被超时守卫截断不挂死；检索命中载荷线上默认剥离 embedding | 协议与运维 | test/transport-http.test.ts + test/transport-crdt.test.ts（401 / 413 / 超时 / 剥离逐项）+ test/transport-e2e.test.ts（用例 1/3 的跨宫端到端面） | 0.20 |
| I-PO-20 | live 迁移双门：`scope.adminUserIds` 一经配置（非空白名单），`memory_migrate` live 需调用者 userId ∈ 白名单成员身份 ∧ 显式 `confirm: true`，缺一即拒；匿名与非成员调用者 fail-closed 必拒；未配置时保持 confirm 单门（单用户信任模型，零配置兼容）；安装时空数组 / 空串元素 fail-loud | 协议与运维 | test/migrate-admin.test.ts | 0.20 |
| I-PO-21 | `statsScoped` 与 `visibleAtLevel` 双实现差分等价：`store.statsScoped(level)` 的五个作用域计数 ≡ 以 `visibleAtLevel` 逐行过滤同一全域后重算的计数——等价关系本身是被测对象，实现漂移以差分形式暴露 | 协议与运维 | test/stats-scoped.test.ts（差分等价断言；实现 src/services/memory-store.ts `statsScoped`） | 0.20 |
| I-PO-22 | `memory_remember` 写时结局透明完备：响应必携带 `writeOutcome` 四态之一（created / deduplicated / superseded / conflict-flagged——四态完备，任何写路径不得返回四态之外或缺失结局），并按态携带证据字段（matchedId / similarity / conflictReason）；稀疏嵌入空间（offline-bm25）下非 created 结局附 advisory（提示措辞区分） | 协议与运维 | test/write-outcome.test.ts | 0.20 |

**合计 90 条**：隐私与 ACL 17 · 数据完整性 23 · 检索契约 16 · 数值与文本 12 · 协议与运维 22。（always-on 设计契约守卫 `invariant()` 本身见 I-PO-08 与门禁地图。）

---

## 2. 逐条断言（按类别）

每条一行，断言语气：**违反即红**。执行点详见第 1 节矩阵。

### 2.1 隐私与 ACL（17 条）

- **I-ACL-01** 一切可作用域化的读写——含 forget / restore / purge / inspect 这些破坏性与观测性工具——必须通过 tier + owner 过滤（`buildTierCondition`），任何工具路径不得读写调用者可见/所有权包络之外的行——chaos.test.ts 每步复查，integration.test.ts 场景隔离。
- **I-ACL-02** 匿名调用者只看得见 `global` 层——chaos.test.ts 匿名探针步步断言，风暴终局对 u-a / u-b / 匿名三方复证。
- **I-ACL-03** 任意非 `global` 行对无任何身份的调用者不可见——穷举 ACL 真值表套件（每一 caller 身份 × 每一行 × 每一层，全格无遗漏；0.20.0 已落地），chaos.test.ts 匿名探针兜底。
- **I-ACL-04** store 的 SQL tier 过滤与 JS `visibleAtLevel()` 镜像对同一全域产出**完全相同**的 id 集——genesis-retrieval.test.ts G1：镜像漂移以集合差形式暴露，而不是以跨租户泄漏的形式暴露。
- **I-ACL-05** 逐层加宽（session → workspace → user → global）仅在候选池薄时进行、永不跨 owner 边界、对已扫空的层不再重查——chaos.test.ts / integration.test.ts。
- **I-ACL-06** 私有 mention 建私有实体；一个用户的实体、共现边、子图、路径、社区与 PageRank 永不泄入另一用户的任何分析——integration.test.ts。
- **I-ACL-07** `memory_era` 拒绝匿名调用者，null-owner 时间线摘要桶不得对任何人可见——0.20 post-audit 回归。
- **I-ACL-08** 不可能存在 `visibility='user'` 而 owner 为 NULL 的幽灵行（对每级可见性级联永不可见）——所有实体/条目/模式写入统一经 `resolveWriteTier`（src/utils/scope.ts）落层；genesis-services.test.ts + 0.20 post-audit 回归。
- **I-ACL-09** 核心块同名歧义窄层优先：读由近及远遮蔽匿名 global 块，set/append 只改写调用者自有层块（缺失则新铸）——用户 A 的自我编辑永不落在共享 global 块上——living-core.test.ts / core-memory.test.ts。
- **I-ACL-10** 蒸馏继承所在簇的最窄可见 tier（narrowest-wins：簇内含任何私有行，合并项就落在该私有行的 tier——压缩可收窄可见性、**永不拓宽**）；蒸馏分区键不含 tier，同 owner 跨 tier 的近重复条目可真正合并到最窄 tier；模式挖掘保留含 tier 的分区键（混合 tier 的挖掘组可能把私有模式标成 `global`，那才是拓宽）；合并项的 `entityId` 跟随 tier 代表成员；两 owner 的近同语义条目蒸馏为各自合并项，userId 永不跨簇——test/utils.test.ts（narrowest-tier 回归）/ genesis-services.test.ts #2。
- **I-ACL-11** 分层摘要树按 owner 完全不相交、互不可见；摘要行标 source `system`，摘要输入排除既有 `stratified` 行（无摘要套摘要前缀嵌套）——genesis-services.test.ts #1 / stratify.test.ts。
- **I-ACL-12** 胶囊导出剥除 owner 身份、按 scope 界定边界；导入按 importer 重绑所有权——dimensions.test.ts。
- **I-ACL-13** tool.call / tool.result 事件携带调用者 scope 进入 ingestor（失败工具文本不得蒸馏进匿名 global 层）；空消息负载在事件边界丢弃——0.20 post-audit 回归，chaos.test.ts 工具事件乱流。
- **I-ACL-14** 默认联邦服务面 = 仅 global 层：传输服务器（createFederationServer / createCrdtServer）以**服务器侧** scope 求值请求，serveScope 缺省 `{}` 即匿名级联——session / workspace / user 三层私有内容不经传输外泄；客户端在请求里夹带的任何 scope 身份**不可加宽**服务面（求值永远以服务侧 scope 为准，绝不信线上自报身份）——test/transport-e2e.test.ts（用例 4：user 层条目对远程 0 命中 + 客户端夹带 owner scope 的走私探针仍 0 命中，含本地正控制）+ test/transport-http.test.ts。
- **I-ACL-15** 匿名写入策略三态（`scope.anonymousPolicy`：global / quarantine / reject）在**所有用户面写入边界**强制——message / tool 事件 ingest、`memory_remember`、胶囊 import、`session.end` 蒸馏：缺省（不配置）行为与显式 `'global'` 策略**逐字节等价**（零配置兼容是被断言的性质，不是侥幸——匿名写入落共享 global 层的旧 fail-open 默认原样保留）；`'quarantine'` 把匿名写入落 `__anonymous__` session 桶，该桶对任何持真实 id 的**已识别用户不可见**；`'reject'` 拒收匿名写入——拒绝恒为可观测的业务失败（isError），绝不以异常崩溃 handler——test/anonymous-policy.test.ts（三态 × 全部写入边界）+ test/exhaustive-acl.test.ts（默认面真值表不变，穷举矩阵继续在缺省配置下全绿）。
- **I-ACL-16** 可观测性隔离：工具层的计数必须随调用者作用域求值——`memory_inspect` 等观测工具**永不报告跨租户计数**（语料规模、层分布、实体/边/模式数同属租户边界内的信息）；scoped 计数一律走 `store.statsScoped(level)` / `facade.stats(scope?)`，src/index.ts 工具层禁止裸 `stats()`（unscoped 口径是宿主管理面 API，工具面不可触达）——test/stats-scoped.test.ts（工具层计数对调用者作用域的随动与跨租户不可见性）+ scripts/audit.mjs check 11（工具层禁裸 stats() 静态绊线）。
- **I-ACL-17** session = 共享可见组（DECISIONS D-09 重分类：验证属性）：同一 sessionId 即同一可见组——组内 session 行互见，**跨用户、跨 workspace 亦然**；冒充他人 sessionId 获得组内可见性是**设计内的 bearer-credential 语义**——sessionId 是进入该会话可见组的凭证，持有即授权（弱号触发运行时告警，威胁模型显性化，见 README Scopes）；异 sessionId 严格互斥（看不见对方的 session 行）；**组身份不放大层级**——session 组成员依旧看不见彼此的 user / workspace 层行（加宽仍是逐层 delta、永不跨 owner，I-ACL-05）——test/session-semantics.test.ts（钉死三用例：防止未来被当 bug 误修——给 session tier 叠加 userId 校验的"修复"当场红）+ test/exhaustive-acl.test.ts（穷举面：session tier × 全部 caller 身份组合，960 格真值表 × 3 层 = 2880 格 SQL ⇔ JS ⇔ prophecy 三方评估逐格钉死）。

### 2.2 数据完整性（23 条）

- **I-DI-01** 对已软删内容的精确重插不得复活旧行——genesis-store.test.ts #2。
- **I-DI-02** src 全树禁止 `INSERT OR REPLACE INTO memory_items`（盲目 replace 即墓碑复活类反模式）——scripts/audit.mjs check 4，CI 必红。
- **I-DI-03** ingestTx 批量两阶段原子提交、提交后事务深度必须归零；压缩蒸馏同为严格两阶段事务且保持 owner 元数据——genesis-store.test.ts commit-stamp 检查 / genesis-services.test.ts #2。
- **I-DI-04** 空间迁移的重嵌入不触碰 deleted_at / superseded_by 列，asOf 回闪视图逐项不变——space-migrator.test.ts。
- **I-DI-05** 迁移幂等（再跑无新效果）、预算分批（每 tick N 条、逐批事务）、embedder 降级时拒绝运行、`migratedFrom` 审计留痕——space-migrator.test.ts。
- **I-DI-06** `integrityCheck()` 对净库全零、对注入的孤儿桶行/悬垂实体引用/死树子引用/过期墓碑逐类全数报告；`repairIntegrity()` 只做可证安全的修复（存活引用不误删、悬垂记忆保留不猜）且幂等——genesis-integrity.test.ts #1/#2（不可经公共 API 产生的脏态用第二连接直接播种）。
- **I-DI-07** `backupTo()` 产出可挂载为 store 的 VACUUM INTO 一致快照，且拒绝覆盖已存在目标——genesis-integrity.test.ts #3。
- **I-DI-08** 损坏的 JSON 列经 `safeJson` 降级为 fallback 值，行永不因半损 JSON 整体失败（degraded-but-alive）——运行时 memory-store.ts；chaos.test.ts 风暴全程 stats 有限、整数、非 NaN。
- **I-DI-09** `dataVersion()`（PRAGMA user_version）在一切变更机制下（条目/墓碑/实体/边/purge）单调非降（回绕点降 0 除外——跨回绕的比较身份由 I-DI-21 的 epoch 复合戳接管；chaos 风暴的写入量级不可达回绕）——chaos.test.ts 不变量 b。
- **I-DI-10** 同一 palace 文件上的两个 store 实例互见写入（WAL + busy_timeout = 5000 + 跨连接 user_version）——genesis-integrity.test.ts #4，SWR 失效在多进程下正确的基础。
- **I-DI-11** CRDT：`(lamport, palaceId)` 全序且 palaceId 重启稳定；orTag 以 `@` 分隔携带值级指纹（无歧义解析与合并）；三宫并发随机操作按多种顺序同步最终收敛（强最终一致性）——crdt-federation.test.ts。
- **I-DI-12** Lamport 天花板以 reducer 归约——12.5 万 op 的同步不得炸调用栈——0.20 post-audit 回归，crdt-federation.test.ts。
- **I-DI-13** 胶囊完整性五重：canonical-JSON HMAC 逐字节突变必验签失败（properties.test.ts）；b64 非法字符拒收（genesis-services.test.ts #5）；`maxAgeMs` 拒陈旧重放（dimensions.test.ts / 0.20）；超 2 MiB 拒解析（0.8 工具加固）；逐项字段验证（layer / 重要性区间 / tags / entities / 空内容）带 per-item error id 并统一走 ingestTx（0.20 post-audit）。
- **I-DI-14** 幽灵行必须被审计看见：tier 有值而 owner 列为 NULL 的 LIVE 行（写入侧由 I-ACL-08 的 `resolveWriteTier` 单一落层入口封死，此处看守旁路写入与外部播种的漏网者）必须被 `integrityCheck()` 计数进报告并使 `ok=false`；此类行的修复仅经显式 opt-in——默认 repair 路径不猜、不动——test/genesis-integrity.test.ts + integrityCheck 运行时。
- **I-DI-15** CRDT 同步的增量水位必须持久化且回退安全：每次成功（收敛）同步把对端 per-replica 水位（`{replica: counter}` JSON）持久化到 `crdt:wm:<peerId>`，下次 sync 经 `listCrdtOpsSince` 只发增量；水位缺失、非 JSON、形状损坏一律回退全量交换（op_id 去重吸收重发，永不跳 op）；水位只在收敛后持久化（崩溃至多留下偏低水位 → 下次超集重发，方向安全）；指纹校验恒为全量重放、与交换量无关，若增量交换后指纹不收敛（理论不可能，如断电回滚造出高估水位）则防御性全量重交换一次再校验并修复水位——test/crdt-federation.test.ts（增量 / 损坏水位 / 高估水位自愈用例）+ crdt-federation 运行时（src/services/crdt-federation.ts）。
- **I-DI-16** 胶囊内容寻址的 legacy 永久兼容底线：旧格式 id（8-hex v1 / 16-hex v2）永久可导入——兼容分支不得移除（移除即存量胶囊过期），各代格式的 id 互不污染对方的去重判定（0.20.0 首缓解为 64 位双格式；寻址宽度已由 I-DI-20 升维 128 位 SHA-256 截断，本条看守的兼容语义不变）——test/dimensions.test.ts / test/capsule-cas.test.ts / test/properties.test.ts + src/utils/capsule.ts。
- **I-DI-17** `metadata.visibility` 不得持久化：写路径必须在落库前剥除该键，`visibility` 列是唯一事实源；外部载荷携带的 `metadata.visibility` 仅作写入派生的解释性输入；存量 legacy 行的读侧投票链（`item.visibility ?? item.metadata.visibility ?? 'global'`）兼容保留——src/services/memory-store.ts `insertItem` + test/genesis-services.test.ts。
- **I-DI-18** owner 复合分区键必须以 `\u0000` 拼接——合法 id 字符串中不可能出现的码位，使复合键不可由分段内容伪造碰撞；模式 id（`${ownerKey}::${pattern}`）保持稳定 `|` 格式，存量 id 不迁移不 churn——运行时 src/services/memory-compressor.ts + test/genesis-services.test.ts / test/pattern-miner.test.ts。
- **I-DI-19** CRDT 跨网交换与进程内 sync 同一收敛语义：syncOverHttp 经 HTTP 完成一轮双向 anti-entropy 后双端 `fingerprint()` 必须相等；增量水位（I-DI-15）在网络面同样成立——水位只省传输与对端 apply 量，不改变收敛判定（指纹恒全量重放），新增 N 个 op 后的下一轮交换增量计数恰为 N；水位持久化且崩溃 / 损坏回退全量交换（op_id 去重吸收重发，方向安全）——test/transport-crdt.test.ts + test/transport-e2e.test.ts（用例 2：真实 HTTP 上 3+3 op 双向收敛、再写 2 op 增量恰为 2）+ src/services/crdt-federation.ts。
- **I-DI-20** 胶囊内容寻址为密码学级 CAS（DECISIONS D-02 终态）：新导出 id 一律为 SHA-256 截断 128 位（`cap:` + 32 hex——对蓄意构造碰撞具有 SHA-256 级抗性，FNV 族不具备，而胶囊走不可信跨 agent 信道；生日界 50% 需 2^64 ≈ 1.8×10¹⁹ 条）；`parseCapsule` 按 id 长度分派三代验证（8-hex v1 / 16-hex v2 / 32-hex v3 各按本代算法重算匹配，其他长度/非 hex 拒收并在错误消息中列全三代期望格式）；同胶囊内同 id 而 normalizedContent 不同即地址碰撞——fail-loud 抛 `[capsule] content-address collision detected: <id>`（导出函数 `assertNoAddressCollisions` 可直测；逐项重算通过后仅当存在真实同代摘要碰撞才可达——对 v3 即哈希被破）；`parseCapsule` 置 `legacyAddressCount` 观测（8/16-hex 项计数，排除在 HMAC 规范形之外，签名/验签不受影响）——test/capsule-cas.test.ts（v3 确定性 + 独立 SHA-256 重导一致、三代同胶囊共存 + legacyAddressCount、绊线直驱 + 真实 v1 生日碰撞经 parseCapsule 全链路、v3/v2/v1 代际分离、1 MiB 性能锚点）。
- **I-DI-21** 版本戳为 epoch 命名空间复合串（DECISIONS D-08 终态）：缓存失效身份必须是 `dataVersionStamp()` 返回的 `<epoch>:<user_version>` 字符串——裸 `dataVersion()` 仅存于 stats/诊断面（其数值在回绕处别名：epoch E 的 V 与 epoch E+1 的 V 是不同数据态却数值相等）；计数器抵达 2147483647 的下一次 bump 必须在**同一事务**内完成 `user_version = 0` ∧ palace_meta `dataVersionEpoch` +1（standalone 路径显式事务、ingestTx 内并入既开事务——崩溃不得撕出"已清零而未升 epoch"的窗口）；跨 epoch 的复合戳比较**必失配**——回绕后旧条目（携带旧 epoch）只 miss，假新鲜不可表示；全部版本键控缓存（SemanticQueryCache、retriever dataStamp、PageRank SWR `graphVersion()`）一律以复合戳为键；多进程方向性：epoch 只增，本进程视图只可能滞后，version-下降（读值低于本进程上次所见，WAL 令外部回绕可见）触发重读 palace_meta，刷新只产生不可比（miss = 重算），永不产生相等（假命中）——test/fault-injection.test.ts（场景 3：外接连接推戳至 2147483646——复合戳格式、回绕恰升 epoch+1 且持久于 palace_meta 外连接可读、**假新鲜死亡证明**（pre-wrap 缓存条目在回绕后任意复合戳上恒 miss）、回绕后周期 epoch 段稳定 version 段重新计数、外连接自行回绕后本进程经 version-下降检测采纳外来 epoch 且旧命名空间条目 miss）+ 实现 src/services/memory-store.ts（`dataVersionStamp` / `bumpDataVersionNow` / `loadVersionEpoch`）；计数器单调面仍由 I-DI-09 看守。
- **I-DI-22** 量化模式守卫：库文件以 `palace_meta` 的 `quantization` 戳声明自身的编码模式（首开落戳；pre-0.21 无戳库首次在本版本下重开时按当前模式落戳——历史模式不可知，防护面向未来切换）；以与落戳不同的 `retrieval.quantization` 模式重开同一库文件，构造器必须**先关句柄再 fail-loud 抛错**（错误消息指明两种模式与重开指引），绝不以错误的字节宽度静默解释全部 embedding blob——int8 ⇄ float32 误开是最安静的全文向量损坏（存储 4 bytes/dim vs 1 byte/dim，错读无异常、只有检索质量无声塌陷）——test/genesis-store.test.ts（int8 建库 float32 重开必抛、同模式重开正常）+ 运行时 src/services/memory-store.ts（构造器 meta 戳检查）。
- **I-DI-23** 胶囊签名对解析归一化不敏感：`signCapsule` 与 `verifyCapsule` 一律在 unsignedView（剥离 signature/legacyAddressCount、补齐缺失的逐 item `tags`/`entities` 与顶层 `patterns` 为 `[]`）上计算 HMAC——与 `parseCapsule` 产出的归一形状一致；因此第三方导出者**省略可选字段**签名的胶囊，经 parse 补默认后仍可验签（修复前必失败且表象是"tampered?"）；字段齐全的胶囊（全部第一方导出）归一化为 no-op，签名逐字节不变，一切旧签名继续有效；观察字段 `legacyAddressCount` 仍排除在规范形之外——test/capsule-cas.test.ts（稀疏 capsule sign→parse→verify、篡改拒绝、齐全往返兼容）+ 实现 src/utils/capsule.ts。

### 2.3 检索契约（16 条）

- **I-RC-01** 查询缓存键完备：同文本而异 filters / fusionOverrides 的查询永不互取对方结果（六参数变体互不命中）；`stableFusionKey` 把 `undefined ≡ {} ≡ {arm: undefined}` 归一到同一分区——genesis-retrieval.test.ts G4。
- **I-RC-02** 语义缓存命中必须通过锚桶 + cosine ≥ 0.985 双重验证；缓存以版本戳整体失效（复合戳 `dataVersionStamp()`，I-DI-21；宁失勿陈）——retrieval-kernel.test.ts。
- **I-RC-03** `finalScore` 恒为 [0, 1] 内的概率：融合前各因子钳制、融合 clamp01 关两端、bandit 覆写先钳入 ARM_RAILS（`clampedArmOverride` 双保险）——chaos.test.ts 不变量 e / feedback-bandit.test.ts。
- **I-RC-04** hits.length ≤ topK；每个命中的 `via` ∈ {vector, entity-hop}——chaos.test.ts 不变量 e。
- **I-RC-05** 来自不同嵌入空间的向量永不被点积——MMR 对跨空间对回退 Jaccard token 重叠——memory-retriever.ts 跨空间守卫（每空间隔离另见 quantize.test.ts 双维语料）。
- **I-RC-06** IVF 精确性梯子：全半径探针与精确扫描产出相同 id 与相同分数（C1）；半径升级只探桶集差集、[r, r+1, MAX] 梯子的累计键并集 === `keysWithin(MAX)` === 精确扫描键集、池不满时终于全键精确扫描（C3 / G2a）——索引是纯加速器，召回永不依赖它。
- **I-RC-07** IVF radius-1 对精确扫描的实测 recall@10 ≥ 0.8，在 ≥400 条、128 与 256 维双档确定性语料上成立——ivf-index.test.ts C2 / genesis-retrieval.test.ts G2b。
- **I-RC-08** 实体跳扩的图导二过与向量一遍走**同一条**门控扫描（tier / owner / 时间窗 / asOf）——genesis-retrieval.test.ts / integration.test.ts。
- **I-RC-09** 带外 `opts.graphBoost`（0.9 / 5 / −3）不可能把图乘子移出 [1−0.5, 1+0.5]；节点集过滤后 PageRank 质量守恒（Σrank ≈ 1）——genesis-retrieval.test.ts G3 / properties.test.ts（100 随机图）。
- **I-RC-10** 轨迹查询 owner 锚定：userId 过滤优先、workspaceId 回退、双无返回空——工作域空宫不再静默哑火 Markov 预测——genesis-integrity.test.ts #5。
- **I-RC-11** 联邦检索合并的每一行都来自某成员宫**自己选择返回**的结果（ACL 各宫自施）；失败成员被断路器隔离、超时有界，不拖垮其余成员——federated-retriever.test.ts。
- **I-RC-12** 语义缓存命中充分性由全量兜底保证：锚桶定位未命中时，必须对缓存内全部条目（容量有界）再做一遍 cosine ≥ 0.985 裁决——近重复查询的命中与否**不得依赖锚桶几何**；兜底扫描永不放宽阈值（宁失勿陈不变）——test/retrieval-kernel.test.ts + src/utils/query-cache.ts。
- **I-RC-13** 反馈信号信息量：`memory_why` 与 query 模式 `memory_capsule_export` 派生的 reward 必须随排序质量变化——why 以实体名为零副作用 speculative 探针（不污染访问计数 / 轨迹）取证据排位的 DCG 折扣（`1/log₂(rank+2)`，证据排得越前 reward 越高），export 以 `0.6·avgScore + 0.4·diversity` 复合计酬（切题 × 不冗余）；任何一处 reward 退化为恒定值即违规（forget 的 reward 0 是负通道语义、entity/all 导出是 bulk 策展而非排序评判，恒定是它们的正确形状，不在本条辖内）——test/feedback-signals.test.ts（双向信息量断言）+ src/index.ts learn 接线。
- **I-RC-14** 写时数值漂移必走替代 / 冲突路径（DECISIONS D-11 缓解决议的 correctness 核心）：相似度达到去重线（`retrieval.writeDedupeThreshold`，缺省 0.92）且矛盾检测命中的新事实——"v16"→"v17" 类数值漂移——**永不静默丢失、永不静默吞并**：绝不走去重合并返回既有 id，必落新行；`supersede:true` 时旧版本入墓碑替代链（supersession chain，审计可追），未替代时以冲突报告浮出（conflictReason 可见）；去重合并仅在"高相似 ∧ 无矛盾"时发生——相似度与矛盾**共同裁决**分流，任何把裁决退化为"高相似即合并"的回归即违规——test/write-outcome.test.ts（旗舰）+ test/integration.test.ts（supersede 段）。
- **I-RC-15** 投机预热形状齐平：learner 启用（`retrieval.fusionLearning.enabled`，默认开）时，`session.start` 的投机预热必须携带与生产 `memory_retrieve` 工具**相同形状**的贪婪 `fusionOverrides`——查询缓存 paramsKey 含 `stableFusionKey`，形状不同即分区永不相交，预热的嵌入调用与管线开销全部落空且无从观测；预热失败/降级仍按 best-effort 静默；每第 10 次检索的探索步（nudge 后的覆写值）是故意的独立分区，不在预热责任内——test/intent-trajectory.test.ts（session.start 预热后 memory_retrieve 命中 cacheHit 的回归；修复前预热分区与工具分区不相交、必 miss）+ 实现面 src/index.ts（session.start warm 接线）。
- **I-RC-16** 中文实体抽取多信号门（DECISIONS D-16 缓解决议）：中文实体候选只能来自三档精度信号——**引号 span**（「」『』【】“”，用户显式标记）、**系统名词后缀锚定**（后缀必须处于名词短语结尾位置：run 末尾 / 胶着字 / 连接词之后——防碎片；向左 ≤5 字走查停在单字胶着字或连接词串——依赖/部署在 恰是实体提及间的分界）、**消息内精确重复**（≥2 次、无胶着字、最长保真）——全部过 CJK 停用词门与 2–8 字长度门；CJK 通道至多占 8 个名额，handle/path/url/tag naturals 优先级不变、总配额 32 不变；**纯 ASCII 文本不得产生任何 cjk 候选**（英文抽取路径逐字节不变——回归钉死）；抽取出的 CJK 名单必须能喂给 CN 连接词的 typed-relation 抽取（「告警服务依赖 Kafka」产 depends-on 边）；classify 的项目/计划后缀规则对 Han 复合词（数据迁移项目）生效——test/utils.test.ts + 实现 src/services/memory-graph.ts。

### 2.4 数值与文本（12 条）

- **I-NT-01** 分块器码点安全——永不把代理对切成两半（星光面 CJK 整码点成词）；且严格推进——每个分块使光标前进、序列有序无重复、源偏移精确——genesis-utils.test.ts / properties.test.ts（种子化 200 输入）；chaos.test.ts emoji 载荷。
- **I-NT-02** CJK 连续段切重叠 bigram、孤字单列、英文不受扰；token 预算按字符计（5 个汉字 ≈ 5 token，绝非 1）——hardening.test.ts B1。
- **I-NT-03** int8 量化对精确 float32 扫描的余弦误差有界、端到端召回保持；每维 1 字节存储（~4× 密化）；`float32` 模式恒可回退精确——quantize.test.ts。
- **I-NT-04** 熔断 half-open 状态挂真·单探针闩——一次试探定开合，探针期间不并发放行——genesis-utils.test.ts。
- **I-NT-05** bandit 权重活动在默认值 ±20% 硬轨内：内核写钳 + 消费端 `clampedArmOverride` 再钳，越轨覆写永不触达融合（融合侧兜底见 I-RC-03）——feedback-bandit.test.ts / genesis-retrieval.test.ts G3。
- **I-NT-06** 零命中信号学不到任何东西、不落任何奖励事件（无 0/0 NaN 路径）；不可能的过度参与被钳——genesis-services.test.ts #4。
- **I-NT-07** NaN / Infinity 数值输入（topK、minScore、budget、era 窗口、fed-search topK、CLI `--topk`）回退默认值后再走钳制链，SQL 侧永不见非有限数；`memory_graph` expand 的 hops 缺省对齐 schema 值 3；`memory_bandit` reset 校验臂名——chaos.test.ts 畸形输入 / 0.20 post-audit 回归。
- **I-NT-08** 数值签名原子性：日期与版本作为原子条目成签（padding 归一），绝不碎成互相碰撞/遮蔽的数字碎片——consensus.test.ts。
- **I-NT-09** 中文否定极性：肯定习语（不错 / 不断 / …）不计为否定，真否定（不会 / 没有 / …）计为否定——consensus.test.ts。
- **I-NT-10** 时间习语负向 lookahead 守卫："last weekly report" / "this weekly sync" 不泄漏成"上周 / 本周"窗口，而真习语（"last week" / "上个月" / "最近 3 天"）仍被识别——query-understanding.test.ts（固定 NOW，窗口精确）。
- **I-NT-11** 字节流边界卫生：MCP stdio 超过 64 KB 的载荷分块并以 `setImmediate` 让写（代理对安全——巨量同步管道写不得饿死 5 s 硬退计时器成 Windows 僵尸进程）；CLI 剥离 ingest 导出文件的 UTF-8 BOM——▲ 物理错误注入套件（0.20.0 已落地：test/exhaustive-acl.test.ts）/ 0.20 post-audit 回归。
- **I-NT-12** 检索期词干折叠的边界与确定性：`stem()` 只在检索器关键词匹配阶段消费（overlapScore 与 phraseHits 的 stem 域比较），**永不进入 embedding tokenize、offline BM25 哈希或任何向量空间输入**——稀疏/哈希嵌入空间的稳定性以"同一未折叠词表"为前提，单侧喂入折叠词元等于静默改写全部存量向量的语义；查询缓存 paramsKey 除固定 `STEM_RULESET_VERSION` 版本常量外语义不变（折叠是匹配期行为、非查询身份——规则升级/回退不得跨规则集串缓存）；折叠规则确定性且双侧一致（接受 movies → movy 类过折叠，折叠一致性优先于语言学精确）——test/stemmer.test.ts（规则表、确定性、CJK 原样、excludingQueryStems）+ test/retrieval-kernel.test.ts（retriever 接入行为、旗舰 "how does aurora deploy?" ↔ "deploys" 回归、不相关查询不误中）。

### 2.5 协议与运维（22 条）

- **I-PO-01** tools/call 的 `arguments` 为数组时以 -32602 拒收，绝不当参数袋解构——genesis-entries.test.ts。
- **I-PO-02** 未知工具 → -32602（坏参数），未知方法 → -32601（方法不存在）——码位分工是 JSON-RPC 契约的一部分——genesis-entries.test.ts。
- **I-PO-03** 业务失败映射 `isError: true`、成功映射 false——客户端不解析 content 即可分支——genesis-entries.test.ts。
- **I-PO-04** notification（无 id）永不产生带 id 的响应；initialize 只回显本地方言说过的版本——genesis-entries.test.ts。
- **I-PO-05** 元数据三同步：版本 package.json === plugin.json === src/types `VERSION`（audit check 1）；工具数 plugin.json 工具数组 === README 工具表行 === `buildToolDefinitions` 定义数（当前 15，audit check 2）——scripts/audit.mjs，verify / CI / prepublishOnly 必经。
- **I-PO-06** 静默绿灯与噪音禁令：src 无 console.*（src/bin 入口豁免，与 eslint.config.js 镜像、注释行豁免）；test 无 `.skip(` / `xit(` / `xdescribe(`——一次跳过即一扇静默绿灯，非法——scripts/audit.mjs check 3 + check 6。
- **I-PO-07** memory-store 禁单句 `DELETE FROM … ORDER BY … LIMIT`（SQLite 编译期选项扩展）；可移植形为 `WHERE id IN (SELECT …)` 子查询——scripts/audit.mjs check 5（`// audit-ok` 行内豁免供人工确认的误报）。
- **I-PO-08** SQL 具名参数双向奇偶：语句中每个 `@ref` 必有 bind 键、每个 bind 键必被引用，违者抛 `[invariant] named-parameter parity broken`——运行时常开（src/utils/invariants.ts `assertNamedParamParity`，五态词法机跳过字符串/注释中的伪引用）+ genesis-store.test.ts #3。同文件的 `invariant()` 是全树 always-on 设计契约守卫：违反不可恢复假设须在第一执行点崩溃，绝不静默产出错数据。
- **I-PO-09** dryRun 覆盖全部变更分支——purge 这一唯一不可逆分支也必须 honor（`wouldPurge` 只预览计数、不删任何行）——0.20 post-audit 回归（实现 src/index.ts）。
- **I-PO-10** 导入规划探针以 `speculative` 运行（不污染访问计数与轨迹）；胶囊条目缺嵌入时经嵌入网关回填并报告降级警告，不静默丢——0.20 post-audit 回归 / genesis-services.test.ts。
- **I-PO-11** 发布必经 verify 链 `npm run lint && npm run build && npm test && npm run audit`（prepublishOnly 钦定）；CI 在 Node 22 + 24 双矩阵（fail-fast 关闭）全腿跑 audit，node 22 腿对 MCP 二进制冒烟（initialize + tools/list，断言 memory_retrieve / memory_reflect 在列）——package.json / .github/workflows/ci.yml。
- **I-PO-12** bench 门禁：bench-baseline.json 中每个**计时**指标超 2× 基线即 exit 1；信息性比值（IVF 加速比、int8 加速比）永不门禁（对手变快时它们合法双向移动）；`--update` 只在完整尺度重录基线（smoke 运行永不收缩基线）；`--smoke` 为 1/5 尺度打印不门禁——scripts/bench.mjs。
- **I-PO-13** src/ 全树禁止 `Math.max(...)` / `Math.min(...)` 的 spread 直接展开——N 个元素即 N 个调用实参、N 个栈槽，12.5 万元素的 CRDT 同步曾当场炸掉调用栈（I-DI-12 的静态面）；大输入必须走 reducer 归约，标量用法（`Math.max(0, x)`）不受限，注释中的墓碑提及不误伤——scripts/audit.mjs check 7。
- **I-PO-14** src/services/memory-store.ts 中 `JSON.parse(` 的出现次数恒等于 1——唯一合法点是 `safeJson` 辅助函数内部（I-DI-08 的执行面）；任何第二处解析——即使各自裹了 try/catch——都会碎片化降级策略，让一个损坏单元格瘫痪触及该库的整条读路径——scripts/audit.mjs check 8。
- **I-PO-15** scripts/*.mjs 的路径解析必须走 `fileURLToPath(new URL(...))`，禁止裸读 URL 的 pathname 属性——含空格或非 ASCII 段的 checkout 路径上它是百分号编码且带前导斜杠的假路径，曾让门禁 3/6 项以幻影 ENOENT 集体误红——scripts/audit.mjs check 9。
- **I-PO-16** 本规格书引用的每个 `test/*.test.ts` 执行点文件必须真实存在于仓库——规格指向不存在的执行点，等于承诺一个不在岗的哨兵（静默绿灯）；零可提取引用本身即违规（规格被清空或提取器损坏）——scripts/audit.mjs check 10。
- **I-PO-17** `memory_migrate` 的 live 迁移必须要求显式 `confirm: true` 才执行——缺失确认即拒绝并说明确认要求，绝无静默放行的全库副作用；`dryRun`（碎片化诊断预览）无需确认自由调用——test/space-migrator.test.ts + src/index.ts（memory_migrate 确认门）。
- **I-PO-18** 显式 reward 通道合法域：调用方显式提供的 reward 必须是有限数，经 clamp01 钳入 [0,1] 后才可入账；NaN / Infinity 零写入——不更新 bandit 状态、不落 reward 事件、不 emit（派生信号算错也不得毒化衰减累加器，与 I-NT-07 的"非有限数回退"同一纪律在 feedback 通道的投影）——test/feedback-bandit.test.ts + src/services/feedback-learner.ts（learn 钳制链）。
- **I-PO-19** 传输认证与线上守卫：联邦检索与 CRDT 传输对**无签名**与**错签名**请求一律 401（HMAC 对等认证，canonical-JSON 摘要，`timingSafeEqual` 恒时比较——签名比较不得短路，杜绝逐字节时序侧信道）；请求体超过体积上限 413；慢端 / 死端被超时守卫截断（检索成员超时计入 degradedMembers、CRDT 客户端超时拒绝），任何方向的失败都不得挂死调用方；检索命中载荷**线上默认剥离 embedding**（向量不出服务面）——test/transport-http.test.ts + test/transport-crdt.test.ts（401 / 413 / 超时 / 剥离逐项）+ test/transport-e2e.test.ts（用例 1/3：真实 HTTP 跨宫面上的剥离与 401 端到端）。
- **I-PO-20** `memory_migrate` 的 live 迁移双门（DECISIONS D-04 终态）：`scope.adminUserIds` 一经配置（非空白名单），live 执行必须同时满足调用者 **userId ∈ 白名单成员身份** 与显式 **`confirm: true`**——缺任一即拒绝；匿名调用者（无 userId，成员身份无从谈起）与非成员在已配置下**必拒（fail-closed）**；未配置时保持单用户信任模型——confirm 单门，行为与既往零配置版本逐字节一致（零配置兼容是被断言的性质）；`dryRun` 碎片化诊断不受白名单约束自由调用；安装时对**空数组 / 空串元素 fail-loud**（配置了却拦不住任何人的白名单是假门——宁在安装期响亮拒绝，不静默退回单用户模型）；MCP 独立服务器经 `MEMORY_PALACE_ADMIN_IDS` 注入同一白名单——test/migrate-admin.test.ts（与 I-PO-17 的 confirm 门、I-DI-05 的迁移安全护栏互补成三面）。
- **I-PO-21** `statsScoped` 与 `visibleAtLevel` 双实现差分等价（DECISIONS D-01 缓解决议）：`store.statsScoped(level)` 的五个作用域计数必须与"以 `visibleAtLevel` 逐行过滤同一全域后重算"的计数**完全一致**——等价关系本身是被测对象，实现漂移以差分（集合/计数差）的形式在 CI 暴露，而不是以跨租户计数泄漏的形式在生产暴露（与 I-ACL-04 的 SQL≡JS 镜像同一纪律在可观测性面的投影）——test/stats-scoped.test.ts（差分等价断言）+ 实现 src/services/memory-store.ts `statsScoped`。
- **I-PO-22** `memory_remember` 写时结局透明且完备（DECISIONS D-11 缓解决议）：响应必须携带 `writeOutcome` 四态之一——`created`（净新写入）/ `deduplicated`（高相似 ∧ 无矛盾 → 合并返回既有 id）/ `superseded`（冲突 ∧ `supersede:true` → 新行落地 + 旧版本墓碑替代链）/ `conflict-flagged`（冲突 ∧ 未替代 → 新行落地 + 冲突报告，不替代）——四态**完备**：任何写路径不得返回四态之外或缺失的结局（一切 remember 的结局都可被调用方判读，无静默路径）；各态按适用性携带证据字段（`matchedId` / `similarity` / `conflictReason`），使合并 / 替代 / 冲突均可归因到具体目标与相似度；稀疏嵌入空间（offline-bm25 主空间）下非 created 结局附 **advisory**（提示模型以实质不同措辞重写需区分的事实——提示词事项升格为运行时反馈回路）——test/write-outcome.test.ts。

---

## 3. 门禁地图

一道变更要进入 main，须穿过下面每一道闸；每道闸看守的类别如下。

| 闸门 | 命令 / 位置 | 看守类别 |
|---|---|---|
| 类型级 | `npm run lint`（eslint 9 **strictTypeChecked** 全档——no-non-null-assertion/unnecessary-condition/confusing-void/deprecated 调用巡查等；src/bin 同档仅豁免 no-console；test 按文档化豁免 fixture 敌对规则 + `tsc --noEmit`（strict + noUncheckedIndexedAccess + **exactOptionalPropertyTypes + verbatimModuleSyntax + noUnusedLocals/Parameters**），CI 第一步） | 协议与运维（console 禁令、类型面、死代码）、数值与文本的编译期部分 |
| 构建 | `npm run build`（tsc 产物，供 bench 与 CI 冒烟使用） | 任何破坏构建的变更 |
| 行为级 | `npm test`（node --test 全套：genesis-*、hardening、integration、chaos、properties、ivf、quantize、crdt-federation、federated-retriever、transport-http、transport-crdt、transport-e2e、stratify、space-migrator、feedback-bandit、living-core、core-memory、consensus、query-understanding、retrieval-kernel、dimensions、pattern-miner、intent-trajectory、inference、utils） | 全部五类不变量的测试执行点（见第 1 节矩阵） |
| 发布卫生 | `npm run audit`（scripts/audit.mjs，11 项检查） | I-DI-02、I-PO-05 … I-PO-07、I-PO-13 … I-PO-16、I-ACL-16（元数据三同步 ×2、console 与 skip 禁令、墓碑复活反模式、可移植 DELETE、四条静态绊线与规格防漂移、工具层观测隔离绊线） |
| 静态绊线·栈安全 | scripts/audit.mjs check 7：src 禁 `Math.max(...)` / `Math.min(...)` spread 展开 | 协议与运维（I-PO-13，I-DI-12 静态面）——大数组实参栈溢出类（12.5 万 op CRDT 同步曾炸栈） |
| 静态绊线·读路径降级 | scripts/audit.mjs check 8：memory-store.ts 的 `JSON.parse(` 恒为 1 处（safeJson） | 数据完整性 + 协议与运维（I-PO-14，I-DI-08 执行面）——损坏单元格瘫全库读类 |
| 静态绊线·路径编码 | scripts/audit.mjs check 9：scripts/ 禁裸读 URL pathname，须 fileURLToPath | 协议与运维（I-PO-15）——空格 / 非 ASCII checkout 路径全门禁误红类 |
| 规格防漂移 | scripts/audit.mjs check 10：INVARIANTS.md 引用的 test/*.test.ts 必须在树 | 协议与运维（I-PO-16）——规格书执行点不得悬空 |
| 静态绊线·工具层观测隔离（0.20.0） | scripts/audit.mjs check 11：src/index.ts 工具层禁裸 `stats()`——观测性计数必须走 `statsScoped` / `facade.stats(scope?)` | 隐私与 ACL（I-ACL-16）——工具面跨租户计数泄漏类（inspect 报告他租户语料规模 / 层分布 / 实体边模式数） |
| 随机风暴 | chaos.test.ts（mulberry32 固定种子，`CHAOS_SEED=<n>` 换轨迹复现；▲ 0.20.0 升级为多种子驱动 + 收缩器） | ACL 每步复查（a）、dataVersion 单调（b）、store 健康（c）、零未处理 rejection（d）、检索形状与分数域（e） |
| 蜕变与差分 | ▲ 蜕变关系（test/metamorphic.test.ts，已落地）；差分：genesis-retrieval G1（SQL≡JS）、ivf C1（IVF≡精确） | 检索契约（实现间等价关系） |
| 物理故障 | ▲ 物理错误注入（test/fault-injection.test.ts，已落地） | 数据完整性（磁盘 / 管道 / SQLite 故障下的存活与降级）、I-NT-11 字节流卫生 |
| 性能回归 | `npm run bench`（4 基准 × 中位数，2× 基线门禁；`--smoke` CI 友好） | 数值与文本（量化、tokenizer 的性能面）、检索契约（扫描路径）的性能侧 |
| 协议冒烟 | CI node 22 腿：initialize + tools/list 二进制管道实测 | 协议与运维（MCP 服务器可起、工具清单完整） |
| 运行时常开守卫 | src/utils/invariants.ts（`invariant` / `assertNamedParamParity`）、`resolveWriteTier` 单一落层入口、retriever 的 clamp 链与 ARM_RAILS | 不可静默违反的假设（I-PO-08、I-ACL-08、I-RC-03）——在第一执行点崩溃，而非事后错数据 |
| 缓解决议守卫（0.20.0） | src/index.ts（memory_migrate `confirm:true` 确认门）、src/services/memory-store.ts `insertItem`（剥除 metadata.visibility）、src/utils/capsule.ts（128 位 SHA-256 截断寻址 + 三代格式兼容 + 碰撞绊线）、src/utils/query-cache.ts（lookup 全量兜底扫描）、src/services/memory-compressor.ts（owner 分区键 `\u0000` 拼接） | I-PO-17、I-DI-16 … I-DI-18、I-DI-20、I-RC-12——DECISIONS D-02（终态已消除）/04/05/10/12 五项缓决决议的运行时面；测试面在行为级（test/space-migrator、genesis-services、retrieval-kernel、dimensions/properties、pattern-miner、capsule-cas） |
| 词法折叠边界（0.20.0） | test/stemmer.test.ts + test/retrieval-kernel.test.ts（stem 规则表与确定性、retriever 三接入点行为、paramsKey 版本常量、旗舰 deploy↔deploys 回归与不相关查询对照组）；实现面 src/utils/stemmer.ts + src/services/memory-retriever.ts | 数值与文本（I-NT-12：stem 域仅限检索期匹配，禁入 embedding tokenize / offline BM25 哈希；D-07 部分缓解的检索侧） |
| 反馈信号信息量（0.20.0） | test/feedback-signals.test.ts（双向信息量：why 探针排位衰减、export 分数×多样性复合、forget 恒 0 负通道）+ test/feedback-bandit.test.ts（显式 reward 合法域）；实现面 src/index.ts 三处 learn 接线 + src/services/feedback-learner.ts | 检索契约（I-RC-13：派生 reward 恒定即违规）+ 协议与运维（I-PO-18：显式 reward 钳制链）——DECISIONS D-03 缓解决议的测试面 |
| 联邦传输（0.20.0） | test/transport-http.test.ts（检索面：HMAC 401 / 413 / 超时 / embedding 剥离 / serveScope 边界）+ test/transport-crdt.test.ts（CRDT 面：跨网收敛 / 增量水位 / 401）+ test/transport-e2e.test.ts（双宫殿真实 HTTP 端到端：跨宫检索、跨网收敛、错密钥 401、私有层不外泄）；实现面 src/transport/（零依赖 node:http，经 services barrel 再导出） | 隐私与 ACL（I-ACL-14：默认服务面仅 global）、协议与运维（I-PO-19：传输认证与线上守卫）、数据完整性（I-DI-19：跨网收敛与增量水位）——DECISIONS D-06 缓解决议的测试面 |
| 匿名写入策略（0.20.0） | test/anonymous-policy.test.ts（三态 × 全部用户面写入边界：message / tool / remember / import / session.end——默认 ≡ 显式 global 逐字节等价、quarantine 桶对已识别用户不可见、reject 拒收不崩 handler）+ test/exhaustive-acl.test.ts（默认面穷举真值表不变）；MCP 入口面 src/bin/mcp-palace.ts（MEMORY_PALACE_ANON_POLICY 三态白名单，非法值 stderr 警告回退 global + 启动横幅输出当前策略） | 隐私与 ACL（I-ACL-15）——DECISIONS D-15 缓解决议的测试面与入口面 |
| 管理员白名单（0.20.0） | test/migrate-admin.test.ts（配置后成员身份 ∧ confirm 双门、匿名 / 非成员 fail-closed 拒、未配置 confirm 单门零配置兼容、安装期空数组 / 空串元素 fail-loud）；配置面 `scope.adminUserIds`（config 键）+ MCP 入口 `MEMORY_PALACE_ADMIN_IDS` 环境变量 | 协议与运维（I-PO-20：live migrate 双门）——DECISIONS D-04 终态（已消除）的测试面；与 I-PO-17（confirm 门）、I-DI-05（迁移安全护栏）互补 |
| 版本戳回绕防护（0.20.0） | test/fault-injection.test.ts 场景 3（外接连接推 user_version 至 ceiling：回绕恰升 epoch+1 且持久于 palace_meta、假新鲜死亡证明（pre-wrap 缓存条目在回绕后任意复合戳上恒 miss）、回绕后周期 epoch 段稳定 version 段重新计数、多进程外连接回绕经 version-下降检测被本进程采纳且旧命名空间条目 miss）；实现面 src/services/memory-store.ts（`dataVersionStamp()` 复合戳 / `bumpDataVersionNow` 回绕双写同事务 / `loadVersionEpoch` 滞后安全）+ 消费面 src/utils/query-cache.ts、src/services/memory-retriever.ts、src/services/memory-graph.ts（`graphVersion()` 复合化） | 数据完整性（I-DI-21：epoch 命名空间复合戳、回绕必升 epoch、跨 epoch 比较必失配、多进程 epoch 滞后方向安全）——DECISIONS D-08 终态（已消除）的测试面与运行时面；计数器单调面仍由 I-DI-09 / chaos 不变量 b 看守 |
| Scoped observability（0.20.0） | test/stats-scoped.test.ts（statsScoped 五计数与 `visibleAtLevel` 过滤的差分等价、工具层计数随调用者作用域 / inspect 不报告跨租户计数）；实现面 src/services/memory-store.ts `statsScoped(level)` + src/index.ts（`facade.stats(scope?)` scoped 重载、memory_inspect 全 scoped 计数、`stats().byTier` 租户分布遥测）；静态面 scripts/audit.mjs check 11（工具层禁裸 `stats()`） | 隐私与 ACL（I-ACL-16：可观测性隔离）+ 协议与运维（I-PO-21：statsScoped ≡ visibleAtLevel 差分等价）——DECISIONS D-01 缓解决议的测试面与绊线面 |
| Session semantics pinning（0.20.0） | test/session-semantics.test.ts（钉死三用例：同 sessionId 跨用户 / 跨 workspace 互见、异 sessionId 互斥、session 组不加宽到 user 层）+ test/exhaustive-acl.test.ts（穷举面：960 格真值表 × 3 层 = 2880 格三方评估）；运行时面：弱 sessionId 告警（bearer-credential 威胁模型显性化——宿主应铸造不可猜测的会话号） | 隐私与 ACL（I-ACL-17：session = 共享可见组的 bearer 凭证语义、异组互斥、组不放大层级）——DECISIONS D-09 重分类（验证属性，退出风险登记册）的测试面与运行时面 |
| 写时结局透明（0.20.0） | test/write-outcome.test.ts（旗舰：数值漂移必走替代 / 冲突路径、writeOutcome 四态完备且携带证据字段）+ test/integration.test.ts（supersede 段）；实现面 src/index.ts（memory_remember writeOutcome 四态 + 稀疏嵌入下 advisory）；配置面 `retrieval.writeDedupeThreshold` / `retrieval.conflictScanThreshold`（缺省 0.92 / 0.75，未配置逐字节兼容） | 检索契约（I-RC-14：带冲突的高相似新事实永不静默丢失或静默吞并）+ 协议与运维（I-PO-22：writeOutcome 四态完备且携带证据字段）——DECISIONS D-11 缓解决议的测试面与配置面 |

链条关系：`npm run verify` = lint → build → test → audit，`prepublishOnly` 钦定必经；CI 把同一链条铺到 Node 22 / 24 双腿并加 MCP 冒烟。

---

## 4. 如何新增不变量

修一个 bug 时，把它升维成一条命名不变量，四步：

1. **先写回归**。在离 bug 最近的测试文件加一个确定性用例（固定种子 / 注入时钟 / 一次性 SQLite 文件；Windows WAL 钩子顺序——store-close 钩子必须注册在目录删除钩子**之前**，否则 rmSync 撞开着的 WAL 句柄 EPERM）。断言写成普适性质（"任何 X 永不 Y"），不是"这条输入出这条输出"。
2. **选择正确的执行层级**。
   - 性质可由现有套件看守 → 加进对应文件（chaos 的跨切不变量复查、genesis-* 的差分/收口、hardening 的一修一测）。
   - 属于结构反模式（源码里就不该出现的形状）→ 在 scripts/audit.mjs 加一道 check，让它在 lint/test 之前就把 CI 拦红。
   - 属于"违反即不可恢复"的运行时假设 → 用 src/utils/invariants.ts 的 `invariant()` / `assertNamedParamParity` 守在第一执行点。
   - 属于两实现间等价关系 → 差分测试（参照 genesis-retrieval G1 的写法）。
3. **登记本表**。在总览矩阵加一行（编号 I-\<类别\>-NN、断言、执行点、来源轮次），并在第 2 节写一行断言语气表述。执行点必须写实：grep 过文件确实存在才写文件名；一时没有专属测试的，写"由 XX 类测试覆盖"或实现位置，**不编造文件名**。
4. **收敛器与种子**。随机化测试必须可复现：固定默认种子，提供环境变量换种（chaos.test.ts 的 `CHAOS_SEED` 模式），失败时打印种子。

约定：编号只增不改（废止的条目保留并标注 superseded-by，历史是本表的全部价值）；一次 PR 动了本表某行的不变量，PR 描述里必须引用该编号。
