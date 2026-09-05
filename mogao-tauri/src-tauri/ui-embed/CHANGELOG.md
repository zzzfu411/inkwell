# Changelog

## Unreleased — Narrative Production Engine v1

- 完成 Phase 8 质量证据收口：每次 fixture/live A/B 记录 27 个生成、上下文、prompt、评分与 gate 关键源码的 LF 规范化 SHA-256 manifest，并用 corpus/source/model/judge/time 生成唯一 run id；旧报告遇到源码漂移会自动回到 `hold`。
- 默认引擎提升改为 schema-v2 证据合同：浏览器策略对残缺或误改的 `pass` fail-closed，`quality-ab.mjs promote` 只为当前源码上的 live/pass 报告生成去正文 bundle，CI 再核对 report/evidence/corpus/source digest。当前仍无真实付费盲评证据，因此默认继续使用 Harness。
- 新增 47 个 classic scripts 的显式 composition contract；所有 `NOVEL_*` provider/reference 必须分类为 eager、deferred、optional 或 host external，静态测试与 boot 前后断言会提前拦截重复 provider、逆序、缺失和未登记依赖。canonical/embed 现为 53 项，旧 49 项 release 未被日常同步改写。
- 重构候选正文生成边界：场面契约仍负责结构，但默认只发起一次整章模型调用，原子提交完整正文，避免逐场独立采样造成复述、声线漂移和拼接接缝；逐场模式仅保留兼容回退。
- 完成 Phase 4 的发布级质量实验框架：固定 6 个题材 × 8 章，旧 Harness/候选引擎同协议 A/B，保存去密钥 prompt、context manifest、正文 hash、critic 与失败状态；生成 48 组确定性随机盲评包，并把本地信号、独立模型 judge、人工评分严格分层。
- 新增可复现质量 gate：fixture 仅可得到 `calibration-pass` 且永不具备发布资格；真实报告还必须满足 96 份工件完整、blocker/Canon 为零、关键维度改善、人工中位不下降。失败样本进入回归 fixture，不继续堆 writer prompt。
- 新增 `quality-release.js` 默认决策 `hold`。完整真实 A/B 与人工盲评通过前，新安装继续使用旧 Harness，候选引擎只允许用户手动开启，避免用引擎自评证明默认切换。
- 将正式写章默认重构为 `Chapter Contract → Scene Contracts → 场面检查点 → Semantic Critic → 有界救稿 → Quality Gate → Handoff`，半场失败会回滚到最近提交点，低质量正文停在 `needs_revision`。
- 新增按可信度分层的 Evidence Pack、上下文使用/裁剪 Manifest、作者锁定细纲、实测风格轮廓和八维叙事质量评分；RAG 仅作为 reference，不再覆盖 locked/continuity 事实。
- 质量重试不重复追加场面；作者改稿开启新的有限救稿周期并保留累计审计记录，直接章后交接不能绕过严格质量闸门。
- 恢复时用 `bodyAuthoritative/bodySig` 区分压缩后的完整正文，严格规划器缺结果也会明确阻断，不再静默拼接通用占位场面。
- 新增无 DOM 的 `production-state.js` 作为正文/质量/交接状态边界；缓存恢复、Vault 装载、工作区 Markdown、冲突裁决和最终交接都会核对正文签名，外部改稿不能再携带旧评分进入 `done`。
- 新增根/production `schemaVersion=1`、幂等相邻迁移与迁移审计；旧书、空书、中断场面、外部改稿和 recovery 均有 golden fixture，未知更高版本在保存、批量迁入、工作区与快照恢复前进入只读保护。
- 新增唯一 `chapter-state.js` 转换边界和合法转换表，task/production/handoff 终态不再由 app、Pipeline、Harness 或撤销卡各自拼装；撤销会原子恢复正文关联的 production、质量报告、任务和交接投影。
- 连续性自动修订提前到 Semantic Critic 之前；strict 交接必须具有已验收状态和匹配正文签名，`pending` 不再被误当成“未阻断即通过”。暂停/失败记录 `lastStableState`，交接失败的已验收正文可安全重试。
- 新增软件工程审计、分阶段重构路线和架构非回归测试：先封状态不变量，再拆用例/控制器、统一双后端契约、建立文章质量 A/B 发布门和不可变 release。
- 完成 Phase 2 前端拆分：写作、持久化、冲突、策划、交接、旧链路适配、上下文证据/预算/记忆均变为无 DOM 的显式依赖模块；`app.js`、`pipeline.js`、`context.js` 分别降至 4,500/1,400/1,500 行硬上限以内，并以直接行为测试和 49 条浏览器回归锁定现有 UI。
- 修复抢占型并发锁：交接或分析被修复任务顶替后，旧任务的 `finally` 不再能释放后继任务持有的生成锁，停止按钮也始终作用于当前运行。
- 完成 Phase 3 双后端合同：Rust/Python 共同执行 HTTP contract v1，统一核心路由的状态码、`error.code`、内容世代、章节并发基线与外部冲突 warning；新增复用正式 Axum 路由的无窗口 `inkwell-http` 入口和 Rust 浏览器 E2E，并明确 Python 兼容层冻结于 0.20.x。
- `productionEngineEnabled=false` 或关闭写前细纲时保留旧 Harness 兼容档；release/ui 与 Tauri embed 由 manifest 同步并通过全量回归。
- 浏览器冒烟探针改为跨 Windows PowerShell 版本稳定的 loopback `curl --noproxy`，失败时输出服务日志与最后一次探针异常。

