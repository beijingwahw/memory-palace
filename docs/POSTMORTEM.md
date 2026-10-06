# 事后复盘 — 根因分类学（Postmortem: Root-Cause Taxonomy）

> **任何一次失守，几乎都属于一个已经见过的类。** 本表把 0.18 → 0.20 五轮工程（深读 → 修复 → 运维 → 猎巫 → 验证升维）的全部实证发现，升维为**根因类 → 机理 → 案例 → 看守防线**的模式语言。
> 与 [INVARIANTS.md](./INVARIANTS.md) 互为对偶：不变量回答"什么性质由谁看守"，本表回答"什么样的错曾经发生、为什么发生、现在哪一层接住它"。改代码前两份都查。

---

## 1. 根因分类表

**总览**（详细条目见后；计数口径见第 4 节）：

| # | 根因类 | 窗口内计数 | 首要看守防线 |
|---|---|---|---|
| R1 | 身份与所有权传播断裂 | 9 | 穷举 ACL 真值表 + 运行时单一落层入口 |
| R2 | 双实现漂移 | 2（另 1 项等价由差分常守） | 差分测试（实现间等价） |
| R3 | 消费者-生产者形状契约 | 7 | 边界运行时校验 + 协议套件 |
| R4 | 缓存键完备性与失效纪律 | 1（另 2 笔前史） | 蜕变关系测试 |
| R5 | 编码边界 | 4 | 性质测试 + 物理错误注入 |
| R6 | 事务与生命周期边界 | 6 | 物理错误注入 + 完整性自检 |
| R7 | fail-open 与权限默认 | 5 | 穷举负身份格 + 混沌畸形输入 |
| R8 | 数值域防御 | 3 | 混沌不变量 + 性质测试 |
| R9 | 注释/文档与实现漂移 | 4 | 静态 audit tripwires |
| R10 | 资源与增长 | 1（另 3 笔前史） | bench 门禁 + 保留机制 |

计数合计 42 条主导归类。清点窗口 = CHANGELOG **0.19.0 与 0.20.0（含 Fixed (post-audit) 小节）** 的 Fixed / Changed / Added 条目，按**主机理**一条归一主类；多机理条目在案例文字中交叉注明。窗口外的历史失守（0.4 / 0.5 / 0.6 / 0.8）以"前史"标注，不进计数。**宁少勿编**：所有案例均可 grep 核对（CHANGELOG 原文 / INVARIANTS 编号 / src 与 test 中现存的执行点）。

**口径补注（0.20.0 收口）**：CHANGELOG 0.20.0 的 **Deferred findings retired** 小节（D-01/02/03/04/05/06/08/10/11/12/13/14 十二项缓解决议落地，逐条档案见 [DECISIONS.md](./DECISIONS.md)）**不计入**本表各类目计数——口径上它们不是 Fixed / Changed / Added 条目，且性质上是"知情决议的缓解修订"（决议档案），不是实证失守的首次入账（本表 §4 第 5 条：不写无过错者，怀疑项升维为实证后才能入表——这十二项在修订前均为已立档的接受/搁置风险，非失守）。机理上与既有类同构（ownerKey 分隔符歧义 ≡ R5 orTag 同病、cohesion 自环虚高与 32 位散列碰撞界 ≡ R8、listEdgesScoped 无界物化 ≡ R10、migrate 恒真门控与"全库计数是最省手默认路径"（D-01）≡ R7、visibility 双栖 ≡ R2、缓存漏命中与 user_version 回绕假新鲜 ≡ R4 失效纪律），不另立案例；其防线面经 INVARIANTS 新增不变量登记看守（本 release 各缓解决议累计 I-DI-16..21、I-RC-12/13、I-NT-12、I-PO-17..21、I-ACL-14..16，矩阵合计 66→83）。

---

### R1 · 身份与所有权传播断裂 — Identity & ownership propagation breaks

**机理**：一行数据离开写入口后，`owner` / `scope` / `tier` 三元组在某一跳被丢弃、透传不降级或被共享桶吸收——数据还在，但对正确的观察者永久不可见，或对错误的观察者可见。

