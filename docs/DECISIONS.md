# 知情决议记录 — Accepted-Risk Decision Record (ADR)

> **审计不是只找 bug：每一轮审计都会产出一批"查过了、想清楚了、决定不改"的事项。** 本表把多轮审计（深读 → 修复 → 运维 → 猎巫 → 验证升维）中判定为**设计内 / 接受 / 缓解 / 搁置**的全部缓决事项逐条立档：每条写清我们接受了什么、为什么、残余风险是什么、现在由谁看着。

**三份治理文档的分工**：

- [INVARIANTS.md](./INVARIANTS.md) — **守什么**：每条被测试/门禁/运行时断言看守的性质，映射到执行点。
- [POSTMORTEM.md](./POSTMORTEM.md) — **为什么**：什么类型的错曾经发生、机理是什么、现在哪一层接住。
- **DECISIONS.md（本表）— 我们知情地接受了什么**：不是 bug、不是失守，而是查证后被显式接受的权衡、边界与理论极限。三表互为补集：INVARIANTS 之外的残差要么在这里，要么是未知的。

**决议状态图例**

- **接受**：设计内行为或显式取舍——知情接受、不做变更，残余风险记账在册。
- **已缓解**：已落地缓解措施，残余风险收窄但不归零。
- **已消除**：结构性关闭，无残余。
- **搁置**：暂缓判定——正确解法不在当前作用域，等待触发条件。
- **重分类：验证属性（非风险）**：查证后判定事项**不是风险而是设计语义本身**，且实现正确性已被验证（穷举 / 差分 / 钉死测试）——据此**退出风险登记册**。登记册纯度要求本表只收真实风险与取舍：一条"设计即如此、且已被证明如此"的条目留在册内，会让读者把设计语义误读为风险敞口、稀释登记册的信号。条目编号与全部历史段落保留（规约 3：分类史本身是本表的价值），语义本体移交 [INVARIANTS.md](./INVARIANTS.md) 作为被看守不变量；原「接受」段降为历史。

---

## 1. 决议总览

| 编号 | 事项 | 决议 | 一句话理由 |
|---|---|---|---|
| D-01 | `facade.stats()` 面向管理面暴露全库计数 | 已缓解（0.20.0） | 真实缺陷不是"宿主能读全库计数"（嵌入式库本体属性），而是全库计数同时是最省手的默认路径；scoped 已升为一等公民（差分等价）+ 工具层审计绊线禁裸 stats() + byTier 租户分布遥测 |
| D-02 | 胶囊内容寻址用 32 位散列（fnv1a-32） | 已消除（0.20.0） | 128 位 SHA-256 截断 CAS（抗蓄意碰撞）+ 三代共存 + 碰撞取证绊线；legacy 胶囊永久兼容 |
| D-03 | `memory_why` / 胶囊导出的 learn 信号 reward 恒 1 | 已缓解（0.20.0） | 三通道全部携带信息：why 按证据排位衰减、export(query) 按分数×多样性复合、forget 保持 reward 0 负通道 |
| D-04 | `memory_migrate` 作用域门控近似恒真 | 已消除（0.20.0） | admin 白名单真门：配置 `scope.adminUserIds` 后 live 需成员身份 ∧ `confirm:true` 双门（匿名 / 非成员 fail-closed）；未配置 = 单用户信任模型仅 confirm；dryRun 恒自由 |
| D-05 | `MemoryItem.visibility` 与 `metadata.visibility` 双栖 | 已缓解（0.20.0，写侧单一事实源） | `metadata.visibility` 不再持久化（legacy 行读侧兼容），列是唯一事实源 |
| D-06 | 联邦 / CRDT 无网络传输层 | 已缓解（0.20.0） | 内置零依赖 HTTP 传输（node:http + HMAC 对等认证），库级 API 自定义通道仍是合法拓扑 |
| D-07 | 零 LLM 启发式摘要 / 查询理解 | 已缓解（0.20.0，部分） | 词法折叠抬检索召回；抽取式内核抬蒸馏/分层；语义级改写仍需 LLM（summarize 钩子保留） |
| D-08 | `user_version` 32 位回绕 | 已消除（0.20.0） | epoch 命名空间复合戳 `<epoch>:<version>`：回绕必升 epoch，跨 epoch 比较必失配，假新鲜数学不可达 |
| D-09 | 共享 session 的跨用户可见性 | 重分类：验证属性（0.20.0） | session 即共享可见组是设计核心语义而非被接受的风险——exhaustive-acl 2880 格三方穷举证明实现正确，语义升格 I-ACL-17 并退出风险登记册（纯度）；弱会话号运行时告警把 bearer-credential 威胁模型显性化 |
| D-10 | 查询缓存近重复 Hamming>1 漏命中 | 已缓解（0.20.0） | lookup 全量兜底扫描（容量有界），命中充分性不再依赖桶几何 |
| D-11 | chaos 风暴中数字模板内容被 0.92 写时去重 | 已缓解（0.20.0） | 真实缺陷不是"稀疏向量放大相似度"（嵌入空间物理事实），而是后果对调用者不可见、阈值不可调；写时结局四态透明（advisory 把提示词事项升格为运行时反馈回路）+ 阈值可配 + 数值漂移必走替代链被钉死为不变量（I-RC-14） |
| D-12 | ownerKey 管道分隔复合键碰撞 | 已缓解（0.20.0） | 分区键改 `\u0000` 拼接（ids 中不可出现的码位），模式 id 保持稳定 `\|` 格式 |
| D-13 | communities cohesion 自环虚高 | 已缓解（0.20.0） | 统计侧剔除自环，聚类结果不变 |
| D-14 | `listEdgesScoped` 无界物化 | 已缓解（0.20.0） | 展示路径默认 limit 10000；rank 路径无界零漂移 |
| D-15 | 完全匿名写入的 fail-open 落 global（隐式默认） | 已缓解（0.20.0） | 显式三态 anonymousPolicy：global 默认零配置兼容 / quarantine 匿名桶对已识别用户不可见 / reject fail-closed 供身份保证型宿主 |

---

## 2. 逐条决议（ADR）

### D-01 · `facade.stats()` 面向管理面暴露全库计数 — 已缓解（0.20.0）