## 0.19.0 — 前端分层 + 编辑器热路径 + 假保存冲突修复

前端：

- 新增 `story-records.js`（Canon / 伏笔 / 连续性筛选排序）、`graph-panel.js`（关系图取数）、`composer-review.js`（生成结果撤销闸）。三个模块不含任何 DOM 调用，各自带单测；`app.js` 只负责把视图模型拼成 HTML。
- 生成进度条的阶段判定移入 `ui-shell.js` 的 `generationRailState`，单测锁住「已交接 / 正文已出待交接 / 停止」三种终态不许互相冒充。
- 伏笔、连续性、人物列表改事件委托：一次重画上百张卡不再重新挂上百个监听。
- 契约测试新增前端分层与热路径断言，防止算法被抄回 `app.js`。

编辑器性能：

- `craftScore` 打分改为停手后防抖执行，长章打字不再每键扫一遍全文；存盘与生成前由 `flushCraftRescore()` 补齐，磁盘分数不会落后于正文。防抖回调只重画提示条，不重建细纲列表。
- `Ctx.packForWrite` 收敛到唯一入口并按签名缓存；改动经 `markDirty()` 自动作废，一次生成里不再重复装配上下文。

保存可靠性（阻断级修复）：

- 保存后回写每章的落盘基线。此前保存自己会重写章节文件、把磁盘 mtime 推新，而客户端仍拿加载时的旧 mtime 比对，于是**同一次会话里第二次改同一章就会被判成「外部修改」**：作者看到一个根本不存在的「磁盘版本保护」弹窗，正文也存不进去。改文件名的章跟着换用服务端的新文件名。
- 冲突章与被保留的磁盘章一律不换基线：那些磁盘版本还等着作者裁决，换了基线下一次保存就会静默盖掉。
- Python 与 Rust 两套后端同时在保存响应里回传 `chapterBaselines`，四层测试锁住（vault 单测 ×2、客户端单测、浏览器「连存两次」回归）。

0.18 自查收口：

- 补交接与修订后交接遇到 `AbortError` 原样抛出：作者点停止显示「已停止」，不再包成交接失败。
- 写下一章前扫描前文**所有** stale 章并按故事顺序补交接，不再只补相邻上一章；补交接强制关闭自动改稿，不在后台改写作者没在看的那一章。
- 只补自己标过 stale 的章，`handoffStatus` 缺失的旧书章节不会被自动烧额度。
- 无正文证据的问题（例如合成的「任务未覆盖」）不再送进唯一命中替换引擎：它只记进风险账，由作者补写。
- 版本闸补上 `index.html` 与 `app.js` 的三处回退字串，共 10 处一致才放行。

## 0.18.0 — 修订进入同一质量闭环