**典型案例**：
- 胶囊导入 tier 透传不降级 → `visibility='user'` 而 owner 为 NULL 的**幽灵行**，对每级可见性级联永不可见（猎巫轮，memory-federation；I-ACL-08）
- 核心块同名歧义无窄层优先 → 用户 A 的自我编辑落在共享 global 块上，改写所有人的 SELF（猎巫轮，core-memory；I-ACL-09）
- tool.call / tool.result 事件不携带调用者 scope → 失败工具的文本蒸馏进**匿名 global 层**，全宫可见（猎巫轮，memory-ingestor；I-ACL-13）
- 其余：实体跳扩二过绕过 tier/owner/时间窗/asOf 门控（修复轮，memory-retriever；I-RC-08）；工作域空宫轨迹读取不锚定 owner → Markov 预测静默哑火（0.20 主修复，intent-predictor；I-RC-10）；分层摘要节点 id 不带 owner → 跨用户覆写（修复轮，stratifier；I-ACL-11）；inferencer 写入不经 `resolveWriteTier`（修复轮，inferencer）；`palaceId` 不持久化 → CRDT 全序身份重启即失（修复轮，crdt-federation；I-DI-11）；摘要输入混入既有 stratified 行 → 摘要套摘要前缀嵌套（猎巫轮，stratifier；I-ACL-11）。

**计数**：9（另 2 个半条目同类但主归他类：CLI 碰撞不安全 session id → R1→R6 注记、CRDT 镜像排除派生行 → 并入幽灵行条目）。

**现在由谁看守**：穷举 ACL 真值表套件（每一 caller 身份 × 每一行 × 每一层，I-ACL-03，▲验证升维轮）；chaos 匿名探针步步断言（I-ACL-02）；运行时**单一落层入口** `resolveWriteTier`（src/utils/scope.ts，I-ACL-08，门禁地图第 10 道"运行时常开守卫"）——幽灵行类在新代码绕过该入口时于第一执行点暴露，而非事后错数据。

---

### R2 · 双实现漂移 — Dual-implementation drift

**机理**：同一条规则存在两份实现（SQL 与 JS 镜像、级联内与级联外、索引梯子与精确扫描），修了一份忘另一份——每份各自通过测试，合起来是错的。

**典型案例**：
- MMR 多样化在宫（同空间池）内守空间隔离、宫外不守 → 跨空间向量被点积出无意义相似度（修复轮，memory-retriever；I-RC-05）
- IVF 半径升级重探已扫桶 → 梯子各级对"哪些桶已扫"的实现互不一致，冗余扫描且语义靠巧合（修复轮，ivf-index；I-RC-06 C3）
- 常守等价：SQL tier 过滤 ≡ JS `visibleAtLevel` 镜像——深读轮即以差分锁死（genesis-retrieval G1，I-ACL-04），窗口内无失守记录；这是本类的目标终态：**等价关系本身成为被测对象**。

**计数**：2 项实证修复 + 1 项由差分常守的等价（无历史失守）。

**现在由谁看守**：差分测试（门禁地图"蜕变与差分"闸）——G1 令镜像漂移以**集合差**的形式在 CI 暴露，而不是以跨租户泄漏的形式在生产暴露；C1/C3 令 IVF 梯子对精确扫描逐格等价、累计键并集恒等全键（索引是纯加速器，召回永不依赖它）。

---

### R3 · 消费者-生产者形状契约 — Consumer-producer shape contracts

**机理**：生产者发出的载荷形状（字段、长度、顺序、缺省）与消费者的假设之间没有边界校验——缺一个字段、错一个默认值、数组当对象解构，错误在离因果最远的一端爆发。

**典型案例**：
- 胶囊 wire 侧条目字段（layer / 重要性区间 / tags 与 entities 数组 / 空内容）不校验 → 脏数据直达 ingestTx（猎巫轮，utils/capsule `parseCapsule` 逐项 error id；I-DI-13；0.19 轮先补了 patterns 与 embedding-space 字段校验，两轮接力）
- CRDT 联邦服务存在而 store 写入不桥接（`memory.after-store` 未接线、Lamport 重启不恢复）→ 生产者在发事件，消费者永远收不到，同步静默失效（修复轮，crdt-federation 接线）
- tools/call `arguments` 为数组时被当参数袋解构 → 整包静默错位（验证升维轮，mcp-server；I-PO-01）