- **事项**：`memory-palace` 服务门面上的 `stats()`（src/index.ts 门面定义，透传 `store.stats()`）返回**全库**计数——逐层条目数、事件数、实体/边/模式数、库体积、空间分布、墓碑数——不做任何 tier/owner 过滤。
- **决议**：已缓解（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：修订先重新诊断病情：原状态的真实缺陷**不是**"宿主能读全库计数"——服务门面的持有者本来就持有数据库文件与进程，这是嵌入式库的**本体属性**，无法也无需消除——而是**全库计数同时是最省手的默认路径**：scoped 口径没有一等公民 API，任何想看"我这个作用域"计数的调用方都被推向全库数字。升维把这条默认路径拆掉，三面落地：**scoped 升为一等公民**——store 新增 `statsScoped(level)`（五个作用域计数），门面 `facade.stats(scope?)` 增加 scoped 重载，且与 `visibleAtLevel` 的可见性窗口**差分证明等价**（等价关系本身成为被测对象，test/stats-scoped.test.ts，I-PO-21）——scoped 读数与全局口径同可信，不再是二等观测；**工具层被审计绊线强制 scoped**——audit check 11 禁止 src/index.ts 工具层裸调 `stats()`，`memory_inspect` 的全部计数改走调用者作用域（statsScoped / `facade.stats(scope)`），可观测性租户隔离落地：inspect 不再可能泄漏其他租户的计数元数据（I-ACL-16）；**管理面反而增强**——unscoped `stats().byTier` 新增租户分布遥测（live 条目按 visibility 列的五桶分布：session / workspace / user / global / legacyNull——legacyNull 单列让多租户运维看见前 ACL 时代的迁移债），多租户容量规划第一次有比"单一全库总数"更有信息量的管理视图。三层合起来：宿主要全局有全局（byTier）、租户要局部有局部（statsScoped / facade.stats(scope)）、工具面只剩局部（audit 绊线）——全库口径从"人人默认走的省手路径"降级为"显式的管理面选择"。
- **残余风险**：unscoped `stats()` 对宿主进程**永远可用**——嵌入式库的本体属性（持有进程者本可直读 SQLite 文件），文档化为管理面 API 契约而非待修缺陷；多租户宿主仍负有"不把服务门面下放给不可信方"的接线责任（与 D-15 anonymousPolicy 同族的边界：默认优化单用户体验，多租户姿态需显式接线）。工具层隔离的静态面是 audit check 11 对已知工具面文件的绊线——未来新增的观测面若绕开 src/index.ts 接线，需自觉走 scoped（行为面由 I-ACL-16 的测试看守兜底）。
- **看守点**：test/stats-scoped.test.ts（statsScoped 与 `visibleAtLevel` 过滤的差分等价——I-PO-21；工具层计数随调用者作用域、inspect 不报告跨租户计数——I-ACL-16）+ scripts/audit.mjs check 11（src/index.ts 工具层禁裸 `stats()`）；工具面既有的作用域纪律仍由穷举 ACL 真值表看守（test/exhaustive-acl.test.ts，I-ACL-01/03）。
- **原决议（历史，0.20.0 前）**：接受。理由：服务门面（`app.service('memory-palace')`）是**宿主管理面**，拿到它的人本来就持有数据库文件与进程；真正的攻击面是模型工具面，而 15 个工具全部走 scopeLevels 门控。把管理面观测做成全库口径是运维需要（容量规划、空间碎片诊断——`memory_migrate` 的 dryRun 就靠 `stats().spaces`）。残余风险：多租户宿主若把服务门面直接下放给不可信插件，计数元数据（语料规模、层分布）会泄露给同进程第三方。这是宿主的接线责任，不是本库的 ACL 承诺范围。看守点：工具面的作用域纪律由穷举 ACL 真值表看守（I-ACL-01/03）；`memory_inspect` 的健康样本显式走 scoped 采样（src/index.ts 实现内 `listItemsByLayerScoped`，注释"the health metrics must sample the same visibility window"）。——0.20.0 修订没有推翻"宿主管理面有权看全库"的边界论证（该权限作为 byTier 管理遥测保留并被增强），推翻的是"因此 scoped 可以不是一等公民"的推论：差分等价让 scoped 与全局口径同可信、audit 绊线把工具面钉死在 scoped、byTier 让管理面看得比从前更细——三者成立后，原"接受"余下的只是已文档化的本体属性与接线责任，本条转"已缓解"。

### D-02 · 胶囊内容寻址用 32 位散列 — 已消除（0.20.0）

- **事项**：胶囊条目的确定性 id 是 `cap:<fnv1a-32 of normalized content>`（src/utils/capsule.ts `capsuleItemId`，8 个十六进制位）。32 位空间下生日碰撞界：约 **7.7 万条**不同内容即达 50% 碰撞概率（√(2·2³²·ln2) ≈ 77,536）。
- **决议**：已消除（0.20.0 终态；两段历史决议——"32 位接受"与"64 位缓解"——见本条末段）。
- **理由（0.20.0 终态）**：内容寻址升维为**密码学级 CAS**——SHA-256 截断 128 位（`cap:` + 32 hex，`capsuleItemId`）。生日碰撞界升至 2^64 ≈ 1.8×10¹⁹ 条不同内容（50% 概率），对任何宫殿联盟量级永久关闭；更关键的是**对蓄意构造的碰撞具有 SHA-256 级抗性**——FNV 族（无论 32 位还是双轮 64 位）不具备该性质，而胶囊恰走**不可信跨 agent 信道**：敌意导出方可以离线研磨 FNV 碰撞，却研磨不动 SHA-256。128 位截断即内容寻址的工业标准宽度纪律（git / Nix 同款），经 node:crypto 零新依赖。**三代格式共存**：解析侧按 id 长度分派（8-hex→v1 / 16-hex→v2 / 32-hex→v3，各按本代算法重算匹配；其他长度/非 hex 拒收并在错误消息中列全三代期望格式）——**存量胶囊永久可导入**，首次重导出时 id 自然升级。**同胶囊碰撞取证绊线**：逐项校验通过后，若存在两条 normalizedContent 不同而 id 相同的项 → fail-loud 抛 `[capsule] content-address collision detected: <id>`（数学上仅当哈希被破才可达——对 v3 即破解截断 SHA-256；对 v1 是可构造的 32 位生日碰撞，而那正是"宁可响亮取证也不静默错误去重"的情形），判定抽为可直测的导出函数 `assertNoAddressCollisions`。**legacy 观测闭环**：parseCapsule 在胶囊对象上置 `legacyAddressCount`（8/16-hex 项计数；排除在 HMAC 规范形之外，签名/验签不受影响）。消费建议：ImportReport 可透传该计数作为 re-export 提示（留给后续，不在本变更内）。
- **残余风险**：无。legacy 胶囊功能上永久兼容（v1/v2 解析分支不移除——移除即存量胶囊过期）；legacyAddressCount 仅计数观测、提示持有者重导出升级，不构成功能面风险。
- **看守点**：test/capsule-cas.test.ts（I-DI-20 执行点：v3 确定性与独立 SHA-256 重导一致性、三代同胶囊共存 + legacyAddressCount===2、绊线直驱 + **真实 v1 生日碰撞经 parseCapsule 全链路触发**、v3/v2/v1 代际分离、1 MiB 寻址性能锚点）+ test/dimensions.test.ts（新产出 32-hex 格式、v1/v2 手工构造解析兼容、`cap:deadbeef` 错误消息含三代格式说明）；胶囊完整性防线（HMAC、b64、maxAgeMs、逐项字段校验）仍由 I-DI-13 看守，legacy 双格式的兼容底线仍由 I-DI-16 看守。
- **原决议一（历史，0.20.0 前）**：接受。理由：导入侧内容级查重兜底使碰撞不致脏数据，且"换 64 位散列会让所有已流通胶囊 id 失效，收益不抵"；残余风险：互导量逼近 7.7 万条时去重误判率上升，届时升 `cap2:<sha-256 前 16 hex>` 双轨。
- **原决议二（历史，0.20.0 首缓解）**：已缓解。理由：内容寻址升级为 64 位（`cap:` + 16 hex，双轮 FNV-1a），并以 legacy 8-hex 双格式兼容落地——导入侧同时接受旧 32 位 id 与新 64 位 id，存量胶囊不过期、仍可导入；新导出一律用 64 位 id。生日碰撞界从 7.7 万条升到 √(2·2⁶⁴·ln2) ≈ 5.1×10⁹ 条，对"单次交接的蒸馏知识包"这一量级永久关闭碰撞话题；原决议担心的"换宽度会让已流通胶囊 id 失效"由双格式兼容化解。残余风险：legacy 胶囊自身仍是 32 位寻址（碰撞界对它们不变），且 FNV 族对蓄意构造碰撞无抗性——0.20.0 终态正是消除这两点：128 位截断 SHA-256 + 三代共存 + 碰撞绊线 + legacyAddressCount 观测，风险从"已缓解"转"已消除"。

### D-03 · `memory_why` / 胶囊导出的 learn 信号 reward 恒 1 — 已缓解（0.20.0）