- 选段重写、批注修订默认走审查 + 章后交接；失败保留新正文并标 stale，不再让下一章对着旧 digest 写。
- 自动连写 / 续写前若上一章交接未完成，先补摘要再写；严格审查模式下补交接失败则停。
- 连续性审查把 `task_coverage.missing` 升为 major 任务问题，记进风险账。
- 检查器「精确局部修复」成功后同样自动交接。

## 0.17.0 — 关窗与写后合同收口

- `save_book` 拒绝用 slim 空 body 盖掉磁盘章节；启动失败时若 vault 已在线，不再用精简缓存替换已 hydrate 全书。
- `applyRecovery` 跳过 stub / 空章列表，不再误删可救回的恢复副本；stub 不再用 `Date.now()` 冒充磁盘 `updatedAt`。
- 关窗同步 PUT 走 `prepareProjectForSave`，解析 `saveWarnings`；`externalConflict` 写入冲突队列并阻止关窗。
- Tauri 拦截 `CloseRequested`：先同步 `__mogaoFlushSync`，失败则提示并保持窗口。
- 续写不再用本轮增量改写 `openingKind`；场面覆盖分地点/动作计分，去掉 2 字回退，空细纲为 0 分。
- 连续性修补与手改正文后重算或清掉 `craftScore`；细纲检查器与未落地场面回流对当前正文现场打分。
- digest 无证据或证据不在正文一律丢弃；`must_carry` / `new_info` 兜底事实先过同一闸再入库。

## 0.16.0 — 写后验收：场面落地 + 人味检查

- 写完一章后给 `craftScore`：细纲场面是否落地、对白占比、感官、套话。
- 未落地场面回流下一章装配，要求用余波补一句而不是整场重演。
- 细纲列表用边框标出已落地 / 缺口；检查器提示场面覆盖和对白比。
- 写章纪律与 prompt 要求场面落地、对白推进、禁止「他知道/心中涌起」代替动作。
- 人物声线优先注入 POV / 主角 / 女主，不再只靠任务卡点名。
- 离线评测增加 `beatSceneCoverage` 与 `dialogueRate`。
- 批注修订合同改为 `kind: "author-annotation"`；修正 Cargo 版本字段双分号。

## 0.15.0 — 成熟批量：同一闭环收口

- 重写选段、批注修订走 `pipeline.rewritePassage` / `reviseChapter`：带锁定与声线，失败不覆盖原稿。
- 按卷内位置区分闲笔 / 推进 / 高潮，自动调场面数和目标字数。
- 检查器可预览、编辑本章细纲；改过的细纲会锁住直到「重出细纲」。
- 自动连写每章读取当前指令框，中途改指令下一章生效。
- 分析块与块之间让出事件循环，降低长篇卡窗。
- 会话 token 经 HttpOnly Cookie + 302 清 URL；接口同时认 Cookie 与请求头。

## 0.14.0 — 写作品质可打分、可对比

- `eval-continuity.mjs` 增加开场撞车、细纲覆盖、套话风险、交接过期和字数均值。
- 离线 `--score` / `--compare` 不花额度即可打分；低于门槛退出码 2。
- 真模型回归默认打开细纲与套话检查，可与 `INKWELL_EVAL_BASELINE` 对比。
- 成熟验收表里「评测有数字」一格关闭。

## 0.13.0 — 续写与连写同一闭环

- Composer「从当前位置续写」改为走 `pipeline.continueChapter`：检索 → 续写细纲 → 追加正文 → 套话检查 → 可选交接。
- 已写完的章可以续写追加，自动连写重入仍不会叠章覆盖。
- 续写细纲只规划文末往后 2–3 场，不重写已有正文。
- 历史常驻 Goal 已归档到 `mogao-tauri/docs/history/GOAL-MATURE.md`。

## 0.12.0 — 自动连写读起来像人写

- 写前新增本章细纲：2–5 个场面后再落笔，细纲作为写前硬保块。
- 写章纪律要求按场次演、禁连章同开场、少套话、场面里要有具体感官。
- 新增 `craft.js`：开场类型、套话检查、digest 入库闸、细纲规范化。
- 交接会丢掉无证据或顶撞锁定 Canon 的事实；digest 补齐 `abandoned_loops`。
- 写后套话/撞开场记入连续性风险，供下一章看见。
- 精确局部修订默认打开。设置页可关细纲或套话检查。