**其余**：轨迹查询返回最旧而非最新匹配（消费者新鲜度契约，修复轮，intent-predictor）；MCP 协议契约——未知工具 -32602 / 未知方法 -32601 / 业务失败 `isError` / notification 永不回带 id 响应（修复轮 + 验证升维轮，genesis-entries；I-PO-02..04）；`scanBySimilarity` 具名参数化使双向奇偶可断言（修复轮，memory-store；I-PO-08）。

**计数**：7。

**现在由谁看守**：边界处的运行时校验（`parseCapsule` 逐项验证、2 MiB 上限、工具输入 clamp 链）；协议套件 genesis-entries 把 JSON-RPC 码位分工钉成断言；运行时 `assertNamedParamParity` 五态词法机（I-PO-08）让 SQL 与 bind 的形状裂隙在第一条语句上抛 `[invariant]`。

---

### R4 · 缓存键完备性与失效纪律 — Cache-key completeness & invalidation discipline

**机理**：缓存键少编入一个影响结果的维度，或失效戳少覆盖一种变更机制——两个"显然不同"的查询共享一条缓存，或一条陈旧排名在写后继续服务。

**典型案例**：
- 查询缓存键漏编 `filters` 与 `fusionOverrides` → 只差过滤条件或学习权重的两个查询互取对方的缓存结果——隐私与正确性双重事故（修复轮，memory-retriever；I-RC-01）
- 前史（不进窗口计数）：rank 缓存以计数碰巧不变而不失效 → 改用 `PRAGMA user_version` 单调图版本戳（0.4）；缓存失效戳只认条目写、不认墓碑/实体/边 → 数据版本统一扩到一切变更机制（0.6，I-DI-09 的由来）。

**计数**：1（窗口内）；另 2 笔前史。

**现在由谁看守**：蜕变关系测试（▲验证升维轮）——G4 六参数变体（文本 × filters × fusionOverrides 归一形态）互不命中，`stableFusionKey` 把 `undefined ≡ {} ≡ {arm: undefined}` 归一到同一分区（漏键与键分裂两个方向的病都测）；chaos 不变量 b 步步复查 dataVersion 单调非降（I-DI-09）；命中须锚桶 + cosine ≥ 0.985 双验（I-RC-02，宁失勿陈）；回绕侧的失效纪律由 epoch 命名空间复合戳看守——`dataVersionStamp()` = `<epoch>:<version>`，回绕必升 epoch、跨 epoch 比较必失配、假新鲜不可表示（I-DI-21，DECISIONS D-08 终态，test/fault-injection.test.ts 场景 3）。

---

### R5 · 编码边界 — Encoding boundaries

**机理**：字节流与字符流在系统边界上换轨——分隔符歧义、UTF-16 与码点口径不一、BOM 混入首 token、巨帧阻塞管道——每个都只在"那个"输入上炸。

**典型案例**：
- CRDT orTag 无结构分隔 → OR-Set 标签解析歧义、合并结果依实现而定（修复轮，crdt-federation；I-DI-11——`@` 分隔 + 值级指纹）
- MCP stdio >64 KB 载荷同步整写 → 巨量管道写饿死 5 s 硬退计时器，Windows 僵尸进程；分块须**代理对安全**（猎巫轮，bin/mcp-palace `setImmediate` 分块让写；I-NT-11）
- CLI ingest 导出文件带 UTF-8 BOM → 首个 token 永远匹配不上（猎巫轮，bin/palace-cli 剥 BOM；I-NT-11）

**其余**：CJK 分词——中文句子共享子词而不共享整"词"，全链关键词融合/共识合成/模式挖掘对中文失明 → bigram 重叠切分（修复轮，tokenizer；I-NT-02）。前史：0.8 分块器代理对切割（性质套件 200 种子化输入 + chaos emoji 载荷自此常守，I-NT-01）。

**计数**：4；另 1 笔前史（0.8 分块器）。

**现在由谁看守**：性质测试（种子化、可复现、失败打印种子）；物理错误注入套件（▲，磁盘/管道故障下字节流卫生）；crdt-federation 对 orTag 的无歧义解析与合并断言。

---

### R6 · 事务与生命周期边界 — Transaction & lifecycle boundaries