- **事项**：`memory_why` 的溯源查询与 `memory_capsule_export` 会向 feedback-learner 发"正向参与"信号（src/index.ts 两处 `facade.learner.learn(...)`）。0.20.0 前这两处的形状是 `engagedItemIds === 全部条目、totalHits === 全部条目`，代入 `reward = engaged / totalHits`（src/services/feedback-learner.ts，钳制 [0,1]）后**恒等于 1**——两条正向通道对 bandit 是零信息量的常数流：无论检索排序好坏，账面永远满分，bandit 只会单向漂向轨顶，双向学习名存实亡。
- **决议**：已缓解（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：三条反馈通道全部改为携带信息，各按自己的事件语义取形。**why 为自一致性秩信号**：以实体名为探针查询做一次 speculative 检索（零副作用——不污染访问计数与轨迹，与 I-PO-10 导入探针同一纪律），按证据条目在探针结果中的排位取 DCG 风味折扣 `reward = 1/log₂(rank+2)`——证据排得越靠前 reward 越接近 1，排不进前排则单调衰减，"宫殿把它最该给的证据排在了前面"第一次成为可学习的性质。**export(query) 为分数×多样性复合**：query 模式导出以 `0.6·avgScore + 0.4·diversity` 复合计酬（导出集对查询的平均得分 × 集内多样性——既奖励切题也奖励不冗余）；entity / all 模式保持恒 1——整实体 / 整库交接是 **bulk 策展**而非排序评判，不存在"排名好坏"可供度量，恒 1 在该语义下是对的。**forget 保持 reward 0 负通道**不变——同一批条目恢复真双向账本（正向：被查证且排序良好 / 被导出且切题多样；负向：被遗忘），bandit 重新既会上调也会下调。
- **残余风险**：探针质量依赖离线嵌入的判别力——offline-bm25 稀疏空间下探针排位噪声较大，deepseek 部署下秩信号更可信；且信号仍是**启发式派生**（自一致性秩 / 复合分数），不是用户显式评分——真实满意度只能经行为侧写间接到达。轨道护栏（ARM_RAILS ±20%，I-NT-05）与 reward 事件衰减不变，错误信号的作用半径仍被硬界住。
- **看守点**：双向信息量断言（why 排位衰减、export 分数×多样性复合、forget 恒 0）由 test/feedback-signals.test.ts 看守（I-RC-13：派生 reward 恒定即违规）；显式 reward 通道合法域（有限数经 clamp01、NaN 零写入）由 test/feedback-bandit.test.ts 看守（I-PO-18）；轨道双端钳仍由 I-NT-05 看守；零命中零学习仍由 I-NT-06 看守（test/genesis-services.test.ts #4）；finalScore 恒在 [0,1] 仍由 I-RC-03（chaos 不变量 e）常守。
- **原决议（历史，0.20.0 前）**：接受。理由（结构性论证）：这两个事件在语义上就是二值的——"agent 主动来查这条实体的证据" / "这条知识值得交给另一个 agent"——发生即正向，无中间档位。**恒 1 不是测量缺陷，而是信号定义**：export / why 与展示集的 100% 交互是结构性事实——导出即全选（胶囊导出把选定 scope 边界内的全部条目交给下一个 agent），why 即全证据（溯源查询按定义返回该实体的全部证据链），`engagedItemIds === totalHits` 是事件构造使然，任何"分级"都只能在全集里人为挑子集。负信号通道已由 forget 承担——同一批条目被 `memory_forget` 处置时以 reward 0 入账，bandit 看到的是同一实体上的双向账本，无需 why/export 侧再伪造分级行。bandit 的作用轨道有硬界（ARM_RAILS ±20% 默认值，内核与消费端双端钳），恒 1 信号最多把权重推到轨内上限，不可能越轨；且 reward 历史按事件衰减（"a March streak cannot dominate"）。残余风险：频繁 `memory_why` 的 scope 会把对应臂推向 +20% 轨顶，即便检索质量没有实质变化，可由 `memory_bandit` 观测、按臂 reset。——**该论证的结论——"恒 1 即零信息量"——正是 0.20.0 升级的动机：同一句话，修订前读作"所以不用改"，之后读作"所以必须改"，论证从辩护变成了诊断。** 论证在"事件二值"的前提下自洽，但前提本身可改：why 的证据集在探针结果中是有序的（排位即分级），export 的 query 模式是挑选性的（分数与多样性即分级）——分级不必"人为挑子集"，事件自带的结构就够。

### D-04 · `memory_migrate` 作用域门控近似恒真 — 已消除（0.20.0）

- **事项**：`memory_migrate` 在执行物理重嵌入前有一个调用者门控：`widest.tiers.includes('global')` 否则拒绝（src/index.ts `memory_migrate` run 内）。但 `scopeLevels` 的级联终点**必然包含 global**（src/utils/scope.ts：宽化序列 `session→…→global` 终于 global；匿名回退层的 tiers 也是 `['global']`）——该门控对任何调用者都无法拒绝，**近似恒真**。
- **决议**：已消除（0.20.0 终态；两段历史决议——"搁置"与"confirm 门缓解"——见本条末段）。
- **理由（0.20.0 终态）**：全库副作用的授权从"作用域推导"（按定义必真、形同虚设）升维为 **admin 白名单真门**：配置键 `scope.adminUserIds?: string[]`——**配置即生效**，live 迁移需调用者 **userId ∈ adminUserIds 成员身份 ∧ 显式 `confirm: true` 双门**，缺一即拒；匿名调用者（无 userId，成员身份无从谈起）与非成员在已配置下一律 **fail-closed 拒绝**——门第一次真正可以拒绝人。未配置时保持**单用户信任模型**：confirm 单门，与首缓解行为逐字节一致（零配置兼容是被断言的性质）。`dryRun`（碎片化诊断预览）不受白名单约束，恒自由调用。MCP 独立服务器经环境变量 `MEMORY_PALACE_ADMIN_IDS` 注入同一白名单；安装时对**空数组 / 空串元素 fail-loud**——一个配置了却谁都拦不住的白名单是最危险的假门，宁响亮拒绝安装，不静默回退单用户模型。
- **残余风险**：未配置时的单用户信任模型——模型仍可显式带上 `confirm: true` 触发重嵌入，但那已是一个可归因的显式决策（预算 ≤ 512/次、逐批事务、幂等、embedder 降级拒跑的既有护栏不变），而非近似恒真门控下的静默通过。**多租户宿主应显式配置 `scope.adminUserIds`**——与 D-15 anonymousPolicy 同族的接线建议：默认优化的是单用户零配置体验，不是多租户安全；两键同置（`adminUserIds` + `anonymousPolicy: quarantine|reject`）才是完整的多租户姿态。
- **看守点**：test/migrate-admin.test.ts + I-PO-20（双门语义：配置后成员 ∧ confirm、匿名 / 非成员 fail-closed、未配置 confirm 单门、空数组 / 空串元素安装期 fail-loud）；confirm 门本身仍由 I-PO-17 看守；迁移副作用安全性仍由 I-DI-05（幂等、分批事务、降级拒跑、审计留痕）与 I-DI-04（flashback 逐项不变）看守。
- **原决议一（历史，0.20.0 前）**：搁置。理由：问题不在门控写法，而在模型工具面上不存在能正确授权"全库副作用"的身份，正确解法是管理面约定的接口契约变更，不宜顺手改一半；残余风险：模型可在任何会话触发重嵌入（token/时间浪费，非数据损坏）。
- **原决议二（历史，0.20.0 首缓解）**：已缓解。理由：全库副作用的授权从"作用域推导"（按定义必真）改为**调用者显式表态**——live 迁移需显式 `confirm: true` 才执行，缺失即拒绝并说明确认要求；dryRun 保持自由。确认门绕开了"工具面上不存在能正确授权全库副作用的身份"的困境：它不假装从 scope 推导出授权，而是把授权责任显式交还给调用方，让全库副作用从"隐式放行"变成"知情、显式、审计可见的动作"。0.20.0 终态在确认门之上再叠身份门——admin 白名单让"谁有权确认"第一次成为可配置的事实，本条从"已缓解"转"已消除"。

### D-05 · `MemoryItem.visibility` 与 `metadata.visibility` 双栖 — 已缓解（0.20.0，写侧单一事实源）