## 0.11.0 — 报馆稿纸与关系星图

- 写作正文改为朱丝栏稿纸：左栏朱线、行线与稿纸底，章节标题使用正文墨色。
- 人物关系与分析页用可点选星图替代 Mermaid 主视图；源码进入高级折叠。
- 新增 `graph-view.js`：椭圆布局、度数截断、故事/分析共用。
- 故事与分析主文案改为作者语言，去掉对外的反代技术话术。
- 清理旧书库 200px 栅格与顶栏换行第一层；补齐缺失视觉 Token。
- 版本 fallback 从 `0.8.0` 收到 `0.11.0`。

## 0.10.0 — 墨色编辑台

- 写章请求正式接入输出 token 预算；SSE 支持 CRLF、跨块与无尾分隔事件，临时上游错误有限重试，输出截断会保留部分正文并提示续写。
- 保存遇到外部新版时进入双栏冲突处理，不再静默覆盖；Rust 与 Python 调试后端统一空章节保护、外部新增合并和快照恢复语义。
- 保存冲突队列与本地稿可跨重启恢复；切书、切库和整本保存前统一提交资料工作区，系统生成镜像保持只读。
- Python 调试后端拒绝绝对路径、父级与符号链接逃逸，并按书串行化并发写入；Rust 迁移接口限制为 64 MiB。
- 分析终态只在结果、图谱、报告与作品状态全部落盘后提交；最终化失败保留可续跑检查点。
- 760px 以下资料页改用具备 `inert`、ARIA、遮罩、Esc 与焦点恢复的文件抽屉；上下文健康优先暴露 RAG 降级。
- 正式 Windows 客户端把 API Key 从设置 JSON/localStorage 迁出，改为当前用户绑定的 DPAPI 密文。
- Playwright 固定版本，覆盖 84 组桌面主题/布局组合、6 项关键行为回归与三主题像素基线；正式发布默认拒绝脏工作树。
- 关窗同步保存只接受 2xx，资料文件失败会保持 dirty 并阻止离开；保存冲突绑定提交 revision，不再清除其他章节的新恢复稿。
- 墨夜改为真正的低光深色稿纸，并加入正文/弱文字在 surface 与 paper 上的 4.5:1 对比度契约。
- 分析清理只忽略明确缺失路径；Python 调试服务补齐 `/fs` 删除、64 MiB 请求上限与 CSP，恶意导入元数据按文本渲染。
- Rust 迁移持有独占 vault guard；DPAPI 密钥替换具备失败回滚与中断备份恢复；资料和分析状态加入 live region。

- 统一柔纸、墨夜与青简三套语义视觉 Token，移除运行时字体依赖并完善焦点、动效与状态反馈。
- 重构 52px 单行顶栏、写作/故事/资料/分析四入口、300px 书库抽屉与响应式章节/检查器抽屉。
- 新增叙事脉络条、统一 AI Composer、四阶段生成进度，以及结构化任务、连续性、故事记忆和上下文健康检查器。
- 叙事脉络条固定显示上下文健康；章节头独立呈现保存与交接状态；Composer 补齐“根据批注修订”，修订失败或停止不覆盖原稿；故事记忆可直达故事中心，分析进度统一为作者语言。
- 重组故事中心、资料工作区、设置与分析层级，补齐窄屏任务卡、首次路径、错误状态和键盘快捷键。
- 引入 UI schema v3 迁移、前端结构契约测试、三套 UI 同步门禁与桌面 Release 校验。

## 0.9.0 — 无状态长篇一致性闭环