**机理**：多步变更缺两阶段纪律、硬删与墓碑口径不一、迁移非原子、崩溃窗口吞半批写入、重放窗口吞更新鲜的本地状态——**快乐路径全绿，只在崩溃与并发下错**。

**典型案例**：
- `insertItem` 对已墓碑内容精确重插复活旧行 → 被遗忘的权利回来了（修复轮，memory-store；I-DI-01，反模式由 audit check 4 全树禁 `INSERT OR REPLACE`，I-DI-02）
- 压缩蒸馏非严格两阶段事务且丢 owner 元数据 → 半批合并行落库（修复轮，memory-compressor；I-DI-03）
- 陈旧胶囊重放覆盖更新鲜的本地知识 → `maxAgeMs` 新鲜度边界拒绝陈旧重放（0.20 Added，utils/capsule；I-DI-13）

**其余**：核心块压缩预览超预算中断真正的驱逐（修复轮，sleep/core-memory）；同文件多进程写竞争直接 `SQLITE_BUSY` → WAL + `busy_timeout = 5000` + 调优 `wal_autocheckpoint`（0.20 Changed，memory-store；I-DI-10）；导入规划探针污染访问计数与轨迹 → `speculative` 语义（猎巫轮，memory-federation；I-PO-10）。

**计数**：6。

**现在由谁看守**：物理错误注入（▲——磁盘/管道/SQLite 故障下的存活与降级）；`integrityCheck()` 结构自检 + `repairIntegrity()` 保守自愈 + `backupTo()` 在线快照（I-DI-06/07）；space-migrator 的 flashback 逐项不变断言（I-DI-04/05）；chaos 风暴后 stats 存活复查。

---

### R7 · fail-open 与权限默认 — Fail-open & permission defaults

**机理**：异常路径、无身份路径、不可逆分支上的默认行为错了方向——不是崩溃，而是**静默放行**；错误看起来就像正常工作。

**典型案例**：
- `memory_forget` purge 模式无视 `dryRun` → 唯一不可逆的分支恰好是唯一不看预演标志的分支（猎巫轮，src/index.ts `wouldPurge`；I-PO-09）
- `memory_era` 不拒绝匿名调用者 → 共享 null-owner 时间线摘要桶对任何人可读（猎巫轮，src/index.ts / stratifier；I-ACL-07）
- 熔断 half-open 状态无真·单探针闩 → 恢复试探期并发放行，雷群再次打向已死后端（修复轮，embedding-gateway；I-NT-04）

**其余**：联邦成员超时与熔断转换不可观测——静默失败（修复轮，federated-retriever / embedding-gateway）；胶囊条目缺嵌入被静默丢弃 → 经嵌入网关回填并**报降级警告**，不静默吞（猎巫轮，memory-federation；I-PO-10）。

**计数**：5。

**现在由谁看守**：穷举真值表的负身份格（匿名 × 每一行 × 每一层，I-ACL-03）；chaos 畸形输入族（I-NT-07）；0.20 猎巫回归逐条钉死（I-PO-09 / I-PO-10 / I-ACL-07）；genesis-utils 对熔断器状态机 latch 语义的直测。

---

### R8 · 数值域防御 — Numeric-domain defenses

**机理**：NaN / Infinity 穿透 clamp 链直达 SQL、融合权重越出概率域、跨空间维度被点积、`Math.max(...spread)` 炸调用栈——数值错误不抛异常，只产出**貌似合理的结果**。

**典型案例**：
- NaN / Infinity 输入（topK / minScore / budget / era 窗口 / fed-search topK / CLI `--topk`）穿透钳制链 → SQL 数据类型错配（猎巫轮，多入口统一回退默认；I-NT-07）
- CRDT Lamport 天花板 `Math.max(...spread)` → 12.5 万 op 同步爆调用栈（猎巫轮，crdt-federation 改 reducer 归约；I-DI-12）
- PageRank 边集含已剪枝实体的悬垂边 → rank 质量失守（修复轮，memory-graph；I-RC-09 质量守恒 Σrank ≈ 1）

**前史**：0.8 工具输入硬钳（topK/minScore clamp、asOf 体检、layers 白名单、胶囊 2 MiB 上限）。**常守双保险**：bandit ±20% 硬轨内核写钳 + 消费端 `clampedArmOverride` 再钳（I-NT-05），`finalScore` 恒在 [0,1]（I-RC-03，chaos 不变量 e）。