- **事项**：可见性 tier 存在两个落点：0.4 起的顶层列 `MemoryItem.visibility`（schema 权威），与写入路径 `metadata.visibility`（历史遗留 / ingest 载荷）。两处可能不一致。
- **决议**：已缓解——写侧单一事实源（0.20.0 修订；原"缓解"（读侧投票链统一）记录见本条末段）。
- **理由（0.20.0）**：**`metadata.visibility` 不再持久化**——写路径（src/services/memory-store.ts `insertItem`）在落库前剥除该键，新写入的行上 metadata 与列不再可能不一致；`visibility` 列成为唯一事实源（单一事实源原则：一个事实只允许一个权威落点）。外部 ingest 载荷仍可携带 `metadata.visibility`，但其语义从"被持久化的第二落点"降级为"写入派生的解释性输入"（派生后即剥除）。**读侧兼容保留**：存量 legacy 行（历史上已把 visibility 持久化进 metadata 的）继续走投票链 `item.visibility ?? item.metadata.visibility ?? 'global'` 读法——历史行不迁移、不过期，读路径与 exhaustive-acl 的 `null-legacy` 格口径不变。
- **残余风险**：绕过 `insertItem` 的外部写入（第二连接直插 SQL）仍可造出 metadata 带 visibility 的行——读侧投票链对这类行兜底，`integrityCheck`（I-DI-06/14）与 960 格真值表持续看守判定面。存量 legacy 行的 metadata.visibility 将长期存在（设计上不迁移），投票链因此是永久读侧兼容而非过渡期代码。
- **看守点**：I-DI-17（metadata.visibility 不持久化——列是唯一事实源，实现 src/services/memory-store.ts `insertItem` + test/genesis-services.test.ts）；SQL tier 过滤 ≡ JS 镜像由 I-ACL-04 看守；含 `null-legacy` 在内的 960 格穷举真值表（test/exhaustive-acl.test.ts，I-ACL-03）钉死"ACL 只认顶层列"。
- **原决议（历史，0.19 修订后、0.20.0 前）**：缓解——读侧口径统一为投票链（写入派生、蒸馏主导、检索展示三处同序），ACL 判定只用顶层列，metadata 不删（外部载荷在用）。0.20.0 修订把"读侧统一"升格为"写侧消灭第二落点"，双栖从"发病面收窄"变为"新写入结构性不存在"。

### D-06 · 联邦 / CRDT 无网络传输层 — 已缓解（0.20.0）

- **事项**：CRDT 联邦的 `sync()` 是**进程内**对等对象交换（src/services/crdt-federation.ts `sync(peer: CrdtFederation)`），全库没有任何网络代码（无 TCP/WebSocket/HTTP 服务端或客户端）；`memory_fed_search` 的成员宫也是由宿主注入的 palace 实例列表。
- **决议**：已缓解（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：内置**零依赖 HTTP 传输层**落地（src/transport/，node:http，不新增任何 npm 依赖），把"宿主只需把 op 包在任意信道上搬运"变成开箱即用：(1) **检索面**——`createFederationServer({member, secret, serveScope, host, port})` 把任一 retrieve 契约成员暴露为 HTTP 服务，`httpFederationMember(url, secret, {name, timeoutMs})` 是其对等客户端适配器（PalaceMember 形状，直接 addMember 进 FederatedRetriever）；(2) **CRDT 面**——`createCrdtServer({crdt, secret})` + `syncOverHttp(local, url, secret)` 把进程内 anti-entropy 搬上网络，增量水位语义原样保留。安全面按本库纪律内建：**HMAC 对等认证**（canonical-JSON 签名，`timingSafeEqual` 恒时比较，无签名 / 错签名 401）；**默认服务面 = 匿名级联仅 global**（serveScope 缺省 `{}`——私有层不经传输外泄，客户端自带 scope 不可加宽服务面）；**体积 / 超时守卫**（超限 413、慢端不挂死）；**检索 embedding 线上默认剥离**（命中载荷不携带向量，节省带宽且向量本就非消费方所需）；**CRDT 增量水位持久化**（每对端 per-replica 水位落 palace_meta，崩溃回退全量交换——与进程内 sync 同一语义）。
- **残余风险**：**共享密钥模型**——对等认证是一密码一联邦，无 mTLS / 无节点发现 / 无多跳路由；密钥泄露即整域失守，跨信任域部署需宿主自建信道隔离。宿主仍可用库级 API 接线自定义传输（零依赖 HTTP 传输是缺省可用项，不是唯一合法拓扑）——原决议"传输由宿主接线"的路径保持开放。
- **看守点**：transport 三测试——test/transport-http.test.ts（检索面：认证 401 / 413 / 超时 / embedding 剥离 / serveScope 边界）、test/transport-crdt.test.ts（CRDT 面：跨网收敛 / 增量水位 / 401）、test/transport-e2e.test.ts（双宫殿真实 HTTP 端到端：跨宫检索、CRDT 跨网收敛、错密钥 401、私有层不外泄——I-ACL-14 / I-PO-19 / I-DI-19 的执行点）。
- **原决议（历史，0.20.0 前）**：接受。理由：传输是库级 API 的**宿主责任**，刻意不内置：线格式已定（胶囊 HMAC framing），合并语义已定（LWW-Map / OR-Set、(lamport, palaceId) 全序），宿主只需把 op 包在任意信道上搬运。内置传输层反而会带来本库不该有的网络攻击面、鉴权与加密责任。README CRDT federation 一节已按此口径描述。残余风险：宿主若用明文信道同步，机密性与防篡改依赖胶囊签名是否启用（未签名胶囊只有完整性自校验，无来源证明）。0.20.0 的修订并未推翻该论证的边界意识——内置的正是当年最担心的"网络攻击面、鉴权"三件套（HMAC 认证、global-only 服务面、体积/超时守卫），并把"宿主自定义信道"从唯一选项降级为并列选项；无 mTLS / 发现 / 多跳的残余即该边界的诚实记账。

### D-07 · 零 LLM 启发式摘要 / 查询理解 — 已缓解（0.20.0，部分）

- **事项**：蒸馏合并默认是确定性拼接而非 LLM 摘要（LLM `summarize` 回调是可选项，src/services/memory-compressor.ts `summarize?`）；查询理解（时间窗解析、引用短语、否定极性）全部是手写启发式；模式挖掘、共识合成、矛盾检测同理——全链 LLM-free。
- **决议**：已缓解——部分（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：零 LLM 的**质量天花板**在三个确定性前端各抬一刀，离线约束本身不动。其一，**检索期词法匹配引入词干折叠**（src/utils/stemmer.ts，类 Porter 最小子集：deploy ↔ deploys/deployed、running ↔ run、studies → study）——memory-retriever.ts 的关键词重排在 stem 域比较（overlapScore / phraseHits 两处；paramsKey 加 STEM_RULESET_VERSION 常量），产物冒烟实测的 miss 类（"how does aurora deploy?" 查不到 "The Aurora service deploys…"，offline-bm25 下 deploy 与 deploys 哈希到不同维）就此关闭；折叠是纯匹配期行为，embedding tokenize 与 offline BM25 哈希保持原始域（向量空间稳定性）。其二、其三，**蒸馏与分层树由并行落地的抽取式摘要内核与抽取式 digest 抬升**（如实记录：确定性拼接的天花板抬到抽取式质量，仍零 LLM）。
- **残余风险**：折叠无例外词典，接受少量过/欠折叠（movies → movy 不与 movie 折叠；database ↔ databases 等规则族正常折叠），残余表现为"退化为字面匹配"，与原决议同型、无错误答案风险；**语义级改写 / 生成式摘要仍需 LLM**——可选 `summarize` 钩子保留，故本条是"部分缓解"而非终结。
- **看守点**：stem 域仅限检索期匹配（禁入 embedding tokenize / BM25 哈希；paramsKey 除版本常量外不变）由 I-NT-12 看守（test/stemmer.test.ts + test/retrieval-kernel.test.ts 旗舰回归）；离线全链可运行仍由 chaos 套件事实看守（test/chaos.test.ts）；CJK 分词确定性（I-NT-02）、否定极性 / 时间习语（I-NT-09 / I-NT-10）看守点不变。
- **原决议（历史，0.20.0 前）**：接受。理由：**离线可运行是产品约束**：offline-bm25 嵌入兜底 + 零 LLM 依赖，palace 在无 API key、断网、隐私敏感环境（本地 DSH）必须完整工作。启发式的可复现性与可测性（否定极性、时间习语 lookahead 都有专属断言）恰是 LLM 路径给不了的。质量上限确实低于 LLM 摘要——这是用确定性换来的。残余风险：长簇拼接摘要的 token 经济性差于 LLM 摘要；启发式查询理解对未覆盖习语（新语言、新时间表达）静默不解析——前者由压缩预算与 savedTokens 诚实记账约束，后者表现为"退化为普通关键词检索"，无错误答案风险。