- Canon 改为类型化数值/单位比较，修复 `5级/15级`、`50万/150万` 的 substring 误判；支持显式动态事实历史。
- 独立 `plotLoops` 生命周期账本：开启、推进、延后、回收、放弃、重开，不再受 40 章摘要窗口限制。
- 连续性警告真正回流下一章，可由作者标记已处理/忽略。
- 长章摘要和关系抽取采用头部+中段+章末取样，保留最终状态与钩子。
- 普通生成默认自动完成章后交接；手工编辑明确标记记忆过期。
- 写前装配同时限制字符和估算 token，为核心块保留最低空间并记录 manifest。
- Canon 按任务实体、POV 与节拍相关性选择；新增多实体状态、时间线与风格圣经。
- 写后连续性审查输出带证据的分级问题；可选唯一命中局部修订、原稿快照和一次复检。
- embeddings 候选池扩展到权威记忆和相邻正文，并对最终 Top-K 做类型多样化。
- 新增连续性侧车文件、旧书迁移、可选真实 Gemini 多章评测框架和完整回归测试。

## 0.8.0 — 稳定化与可恢复发布

- 统一章节写入权威，保护外部新增与较新修改。
- 长篇保存提升至 64 MiB，RAG 运行时与 `book.json` 分离并使用内容签名。
- 叙事分析支持原子检查点、跨重启续跑与源变更拒绝。
- Release 设置迁移到用户目录，修复并发写、symlink 越界、Markdown 原始 HTML 与 CSP。
- 完整 UI 清单、版本门禁、全量测试和发布哈希清单。

## 0.7.1 — 配置磁盘持久化 + 侧栏折叠

- **API Key / 主题 / 模型等**：除 localStorage 外写入 `mogao-settings.json`（`PUT /api/settings` 的 `clientCfg`）；启动时以磁盘为准恢复
- **侧栏可折叠**：书库、工作区文件树、写章左右栏、主线/策划/图谱/分析侧栏；状态写入 `uiState` 并持久化
- 关闭设置立即 `persistCfg(true)`，避免杀进程丢 key

## 0.7.0 — 本地混合 RAG + 写章 Harness

调研对齐 2024–2025 长篇/Agent 实践后落地：

**RAG（`rag.js`）**
- 分层语料：canon / 故事线 / digest / 人物卡 / 世界观 / 章正文块 / 出场
- 混合检索：中英 BM25 + 类型/近章/实体加权
- 多查询分解（任务 goal/beats/钩子/实体）
- 可选反代 `/v1/embeddings` 向量重排（失败回退 BM25）
- 索引：`project.ragIndex` → `记忆/rag-index.json`

**Harness（`harness.js`）**
- 流水线：`Retrieve → Write → Handoff(摘要+设定+故事线) → Graph → Reindex`
- `autoChapterCycle` 默认走 harness
- 设置页：开关 Harness/RAG/向量重排、Top-K、重建索引

**装配**
- `packForWrite` 注入【RAG检索】硬块；与 canon/故事线同为 keep 优先级

## 0.6.0 — 故事线 + 细节设定文档（canon）

按「出场任务 / 背景细节文档 / 章后交接」落地：

- **故事线 `storyline`**：每章摘要后记录位置、本章概要、下一推进方向、近线轨迹；写前注入【故事线位置】
- **细节设定 `detailCanon`**：从正文提取 `实体.属性=值`（如 `王大锤.粉丝数=50万`），**锁定后冲突拒改**；写前注入【细节设定文档】
- **出场记录 `appearanceLog`**：人物/地点/道具/势力
- 章后一次 JSON 交接（摘要+canon+故事线+出场），不另增反代调用
- 落盘：`记忆/canon.json`、`storyline.json`、`appearances.json`、`细节设定.md`
- 主线侧栏展示故事线与锁定细节

## 0.5.0 — 跨章连贯性（gemini 连写）

写章不再「只看任务卡 + 极短摘要」，避免第 N+1 章重演第 N 章高潮、遗忘设定。

- **写前上下文** `context.packForWrite`：
  - 【故事进度】已写章/任务线/上一任务钩子/下一任务预告
  - 【当前故事状态】storyState（事实、未收回钩子、能力阶段、地点时间）
  - 【上章文末衔接】上一已写章正文尾（默认 1800 字）——修复「新章完全看不到上章」
  - 富字段滚动摘要 + 独立钩子清单 + 伏笔账 + 连贯性纪律
- **章后摘要** `chapterDigest`：must_carry / power_or_system / location / timeline / ending_hook_status
- **storyState** 每章 digest 后确定性合并（不额外耗反代额度）
- 默认上下文预算 14000；可配置上章衔接字数、摘要条数
- 控制台记忆区展示故事状态