**计数**：3；另 1 笔前史（0.8 钳制链）。

**现在由谁看守**：chaos 检索形状与分数域不变量（e）；性质测试（PageRank 100 随机图质量守恒、int8 量化误差对精确扫描有界、I-NT-03）；ARM_RAILS 双端钳。

---

### R9 · 注释/文档与实现漂移 — Comment/docs vs implementation drift

**机理**：文档、schema、README 或注释声明了一个行为，实现是另一个——不是代码错了，是**声明与代码之间的差**错了；grep 得出来的那部分可以变成门禁。

**典型案例**：
- 5 臂融合 bandit 声称 5 臂，实际只有 vector/keyword 混合臂在动——`graphBoost` / `prfAlpha` / `prfBeta` 未接线（修复轮，feedback-learner 接入真实管线；I-NT-05 行为测试自此锁臂）
- `memory_graph` expand 的 hops 代码默认 1、schema 声明 3 → 契约文档在说谎（猎巫轮，对齐 schema 值；I-NT-07 附带条目）
- audit / bench 脚本以相对路径解析仓库 → 含空格/非 ASCII 的 checkout 路径上每个检查报幻影 ENOENT（猎巫轮，scripts/ 改 `fileURLToPath`）
- 测试树允许 `xit(` / `xdescribe(` 溜进 main → 静默绿灯（猎巫轮，audit check 6 禁令；I-PO-06）

**计数**：4。

**现在由谁看守**：静态 audit tripwires——版本三同步、15 工具数三同步（I-PO-05）、console 与 skip 禁令（I-PO-06）这类**可 grep 的漂移**由 CI 必经的发布卫生门禁接住；接不进 grep 的（如 bandit 接线）由行为测试接住。本类是"门禁性价比之王"：每条 tripwire 一次编写、零运行时代价、永久看守。

---

### R10 · 资源与增长 — Resources & growth

**机理**：没有修剪的表、没有压缩的 ops、没有上限的缓存、没有预算的重复扫描——正确性不变，只是**慢慢**变坏，直到某天基线翻倍才发现。

**典型案例**：
- WAL 自动检查点不调优 → 多进程拓扑下检查点风暴（0.20 Changed，memory-store `wal_autocheckpoint`；与 R6 的 WAL 条目同源异病）
- 交叉参考：IVF 半径升级重探已扫桶（R2 案例）同时是本类的浪费面——修一次，两个类各记一半教训。
- 前史（不进窗口计数，但是本类的立类之基）：0.5 保留机制三件套——读时 TTL 执法、90 天 episodic 修剪、7 天墓碑清除；0.20 把"性能面"从口头承诺升维为 bench 门禁（计时指标超基线 2× 即红，I-PO-12）。

**计数**：1（窗口内）；另 3 笔前史（0.5 保留三件套）。

**现在由谁看守**：bench 门禁（4 基准 × 中位数对 `scripts/bench-baseline.json`，`--update` 只许整尺度重录——防基线偷偷缩水）；保留生命周期测试；chaos 风暴全程 stats 有界、整数、非 NaN（I-DI-08 侧面）。

---

## 2. 防线路图 — 每类由哪层接住，代价是什么