### D-08 · `user_version` 32 位回绕 — 已消除（0.20.0）

- **事项**：缓存失效戳 `dataVersion()` 直接用 SQLite 的 `PRAGMA user_version`（src/services/memory-store.ts `bumpDataVersionNow`：`user_version = dataVersion() + 1`）。该 header 字段是**有符号 32 位**整数：到达 2147483647 后再 +1 会**归零**（实测回绕路径 2147483646 → 2147483647 → 0 → 1，非补码负数），单调戳每个约 2^31 次写事务复位一次。理论上存在"假新鲜"窗口：上一周期的陈旧缓存条目版本 V 与回绕后的新版本 V 相等而被误判新鲜。
- **决议**：已消除（0.20.0 终态；原"接受"决议与其反证保留为历史段并**升格为设计规格**——反证划定的约束恰被终态方案逐一满足，见本条末段）。
- **理由（0.20.0 终态）**：**epoch 命名空间转移**——不清零、不钳制，把回绕变成一次命名空间移交。缓存失效身份从裸计数器升维为复合串 **`dataVersionStamp(): string` = `<epoch>:<user_version>`**（src/services/memory-store.ts）：计数器抵达 2147483647 时，`bumpDataVersionNow` 在**同一事务**内双写 `user_version = 0` ∧ 持久 epoch +1（palace_meta 键 `dataVersionEpoch`——meta 表文本行，**无 32 位宽度限制**；standalone 路径显式事务包裹双写、ingestTx 内并入既开事务，崩溃不可能撕出"已清零而未升 epoch"的窗口——那将恰好重开本设计要关闭的假新鲜窗口）。**缓存消费面全切换复合戳**：语义查询缓存（src/utils/query-cache.ts，字符串严格 `!==`）、检索器（src/services/memory-retriever.ts 以 `dataVersionStamp()` 为 dataStamp）、PageRank SWR（src/services/memory-graph.ts——`graphVersion()` 现返回同一复合戳）；裸 `dataVersion()` 降级为 stats/诊断面（其数值在回绕处别名：epoch E 的 V 与 epoch E+1 的 V 是不同数据态却数值相等）。由此四个性质成立：**假新鲜数学不可达**——回绕后一切比较落入全新命名空间，旧条目携带旧 epoch，跨 epoch 的复合串**必失配**，原窗口不是"概率渺茫"而是**不可表示**；**epoch 滞后方向性安全**——epoch 只增，本进程缓存视图只可能**滞后**于持久值而永不可能超过，视图上刷新只会让后续戳与既有条目不可比（**miss = 重算**），永不相等（假命中），"宁失勿陈"的方向性被保持（meta 行缺失/损坏降级为 0，同样滞后方向、安全）；**多进程回绕经 version-下降检测刷新**——外部进程（插件宿主 + CLI 共享此文件）的回绕把计数器压回 0，WAL 令该 header 写对本进程可见，`dataVersionStamp()` 以"读值低于本进程上次所见"为唯一过程无关的回绕信号，触发时重读 palace_meta 再复合（每次回绕付一次点查）。
- **残余风险**：无。2^31 次写事务的可达性本就渺茫，本设计将其后果从"理论数据正确性风险"降为**零**：即便真的发生回绕，旧戳含旧 epoch 必失配，缓存只 miss 不假命中。（实现注释中诚实记有一个极端共存注记：残余理论窗口要求本进程在其他使用者跑完**整个** 2^31 写事务回绕周期、且计数器爬回上次所见值期间一次戳读取都不做而缓存保持温热——即该进程全程零检索工作，在任何本库目标的运行包络之外。）
- **看守点**：test/fault-injection.test.ts 场景 3 旗舰（外接连接把戳推到 2147483646：复合戳 `epoch:version` 格式、抵达 ceiling 同 epoch、**回绕恰升 epoch+1 且持久于 palace_meta（外连接可读）**、**假新鲜死亡证明**——pre-wrap 缓存条目在回绕后任意复合戳上恒 miss、回绕后周期 epoch 段稳定而 version 段重新计数且失效语义照常、**多进程 epoch 采纳**——外连接自行回绕 → 本进程 version-下降检测 → 采纳外来 epoch，旧命名空间条目 miss）+ I-DI-21；计数器本身的单调非降仍由 I-DI-09（chaos 不变量 b）看守。
- **原决议（历史，0.20.0 前；反证升格为设计规格）**：接受。理由：触发条件是**同一条缓存查询的两次读之间隔着 2^31 次写事务**——按每次写 1 µs 计也要连续写约 36 分钟、总量 20 亿事务，实践不可达。且 fault-injection 已把回绕行为**实证钉死**：回绕后每次 bump 仍改变戳值（卡死的戳才是缓存失效的真正死敌）、缓存消费者在回绕值上行为正确、写提交与失效照常。反证（为何不修）：任何"修复"本身都会引入回绕后旧值假新鲜的新危害——无论换 64 位戳、回绕时清空缓存还是重置戳值，迁移/重置瞬间都必然存在"上一周期持有版本 V 的陈旧缓存条目"与新戳值域重新对齐的窗口（清空动作与在途读之间的竞态、或迁移前遗留的第二进程旧缓存），等于把一个理论窗口人为变成修复必经的瞬态；不修则该窗口仅在 2^31 次写事务后理论存在，故不修。——**该反证并未被终态推翻，而是升格为它的设计规格**：反证证明的恰是清零/钳制类朴素修法有害，从而刻画了正确解的约束——**既不可清零也不可钳制**（清零/重置/清缓存重新制造对齐窗口；钳制令计数器冻结在 INT32_MAX、戳卡死、静默停止失效）。epoch 命名空间转移满足该约束的全部条款：不清零（旧命名空间原样保留、其中条目自然过期）、不钳制（计数器照常推进、只是换命名空间继续数）、旧戳含旧 epoch **必失配**（假新鲜不可达）、epoch 滞后**方向性安全**（只 miss 不假命中）、epoch 持久于 palace_meta **无宽度限制**、多进程回绕经 version-下降检测刷新——当年"不修"论证里的每一条关切，都被终态方案逐一接住。

### D-09 · 共享 session 的跨用户可见性 — 重分类：验证属性（0.20.0）