## 0.4.1 — A1–A5 正确性

- **A1** 工作区章节 merge 失败时不 PUT 整本 book（只写文件，避免旧 body 盖 md）
- **A2** boot 空库迁入与按钮迁入同一 slim 过滤
- **A3** `context.mergeGraph` 统一委托 `NOVEL_NARRATIVE.mergeGraphs`（边键含 chapter）
- **A4** 分析 extractions 按 `chunk_id` / 序号命名，禁止塌成 `x.json`
- **A5** Python `server.py` / `desktop.py` / `start*.bat` 标明 **DEBUG ONLY**；正式用 **Inkwell.exe**
- 产品英文名 **Inkwell**（中文 墨稿）

## 0.4.0 — 创作 + 叙事分析 V1

- 叙事：切章 / 分块 / 分析 runner / 分析模式 UI / 图谱筛选·档案·时间线
- 写权威：auto 全程锁、flush merge、迁入 slim 防护
- 正式客户端：`mogao-tauri/release/Inkwell.exe`

## 清理 — 移除 Python 版 exe

- 删除 `release/墨稿.exe`、`build-exe.bat`、`mogao.spec`、`requirements-build.txt`、`dist/`、`build/`、`.venv-build/`
- 正式客户端请用 `mogao-tauri/release/Inkwell.exe`
- 本目录 Python 服务仅 DEBUG ONLY

## 0.3.0 — 类 Obsidian 工作区

- 新默认页 **「工作区」**：文件树 + 源码编辑 + Markdown 预览分栏
- API：`/tree` `/file` `/watch`；章节 md 保存同步进 `book.json`
- 约 2.5s 轮询磁盘变更，外部修改自动刷新树/重载未脏文件
- 分栏模式：仅编辑 / 分栏 / 仅预览
- 桌面客户端默认进入工作区；Ctrl+S 保存当前文件
- 版本 **0.3.0**

## 0.2.1 — 审查修复 Goal

### 防丢稿 / 防串章
- 生成中 **锁定切章/切书**；流式 paint 按 `writingChapterId`，与 UI 选中解耦
- 自动连写状态机：`written` 重入 **跳过写章** 只补摘要/关系，避免叠正文
- 单章失败停止连写并保留状态，可续跑

### 策划保护
- 重跑主线/全策划 **合并任务板**，保留 done/written/digested 进度
- 操作前确认风险

### 表单与存盘
- 锁定主线/禁区等进入通用 `syncEditorToProject`
- 系统 `save` 不再误标「未存盘」
- 重载强制确认；外部修改取消不吞掉后续提醒（`dismissedMtime`）
- 导出拆分：开文件夹 / 下载 md / 两者
- 设置点遮罩不静默保存

### 其它
- 启动按需加载当前书（其余 stub）
- 服务版本协商提示
- 单实例 MessageBox 提示
- 窄屏保留书库栏

## 0.2.0 — 成熟化 Goal

### 可靠写盘
- 章节 **先写后删孤儿**，消除「先清空再写」丢稿窗口
- 全路径 **原子写**（tmp + replace）
- 自动/手动 **历史快照**（`.history/`，默认保留 20 份）
- 快照恢复 API

### 桌面客户端
- **单实例锁**（`vault/.desktop.lock`）
- 关窗 `confirm_close` + 前端同步 flush 钩子
- 版本号展示

### 书库 UX
- 左侧 **书库侧栏**（切换 / 打开目录 / 重命名 / 删除）
- 脏标记与存盘状态
- **Ctrl+S** 立即存盘；**Ctrl+1..4** 切模式
- 窗口聚焦时检测外部 mtime 变更并提示重载

### 工程
- `tests/test_vault.py`、`scripts/smoke.py`
- 已归档的 `docs/history/MATURITY.md` 方案与验收清单
- `library.js` 模块

## 0.1.0

- 本地 vault 书库、Obsidian 友好章节 md
- pywebview 桌面窗
- 策划 / 主线 / 写章 / 关系流水线
- 打开目录聚焦修复