| 根因类 | 静态门禁能接住吗 | 主防线层 | 代价 |
|---|---|---|---|
| R1 身份传播 | **不能**。scope 在运行时穿过十层调用，类型系统证明不了它到达时还在 | 穷举真值表 + 混沌探针 + `resolveWriteTier` 单一入口（运行时常开） | 真值表 O(身份×行×层) 用例维护；单一入口是对所有写路径的架构约束 |
| R2 双实现漂移 | **不能**。没有任何静态工具能证明两份实现等价 | 差分测试（G1、C1/C3） | 每对镜像要养一份等价断言；实现改动时差分先红——这是特性不是负担 |
| R3 形状契约 | 一半。可 grep 的契约（工具数、参数表）能进 audit；**wire 上的载荷不能** | 边界运行时校验 + 协议套件 + `assertNamedParamParity` | 边界校验代码本身要测（校验器的漏洞就是新的洞）；运行时少量开销 |
| R4 缓存纪律 | **不能**。键完备性是语义性质 | 蜕变关系测试（六变体互不命中） | 每加一个影响结果的参数都要加一个变体，漏加即盲区——评审时查键清单 |
| R5 编码边界 | **不能**。Unicode/BOM/管道时序超出一切 lint 想象力 | 性质测试（种子化）+ 物理错误注入 | 种子必须可复现（`CHAOS_SEED` 模式）；故障注入套件依赖真实的失败语义 |
| R6 事务边界 | **不能**。快乐路径测试全绿是本类的定义 | 物理错误注入 + `integrityCheck` 自检 + flashback 差分 | 注入器要维护故障点清单；自检-自愈对（I-DI-06）要求"不可经公共 API 产生的脏态用第二连接播种"这类非常规测试技巧 |
| R7 fail-open | **不能**。放行路径读起来就像正常代码——这正是它危险的原因 | 穷举负身份格 + 混沌畸形输入 | 负格（匿名 × 一切）最容易被新功能遗忘；靠 audit"新工具必须进真值表"的纪律，不靠技术 |
| R8 数值域 | **不能**。NaN 传播在 review 里几乎是隐形的 | 混沌不变量（分数域）+ 性质测试（守恒/有界） | 每个新数值入口都要接进畸形输入族与 clamp 链——入口清单本身要人维护 |
| R9 文档漂移 | **能，且最便宜**——凡是能 grep 成一条规则的漂移都该进 audit | 静态 tripwires（audit check 1–10（全部已落地）） | 误报要人工豁免（`// audit-ok`），豁免清单要复核；接不进 grep 的漂移仍需行为测试兜底 |
| R10 资源增长 | **不能**（bench 基线是计时测量，不是静态物） | bench 门禁 + 保留机制 | 基线重录纪律（只许整尺度、须解释）全靠自觉条款；机器时间成本真实存在 |

**给未来维护者的诚实指南**：

1. **十类里只有 R9 的一半能被静态扫出**。其余九类半的病，lint / audit / 类型系统在原理上看不见——它们的本质是运行时语义（scope 穿透、缓存键语义、崩溃窗口、数值传播），不是源码形状。指望加一条 lint 规则消灭幽灵行，是分类学上的误诊。
2. **差分与穷举是为 R1/R2 而生的兵器**：跨租户泄漏（R1）与镜像漂移（R2）在生产上不可复现、在单测上各分支全绿，只有"两实现互相校对"（G1/C1）与"全格真值表"（exhaustive-acl）能确定性地暴露它们。
3. **混沌与注入是为 R5/R6/R7/R8 而生**：它们的共同点是只在极端输入与故障时序下发病。多种子 + 收缩器（▲）把"偶尔炸"变成"确定炸且给出最小复现"。
4. **每层防线都有月供**：真值表要随工具扩张、差分要随镜像改动、基线要随尺度重录、豁免要人工复核。**防线不是资产是一次性买断 + 永久保养**——新增不变量时按 INVARIANTS §4 的四步走，别只写测试不登记。
5. **修 bug 时先归类**：你的修复如果落在 R1/R7（身份/权限），必须同时落穷举格或运行时入口，否则下次失守只是换一条调用路径；落在 R2/R4（等价/缓存），必须落差分或蜕变，单侧单测无效；落在 R9，优先考虑变成下一条 audit tripwire——最便宜的一层。

---

## 3. 数字快照 — 五轮统计