- **事项**：`session` tier 的可见条件是**且仅是** `session_id = ?`（src/utils/scope.ts 表头契约）——不校验 userId。两个不同用户若持有同一 sessionId，彼此都能看到对方写入 session 层的行。
- **决议**：重分类：验证属性（0.20.0）——退出风险登记册，语义本体移交 INVARIANTS.md 作为被看守不变量（I-ACL-17）；原「接受」记录保留为本条末段。
- **理由（0.20.0 重分类）**：重分类的诊断先于动作：本条入册时被归为「接受的风险」，复查认定它**从来不是风险，而是设计核心语义**——session 就是"共享可见组"：协作会话、多人同一对话上下文、agent 接力场景下，session 层的全部意义就是组内互见；要私有就写 user 层（`memory_remember` 的 `visibility` 覆写）；sessionId 由宿主分发，**持有即授权（bearer credential）**——给 session 叠加 userId 校验会破坏协作语义本身。其实现正确性不是被"信任"而是被**证明**：exhaustive-acl 以 **2880 格三方穷举**（960 caller×row 组合 × 3 层，SQL ⇔ JS `visibleAtLevel` 镜像 ⇔ prophecy 真值表）逐格验证 session tier 对持同 id 者可见、对不持者不可见——"实现正确"本身是被穷举证明的命题，不是被接受的假设。**退出登记册的理由是登记册纯度**：本表只收真实风险与取舍，一条"设计即如此、且已被穷举证明如此"的条目留在风险登记册里，会让读者把设计语义误读为风险敞口、稀释登记册的信号——三表分工中"被看守的性质"归 INVARIANTS，本条正是按分工归位（语义现由 I-ACL-17 看守）。退出不是裸放走，留下两道新防线：其一（**纵深防御**）——**弱会话号运行时告警**：检测到可猜测 / 低熵 sessionId 时发出运行时警告，把"sessionId 是进入会话可见组的 bearer 凭证"这一威胁模型从文档建议显性化为运行时可观测面：宿主分发弱号等于自拆组边界，现在它会被告警照亮，而不是被静默原谅；其二（**语义钉死**）——test/session-semantics.test.ts 以三用例把语义钉成断言（同 sessionId 即同组、异 sessionId 互斥、session 组不加宽到 user 层），防止未来有人把共享可见组语义当 bug 误修：给 session tier 叠加 userId 校验的"修复"会静默破坏协作场景，而钉死测试让这种"修复"当场红——语义的未来漂移与错误修复同被拦住。
- **残余风险**：bearer-credential 模型的固有形态：宿主若无视告警仍把可猜测 / 可枚举的 sessionId 分发给不相关方，组边界仍由宿主 id 卫生决定（告警覆盖常见弱号形态，不承诺穷尽一切低熵分配策略）——与 API token 同族的责任边界，非本库可代偿；要绝对私有的内容写 user 层的语义出口不变。
- **看守点**：test/session-semantics.test.ts（I-ACL-17 执行点：钉死三用例——同 sessionId 跨用户 / 跨 workspace 互见、异 sessionId 互斥、session 组成员不见 user 层）+ test/exhaustive-acl.test.ts（穷举面：2880 格三方真值表，session tier × 全部 caller 身份组合逐格钉死）；弱会话号运行时告警的运行时面随 I-ACL-17 登记；逐层加宽不跨 owner 由 I-ACL-05 继续看守，匿名探针由 I-ACL-02 继续看守。
- **原决议（历史，0.20.0 前）**：接受。理由：这是**设计语义**而非漏洞：session 就是"共享可见组"——协作会话、多人同一对话上下文、agent 接力场景下，session 层的全部意义就是组内互见。要私有就写 user 层（`memory_remember` 的 `visibility` 覆写）；sessionId 本身就是进入该组的凭证。给 session 叠加 userId 校验会破坏协作语义，且 sessionId 由宿主分发，持有即授权。残余风险：宿主若把 sessionId 当作可猜测/可枚举的标识分发给不相关方，等于自己拆了组边界。这是宿主 id 卫生问题。看守点：960 格穷举真值表（含 session tier × 全部 caller 身份组合，test/exhaustive-acl.test.ts，I-ACL-03）把"session 行对持同 id 者可见、对不持者不可见"钉成断言；匿名探针（I-ACL-02）与逐层加宽不跨 owner（I-ACL-05）同步看守其余边界。——0.20.0 重分类没有推翻原论证的任何一条（协作语义、user 层出口、"持有即授权"全部原样保留为现行语义），改写的是**归类**：同样的句子从"风险登记册里的接受理由"移格为"被 I-ACL-17 看守的验证属性"；原"残余风险"（宿主弱号卫生）不再是被静态接受的风险敞口，而是带着运行时告警与钉死测试的显性化威胁模型。

### D-10 · 查询缓存近重复 Hamming>1 漏命中 — 已缓解（0.20.0）

- **事项**：语义查询缓存按锚桶定位候选（src/utils/anchors.ts：桶邻居 = 键距 Hamming ≤ 1，4 平面 16 桶扇出 5）。两条 cosine ≥ 0.985 的近重复查询若锚键 Hamming 距 > 1，会**互相漏命中**——缓存 miss。
- **决议**：已缓解（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：lookup 增加**全量兜底扫描**（容量有界）——锚桶定位未命中时，对缓存内全部条目（容量上限内的有限集）做一遍相似度裁决，命中即复用。**命中充分性不再依赖桶几何**：桶定位降级为纯快速路径，Hamming>1 的近重复查询也能经兜底扫描命中；"宁失勿陈"不变——兜底扫描仍以 cosine ≥ 0.985 阈值裁决，永不产生错误命中。原决议的两难（扩 Hamming 邻域 = 扇出 5 涨到 11、成本翻倍）被绕开：不扩邻域，而是 miss 时付一次有界全扫。
- **残余风险**：兜底扫描的最坏成本是缓存容量级的线性扫描（每次 miss 都全扫）——这是性能上限问题而非正确性问题，且缓存容量有界（默认 32 条目），全扫代价恒小；桶定位仍承担绝大多数命中的快速路径角色。
- **看守点**：I-RC-12（语义缓存命中充分性由全量兜底保证，test/retrieval-kernel.test.ts + src/utils/query-cache.ts 实现）；"锚桶 + cosine ≥ 0.985 双验、宁失勿陈"仍由 I-RC-02 看守；缓存键完备性仍由 I-RC-01（genesis-retrieval G4）看守。
- **原决议（历史，0.20.0 前）**：接受。理由：缓存是纯加速器不承诺召回，漏命中回退完整打分管线，永不错误命中；扩 Hamming 邻域收益边际而成本翻倍。0.20.0 修订以有界兜底扫描把"漏命中回退"从常态压缩到兜底也 miss 的情形。

### D-11 · chaos 风暴中数字模板内容被 0.92 写时去重 — 已缓解（0.20.0）

- **事项**：写时近重复去重阈值 `DEDUPE_SIM = 0.92`（src/index.ts 硬编码常量）。在 offline-bm25 稀疏向量空间下，**模板化数字内容**（chaos 风暴的固定词表模板句、或模型批量复述的编号事实）的 cosine 容易越过 0.92，被写时去重合并（返回既有 id，不落新行）。
- **决议**：已缓解（0.20.0 修订；原"接受"记录见本条末段）。
- **理由（0.20.0）**：修订先重新诊断病情：稀疏向量放大模板内容的相似度是**嵌入空间的物理事实**——offline-bm25 的词法哈希维度上，同模板异数字的句子天然高 cosine，这既无法也无需"修复"。原状态的真实缺陷是**该后果对调用者不可见、且阈值不可调**：模型把"记住编号事实 X"发进宫殿，拿到的是一个 id 与"已记住"的表象，折叠静默发生——合并是不是模型想要的结局，模型既看不见也无从干预；而 0.92 / 0.75 两个阈值对模板语料偏松、对其他语料可能偏紧，宿主却没有任何旋钮。升维把这两层都拆掉，三面落地：**写时结局四态透明**——`memory_remember` 响应新增 `writeOutcome` 四态（created / deduplicated / superseded / conflict-flagged），各态携带证据字段（matchedId / similarity / conflictReason），去重合并从静默折叠变为带被合并目标与相似度的显式回报；稀疏嵌入空间（offline-bm25）下非 created 结局（去重 / 替代 / 冲突）更附 **advisory**——提示调用者当前嵌入空间对模板化近同文判别力有限、需区分事实时应给出实质不同的表述——原决议里"面向模型的提示词事项"从测试注释与文档建议**升格为运行时反馈回路**：模型在收到 deduplicated 结局的当下就能调整措辞重写，而不是事后翻文档。**阈值可配**——`retrieval.writeDedupeThreshold`（缺省 0.92，去重合并线）与 `retrieval.conflictScanThreshold`（缺省 0.75，冲突扫描下限）成为配置键，模板语料宿主可收紧、宽松语料宿主可放松，缺省与既往逐字节一致（零配置兼容）。**correctness 核心钉死为不变量**——最关键的性质（带冲突的高相似新事实永不静默丢失或静默吞并：数值漂移 v16→v17 类更新必走替代 / 冲突路径，绝不折进去重合并）由 I-RC-14 钉死（test/write-outcome.test.ts 旗舰 + test/integration.test.ts supersede 段），四态完备性与证据字段由 I-PO-22 看守——升维前这条性质只活在代码注释里，升维后任何把它改回"高相似即合并"的回归当场红。
- **残余风险**：相似度启发式的本质仍依赖**嵌入质量**——阈值可调、结局透明、漂移必走替代链，但"这条新事实与那条既有事实是否同义"的判断本身仍是 cosine + 矛盾检测的启发式裁决，offline-bm25 稀疏空间下判别力有限（deepseek 部署下更优——与 D-03 残余同族：判别 / 探针质量依赖离线嵌入的判别力）；advisory 只是提示，是否重写措辞最终仍由模型侧决定。
- **看守点**：test/write-outcome.test.ts（I-RC-14 执行点旗舰：数值漂移必走替代 / 冲突路径；I-PO-22：writeOutcome 四态完备且携带证据字段）+ test/integration.test.ts supersede 段（I-RC-14）；既有 metamorphic R2（`deduplicated === false` 前置断言）与 R4（SUBJECTS 注释 + 版本戳写增读不变）继续看守测试语料的去重前置条件；去重-更新分流（相似 + 矛盾共同裁决）由 memory_remember 行为测试看守；墓碑不复活由 I-DI-01（genesis-store #2）看守。
- **原决议（历史，0.20.0 前）**：接受。理由：去重合并是 `memory_remember` 的**正确行为**——模型若灌入近重复的模板事实，本就该去重（这是面向模型的提示词事项：需要区分事实时应当给出实质不同的表述，而非指望存储层为编号差异保留 N 份近同文）。测试侧已把该行为**显式录入注释与前置断言**：metamorphic R2 注入 ~0.8 相似副本并断言前置条件 `deduplicated === false`（低于合并线、两行并存），R4 的 SUBJECTS 注释明言"near-identical templated facts would hit the 0.92 write-time dedupe (correct behavior, wrong for a test that needs every remember to be a real write)"，因此语料刻意取 20 个实质不同主语。残余风险：模型侧不知情时，会把"记住编号事实 X"静默折叠进既有近同文行（响应里 `deduplicated: true` 可观测）。语义确实变化（版本号递增类内容走 supersede 链而非去重——v16→v17 是更新不是克隆）。——0.20.0 修订没有推翻"去重合并是正确行为"的语义论证（无冲突的近同文今天仍然合并、仍然只返回一个 id），推翻的是其**可观测性与可配置性**：合并发生时模型如今拿到的是四态结局 + 证据字段 + advisory 而非一个 id 表象，阈值从常量变为配置键，"带冲突的相似新事实绝不合并"从注释升格为被钉死的不变量（I-RC-14）——原论证里"面向模型的提示词事项"一句话，正是升维把它变成运行时反馈回路的诊断。

### D-12 · ownerKey 管道分隔复合键碰撞 — 已缓解（0.20.0）

- **事项**：owner 复合键（src/services/memory-compressor.ts `ownerKey`）以 `|` 拼接 visibility / userId / workspaceId / sessionId 四段。userId 与 workspaceId 是宿主供给的自由文本——任一分段自身含 `|` 时，不同分段组合可以拼出同一键（`a|b|c` 歧义，与 CRDT orTag 分隔符歧义同类机理）：`("a|b","c")` 与 `("a","b|c")` 共享一个分区键，两个逻辑上不同的 owner 被折叠进同一压缩分组/模式归属。
- **决议**：已缓解（0.20.0）。
- **理由**：**分区键改用 `\u0000`（NUL）拼接**——该码位不可能出现在合法 id 字符串中（宿主 id 卫生的最低要求），复合键因此不可由任何分段内容伪造，碰撞类结构性关闭（与 embedding-space 拼接键 `${space}\u0000${ownerKey}` 同一模式，见 memory-compressor.ts）。**模式 id 保持稳定 `|` 格式不变**——已持久化的 pattern id（`${ownerKey}::${pattern}`）格式不迁移不过期，存量 id 不 churn；模式 id 仅作存储键与审计可读性用途，不参与分组判定。
- **残余风险**：若宿主 id 真含 `\u0000`（SQL 文本列中的 NUL 在多数 SQLite 驱动层就不可达），碰撞将复现——这是"输入不可含 NUL"的最弱前提，与 CRDT orTag 的 `@` 分隔前提同级。模式 id 仍以 `|` 拼接：它只要求"对同一 owner 稳定"，不要求"跨 owner 无碰撞下证明"，且分组正确性已由分区键保证。
- **看守点**：I-DI-18（owner 分区键 `\u0000` 防撞，运行时 src/services/memory-compressor.ts + test/genesis-services.test.ts / test/pattern-miner.test.ts）；两 owner 近同内容各蒸馏各的由 I-ACL-10（genesis-services #2）看守。

### D-13 · communities cohesion 自环虚高 — 已缓解（0.20.0）

- **事项**：`memory_graph communities`（标签传播聚类，src/utils/communities.ts）的 cohesion 统计（社区内边权占比）把**自环**（实体与自身的共现边）计入分子——自环不携带任何跨社区结构信息，却稳定推高"社区内聚"读数：一个全是自环的退化图可报告 cohesion 接近满分，统计"貌似合理但虚高"。
- **决议**：已缓解（0.20.0）。
- **理由**：**统计侧剔除自环**——cohesion 的 intra/total 计算排除 from === to 的边；聚类算法本身（标签传播、社区划分）不变，输出社区结构零漂移，只有统计读数回归诚实。自环若存在，属于上游建边的输入卫生问题（I-DI-06 integrityCheck 的图结构自检面），不在统计侧二次纠正聚类。
- **残余风险**：无残余（纯统计口径修正，无行为面变更）。唯一注意点：若未来有消费方依赖旧的虚高读数做阈值判断，需按新口径重校准阈值。
- **看守点**：I-RC-09 同族的图统计质量断言（properties.test.ts 随机图守恒类）+ communities 行为测试（test/integration.test.ts graph 类）；自环计数进 integrityCheck 报告的面由 I-DI-06 看守。

### D-14 · `listEdgesScoped` 无界物化 — 已缓解（0.20.0）

- **事项**：作用域边列表 `listEdgesScoped`（src/services/memory-store.ts）把全部匹配边一次性物化为 JS 数组、无上限——巨型共现图上一次展示性调用（`memory_graph` expand / communities 的边集输入）即可把数十万行拉进堆内存，内存峰值与图规模线性挂钩且无闸。
- **决议**：已缓解（0.20.0）。
- **理由**：**展示路径默认 `limit 10000`**——展示性消费（工具面返回、人读输出）以显式上限截断，超限响应携带截断标记（可分页/收窄）；**rank 路径保持无界**——PageRank 的质量守恒（Σrank ≈ 1，I-RC-09）在数学上要求全边集，任何截断都会改变数值结果，该路径的"无界"是**零漂移要求**而非疏漏：图规模本身由保留机制（R10：实体/边修剪）与 bench 门禁看守，rank 全量物化的成本是图规模的函数、有既有基线看护。
- **残余风险**：展示截断意味着超 1 万边的子图在工具面上不可一次全览（需收窄查询或分页）——这是可观测的、显式的限制，优于 OOM。rank 路径的理论无界仍在（R10 机制看守），若图规模失控，先红的是 bench 基线与保留机制，不是 rank 路径本身。
- **看守点**：展示路径 limit 与截断标记的行为测试（test/integration.test.ts graph 工具面）；rank 无界零漂移由 I-RC-09（Σrank ≈ 1，genesis-retrieval G3 / properties.test.ts）看守；规模面由 bench 门禁（I-PO-12）看守。

### D-15 · 完全匿名写入的 fail-open 落 global（隐式默认） — 已缓解（0.20.0）