| 轮次 | 版本落点 | 发现 | 修复 | 防线产出 |
|---|---|---|---|---|
| ① 深读轮 | 0.18 树 | 逐行审读 0.18 全树，80 项可疑点立项分诊（轮次自记账口径） | —— | 可疑点清单（后续两轮的输入）；genesis-* 差分/收口测试族的立项 |
| ② 修复轮 | **0.19.0** | 深读确认项收敛为 CHANGELOG 0.19 Fixed 10 条 + Changed 10 条（含 CJK 分词、接线的 5 臂 bandit） | 0.19 全部 Fixed/Changed | 差分门 G1–G4、性质套件扩展、`resolveWriteTier` 收口 |
| ③ 运维轮 | **0.20.0** | 多进程/崩溃窗口类弱点 | WAL + busy_timeout、verify 链、CI 双 Node 矩阵 | `integrityCheck` / `repairIntegrity` / `backupTo`、chaos 套件、bench 门禁、audit 进 verify |
| ④ 猎巫轮 | 0.20 post-audit | 审后再猎巫：**~35 项实证 bug**（轮次自记账口径；CHANGELOG 以 10 个要点打包，可清点子修复 22 项——为下界） | post-audit 小节全部（purge dryRun、幽灵行灭族、core 块窄层、Lamport reducer、NaN 族、stdio 分块…） | I-ACL-07/08/13、I-DI-12、I-NT-07/11、I-PO-09/10 十条 0.20 溯源不变量；audit tripwires 7–10 落地中 |
| ⑤ 验证升维轮 | 0.20 收口 | ——（不找新 bug，把找 bug 的能力升维） | —— | 穷举 ACL 真值表、物理错误注入、蜕变关系、chaos 多种子 + 收缩器；INVARIANTS.md 60 条登记 |

**版本与基线刻度**（0.18 → 0.20）：

| 刻度 | 0.18 基线 | 0.20 收口 | 备注 |
|---|---|---|---|
| 版本 | 0.18.0 | **0.20.0** | package.json / plugin.json / src/types VERSION 三处一致（audit check 1） |
| 测试数 | 172 | **235** | 项目口径；test/ 树中 `test(` 调用点 2026-10-05 实测 258 处（并行加固仍在落，只增不减） |
| 发布闸 | 1 道链（lint + test） | **10 道闸** | INVARIANTS §3 门禁地图：类型级 / 构建 / 行为级 / 发布卫生 / 随机风暴 / 蜕变差分 / 物理故障 / 性能回归 / 协议冒烟 / 运行时常开 |
| audit 检查 | —— | 树中 11 项（tripwires 7–11 已落地） | scripts/audit.mjs，verify / CI / prepublishOnly 必经 |
| 命名不变量 | 0（未编目） | 树中 **83 条**（审后加固与缓解决议持续落地：I-ACL-14..16、I-DI-14..21、I-RC-12/13、I-NT-12、I-PO-13..21） | INVARIANTS.md 总览矩阵；编号只增不改 |
| MCP 工具 | —— | 15 个 | plugin.json === README 工具表 === buildToolDefinitions（audit check 2） |

> 命名不变量的现值以 INVARIANTS.md 合计行为准（0.21/0.22 已增至 90 条）；本表为 0.20 时点快照。

> 表内 80 / 35 为各轮的**自记账口径**（轮次工作记录），CHANGELOG 可 grep 的条目数是审计下界——两套数字并存是刻意的：记账看投入，CHANGELOG 看证据。

---

## 4. 编写规约

本表与 INVARIANTS.md 同源同纪（互为对偶），扩展时遵守：

1. **案例必须可核**。每条案例注明：现象 → 后果、发现轮次、涉及模块，且至少满足其一：CHANGELOG 0.19.0 / 0.20.0（含 post-audit 小节）原文可 grep；INVARIANTS.md 有对应编号；src / test / scripts 中现存对应执行点。**禁止编造案例与文件名**——一时找不到专属测试的写"由 XX 类测试覆盖"或实现位置。
2. **计数宁少勿编**。计数口径固定为：CHANGELOG 0.19.0 与 0.20.0（含 post-audit）的 Fixed / Changed / Added 条目，按主机理一条归一主类；给区间亦可，但必须注明清点口径（本文口径下合计 42 条主导归类）。窗口外失守只作"前史"标注，不进计数。轮次级数字（80 / 35）注明"自记账口径"。
3. **每修一个 bug，先归类再落防线**。归类决定防线层级（见 §2 指南第 5 条）；防线落定后在对应类的"现在由谁看守"更新一行，并按 INVARIANTS §4 四步登记不变量编号。
4. **编号只增不改**。根因类 R1–R10 编号固定；需要新类时续编号并在总览表加行，不得把历史案例挪类重写——分类史本身是本表的价值。某类被证明看守过剩时可标注"饱和"，但案例保留。
5. **不写无过错者**。本表不记录"发现了但没问题"的怀疑项（那是深读轮的分诊清单）；只记录实证失守与实证缺口。怀疑项升维为实证后才能入表。