- **事项**：写入方**完全匿名**（userId / workspaceId / sessionId 三无）时，落层推导 `resolveWriteTier`（src/utils/scope.ts）的两个相位都找不到可背书的 owner id，相位 2 兜底返回 `'global'`——一切用户面写入边界（message / tool 事件 ingest、`memory_remember`、胶囊 import、`session.end` 蒸馏）对匿名调用者 **fail-open**：内容直接落共享 global 层、对全体用户可见，且该行为是**隐式默认**，没有任何配置面可以收紧。I-ACL-02/03 穷举看守的是匿名者的**读**面（只见 global）；写面的对称问题——匿名写入污染共享层——长期停留在"零配置体验"的默认放行状态。
- **决议**：已缓解（0.20.0）。
- **理由（0.20.0）**：显式**三态** `anonymousPolicy`（config 键 `scope.anonymousPolicy`，缺省 `'global'`）：**global**（默认）——零配置兼容，缺省行为与显式设 global 逐字节等价，单用户 / 本地部署（本库主场景）不为收紧付出任何配置成本；**quarantine**——匿名写入落 `ANONYMOUS_SESSION_ID = '__anonymous__'` 的 session 桶，行带 session owner，任何持真实 id 的已识别用户的读取级联永不含该桶（匿名写入不再污染共享层，桶内匿名者互见——见残余风险）；**reject**——fail-closed，身份保证型宿主（在自身边界已完成认证、不接受任何未认证写入）显式拒收，拒绝是可观测的业务失败而非 handler 崩溃。三态在**全部用户面写入边界**强制（message / tool / remember / import / session.end），MCP 独立服务器经 `MEMORY_PALACE_ANON_POLICY` 接入（非法值 stderr 警告回退 global，启动横幅输出当前策略）。
- **残余风险**：默认仍是 global——零配置体验优先，**多租户宿主应显式设置 quarantine 或 reject**（与 D-01 同型的接线责任边界：默认优化的是单用户体验，不是多租户安全）；quarantine 桶内匿名者互见（对无身份者互见的容忍与 D-09 共享 session 同语义——无 id 者本就无更窄的隔离单位可指派）；reject 拒的是写入不是调用——拒绝路径必须恒为业务失败，这一形状本身由 I-ACL-15 断言看守。
- **看守点**：test/anonymous-policy.test.ts（三态 × 全部用户面写入边界：默认 ≡ 显式 global 逐字节等价、quarantine 桶对已识别用户不可见、reject 拒收不崩 handler）+ I-ACL-15；默认面（不配置时）的既有 ACL 真值由 test/exhaustive-acl.test.ts 穷举矩阵继续钉死。

### D-16 · 中文实体抽取稀疏 — 已缓解（0.22.0）

- **事项**：实体抽取（`memory-graph.extract`）的 IDENT_RE 纯 ASCII（CamelCase / snake_case / ACRONYM），中文会话里裸中文名词（告警服务 / 时序数据库 / 数据迁移项目）**永不成为实体**——图对中文会话只剩路径 / URL / @提及 / #标签四类锚点，共现图、PageRank 先验、实体跳扩召回、`memory_why` 溯源与图分析全面稀疏；更深的连锁：typed-relation 抽取（`utils/inference.ts` 的 CN 连接词模式：依赖 / 部署在 / 使用 / …）以实体名单为输入，「告警服务依赖 Kafka」因 告警服务 不在名单而**从不产边**——中文图谱上的夜间传递推理整体哑火。
- **决议**：已缓解（0.22.0）——**多信号确定性抽取，零词典零依赖**（与 D-07 的零 LLM / 零外部词典约束同族）。三档精度分层：① **引号锚定**（「」『』【】“” 内 2–8 字 span——用户显式标记，最高精度）；② **系统名词后缀锚定**（策划的 ~48 个系统域后缀：数据库 / 服务 / 集群 / 网关 / 计划 / 项目 …，最长优先匹配；**名词短语结尾约束**——后缀之后必须是 run 末尾、胶着字或连接词，防 告警 从 告警服务 中间漏出；向左 ≤5 字走查停在**边界**——单字胶着字（的了是在…）或**连接词串**（依赖 / 部署在 / 使用 …——连接词恰是两个实体提及之间的分界）；候选过 2–8 字长度门与 CJK 停用词门）；③ **精确重复**（2–6 字 Han span 消息内出现 ≥2 次、无胶着字、最长保真——被更长重复项包含的子串吸收）。CJK 通道独立子配额 `MAX_CJK_ENTITIES_PER_MESSAGE = 8`（统计档精度低于 naturals，不得挤占 handle/path/url 名额——那会连带饿死 typed-relation 抽取）；classify 走共享尾段，项目 / 计划后缀新增 **Han 复合边界规则**（数据迁移项目 此前因 `[\s_-]` 词边界永不命中而恒为 concept——顺带修掉的存量缺陷）。**纯 ASCII 文本不进任何 CJK 路径——英文抽取逐字节不变**（回归钉死）。
- **理由**：零依赖 / 确定性约束排除分词器与词典方案；放弃整句分词（CJK n-gram 候选灌爆实体配额并污染图，共现边 O(n²) 写放大）。只取**用户显式标记**（引号）与**统计显著**（系统名词后缀、精确重复）的 span——与模式挖掘器对比门（≥3 items / ≥2 天 / ≥重要度均值）同一哲学：把"刻意"与"偶发"分开。连接词复用 typed-relation 的既有词汇，一石二鸟：它既是名词短语分界，又是关系存在的证据。
- **残余风险**：**中庸召回**——未加引号、不带系统名词后缀、单次出现的普通中文词（预算 / 审批 …）仍不成为实体（对比门的代价，换图不被噪声灌爆）；后缀表是**策划的系统域清单**而非通用 NER（医学 / 法律等领域需扩表——扩表只动常量，不改算法）；重复档以"同消息内重复"为前提（跨消息复现由 mention_count 累积与模式挖掘层承接）。粒度嵌套（数据库 与 时序数据库）可能共存为两个实体并产生一条平凡共现边——可接受（两者都是真词，删除任一都丢信息）。
- **看守点**：test/utils.test.ts（多信号抽取 / 连接词边界切分 / 停用词门 / 子配额 / **英文路径逐字节不变** / classify 含 Han 复合 project 规则 + 端到端「告警服务依赖 Kafka」产 depends-on 边）+ I-RC-16；英文不变面另由 chaos / integration / genesis 全套英文语料间接看守。

---

## 3. 编写规约

本表与 INVARIANTS.md / POSTMORTEM.md 同源同纪，扩展时遵守：

1. **只收缓决事项**。判定为"设计内 / 接受 / 缓解 / 搁置"的审计发现进本表；实证 bug 进 CHANGELOG + POSTMORTEM，被看守的性质进 INVARIANTS。禁止把"没来得及查"写成"接受"。被重分类为验证属性的条目保留原编号与全部历史段落、状态改标（图例见篇首），不再计为在册风险——语义本体以 INVARIANTS 编号看守。
2. **看守点必须可核**。每条引用的文件 / 符号 / 测试 / 不变量编号必须真实存在于仓库（grep 可得）；写"由 XX 看守"时 XX 必须是已登记的 INVARIANTS 编号或现存执行点。无看守点的条目必须写"无（裸接受）"并给出复核触发条件。
3. **编号只增不改**。D-xx 固定；决议状态变更（搁置转修复、接受转修订）不删旧条，在原条目标注修订并指向新证据，分类史本身是本表的价值。
4. **每条五要素齐全**：事项（是什么，含量化边界）、决议（接受 / 缓解 / 搁置 / 重分类：验证属性——四选一，图例见篇首）、理由（为什么不改 / 为什么重分类）、残余风险（接受了什么坏处、何时需要 revisit）、看守点（谁在看着 / 什么会先红）。
5. **与门禁联动**。若某条的看守点是测试或 audit tripwire，该测试失效时本表条目即失去支撑——修复门禁优先于修订决议。
