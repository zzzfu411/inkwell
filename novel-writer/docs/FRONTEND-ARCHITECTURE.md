# Inkwell 前端架构边界

`index.html` 只定义可访问的页面结构与加载顺序；`styles.css` 只使用顶部声明的语义色彩、阴影和尺寸 token。业务模块通过 `window.NOVEL_*` 暴露窄接口，避免构建链依赖，也让 Tauri 内嵌 UI 与 Python 调试 UI 使用同一份源码。

| 模块 | 单一职责 | 不应承担 |
|---|---|---|
| `api.js` | OpenAI-compatible 请求、SSE、重试、输出限长 | 小说状态与 DOM |
| `context.js` / `rag.js` | 上下文门面与检索 | 保存、弹窗与导航 |
| `context-evidence.js` / `context-budget.js` / `memory-reducers.js` | 证据筛选、预算分配、记忆归并 | DOM、网络与存储 |
| `pipeline.js` | 策划、生成、交接服务的稳定薄门面 | 具体算法、页面布局 |
| `planning-service.js` / `handoff-service.js` / `legacy-generation-adapter.js` | 策划、章后交接、旧 Harness 兼容 | DOM 与页面状态 |
| `chapter-drafting-service.js` / `production-quality.js` | 原子整章起草、确定性质量信号与放行规则 | DOM、网络实现、存储与隐式全局阈值 |
| `write-use-cases.js` | 生成、续写、改写、交接、修复的取消与事务顺序 | DOM、网络实现与存储实现 |
| `persistence-use-cases.js` | 保存队列、表单同步、工作区正文归并、导出模型 | DOM、XHR 与 localStorage |
| `conflict-use-cases.js` | 冲突队列、恢复、裁决与重载协调 | DOM、XHR 与 localStorage |
| `harness.js` | 旧写章闭环的兼容实现 | 页面布局 |
| `vault.js` / `store.js` | 磁盘协议、恢复缓存、纯合并 | 具体视图渲染 |
| `workspace.js` | 资料文件树、编辑/预览、窄窗抽屉 | 写章状态机 |
| `ui-shell.js` | UI 状态迁移与纯展示分类器 | 网络或持久化 |
| `vault-ui.js` / `analyze-ui.js` | 各自功能域的交互控制 | 全局业务状态 |
| `graph-view.js` | 关系星图布局与渲染 | 选中态与书库事务 |
| `graph-panel.js` | 关系图取数：子图收缩、章节排序、关系表 | DOM 与选中态存储 |
| `story-records.js` | Canon / 伏笔 / 连续性的筛选、排序、统计 | DOM 与存盘 |
| `composer-review.js` | 生成结果快照与撤销闸 | DOM 与存盘 |
| `write-ui.js` | 写章欢迎页、章节列表、页头、质量与检查器的 Presentation Model | 写章网络与存盘 |
| `craft.js` | 细纲、开场轮换、套话检查、交接闸 | 网络请求与 DOM |
| `quality-release-policy.js` | 默认引擎决策的 fail-closed 纯策略 | 读取报告文件、网络、DOM 或自行声明通过 |
| `composition-contract.js` | 47 个 classic scripts 的 providers/requires/deferred/external 合同与启动前校验 | 业务状态、网络或 DOM 渲染 |
| `app.js` | 模块装配、DOM ports、跨域事务入口 | 新增可独立测试的算法或状态队列 |

新增逻辑时，能写成纯函数的内容应进入对应模块并由 `tests/*.mjs` 直接验证；只有跨模块事务留在 `app.js`。`tests/test_frontend_contract.mjs` 会断言 `story-records.js` / `graph-panel.js` / `composer-review.js` 不含任何 DOM 调用，也会拦住把这些算法抄回 `app.js`。`tests/test_composition_contract.mjs` 从源码提取所有 `window.NOVEL_*` provider/reference，要求每个引用显式分类，拒绝重复 provider、eager 逆序、未知依赖与 `index.html` 漂移；`app.js` 在 boot 前后各执行一次运行时断言。所有正式 UI 资产必须登记在 `../mogao-tauri/ui-files.txt`，再由 `scripts/sync-ui.ps1` 同步，禁止直接修改 `release/ui` 或 `src-tauri/ui-embed`。

覆盖率门不把适配器或展示模型当作分母填充。`scripts/domain-coverage.ps1` 显式列出状态、生产质量、质量发布策略、上下文预算、记忆归并和文本计量组成的纯领域内核，执行全部 Node 行为测试后要求聚合 statements ≥80%、branches ≥75%；Phase 8 基线为 statements 96.66%、branches 79.56%，其中质量发布策略为 100%/98.14%。其余 DOM-free 应用用例继续由全量行为测试和架构边界测试约束。

应用用例以 `create(deps)` 装配，依赖只能通过 ports 注入。用例模块不得直接引用 `document`/`window`、`fetch`/XHR 或 localStorage；`app.js` 负责把当前闭包状态、Vault、Store、Pipeline 和 DOM 渲染器适配为窄端口。写作运行的锁不是布尔值的无主开关，而是绑定 `runToken` 的租约：被后继运行 abort 的旧用例即使晚到 `finally`，也无权解开后继运行仍持有的锁。

编辑器热路径的两条约定，同样由契约测试锁住：

- `craftScore` 打分要扫全章正文，只能防抖执行；`syncEditorToProject()` 会在存盘和生成前 `flushCraftRescore()`，磁盘上的分数不允许落后于正文。防抖回调只重画提示条，不重建细纲列表（列表里有作者正在编辑的输入框）。
- `Ctx.packForWrite` 只允许从 `packWriteContext()` 这一个入口调用，按签名缓存一份；任何改动都会经 `markDirty()` → `bumpProjectRevision()` 作废缓存，避免上下文计量表说谎。
- 列表类面板（伏笔、连续性、人物）的按钮走 `bindDelegatedPanelActions()` 事件委托，禁止在每次重画时重新挂监听。

章节保存的乐观并发有一条容易漏掉的约定：**保存自己也会改变磁盘 mtime**。因此每次保存成功后，`Vault.adoptChapterBaselines()` 必须把每章的 `_file` / `_fileMtime` 换成服务端刚写盘的值（`chapterBaselines`，Python 与 Rust 后端都回传），否则同一次会话里第二次改同一章就会撞上自己刚写的文件，弹出并不存在的「磁盘版本保护」。冲突章与被保留的磁盘章例外：它们的磁盘版本还等着作者裁决，换了基线下一次保存就会静默覆盖。契约测试断言两条异步保存路径都调用了它。关窗同步 PUT（`__mogaoFlushSync`）同样必须 adopt，否则窗口没关上再改同一章也会假冲突。导入示例、导出「打开文件夹」不得直接 `Vault.saveBook`，必须走 `flushToDisk` / `flushProject`，以便 adopt 并进入 `diskSavePromise` 串行锁。

磁盘与内存的替换权。`state.projects[]` 是作者正在写的工程；`vault/books/<slug>/` 是可重建的落盘副本，不是可以随时盖掉内存的权威。任何用磁盘书对象替换 `state.projects[i]` 的调用点，必须先通过 `Vault.classifyDiskAdopt(flags)`，或走作者确认过的 `replaceMemoryWithDisk(p, fresh, { intent: "discard" })`。

静默采纳（`intent: "silent"`）当且仅当：未在生成、该书无待裁决冲突、该书无未确认落盘改动（`p._dirty`、全局 `dirty` 在该书为活动书时、写章台正文与 `ch.body` 不一致、资料区脏的章节文件、进行中的 `flushToDisk` 都算）、且调用方已经 `syncEditorToProject()`。闸门失败时必须保留内存稿；禁止 `loadWriteView()` 用磁盘 `ch.body` 灌编辑器。

资料区与写章台同时改同一 `章节/*.md` 时，任何一侧都不得静默覆盖另一侧；资料区写入成功后若写章台仍持有不同正文，必须把双版本推进现有保存冲突队列。

待裁决期间：允许刷新 `entry.diskChapter`；禁止用 `findConflictLocalChapter(p, entry)` 的结果覆盖 `entry.localChapter`；禁止对该书整本 `projects[i] = fresh`（整本明确丢弃除外，丢弃时必须清空该书冲突）。

作者选择「丢掉内存、用磁盘」时，必须同时：替换工程对象、清 `p._dirty` 与按全集重算的全局 `dirty`、`Store.clearRecovery`、清空该书冲突、采用磁盘 `_fileMtime`、刷新编辑器与资料区打开文件。只改全局 `dirty = false` 不算完成。

恢复副本按章与磁盘章比较 `updatedAt` 和 body，不得用 `book.json` 的 `_mtime`/`updatedAt` 宣布整本恢复过期。`markClean` 与明确丢弃才是删除恢复 key 的入口。

切离写章台才允许整本 PUT：`switchMode` 必须看到 `bootDone`（HTML 默认 `view-write.active` 不是用户离开）、以及未保存状态（模块 `dirty`、`project()._dirty`、待触发的 `diskTimer`）。干净切页只 `saveAll`，必要时等待已在飞的 `diskSavePromise`，不得新开 PUT。`++switchEpoch` 只能发生在 `guardGen` 与工作区确认取消之后，避免一次被拦住的点击作废仍在冲刷的合法切换。`syncEditorToProject` 读入的控件必须有标脏链：`PROJECT_FORM_FIELDS`（`input`+`change` 标脏，`blur` 立即落盘；复选框两个事件都要听）加上正文/细纲的专用路径。回写本身在**值确实变化**时 `markDirty()`（图谱与数组走结构化比较，忽略 JSON 空白），这样漏监听也不会在离开写章台时被脏闸门挡住；无变化不得假脏，否则干净切页又变回无条件 PUT。`stylePacing` 只表示节奏、`styleDialogue` 只表示对白；加载时用 `recoverConcatenatedStylePacing` 剥掉历史上拼进 `pacing` 的 `；dialogue` 后缀，禁止再把两字段 join 进同一个输入框。交接 / 纠偏 / 局部修复必须在 await 前 `setGenLock`，分析写入 `p.graph` 后必须立刻 `markDirty`，让静默采纳闸门在落盘完成前就能拦住覆盖。`withAbort` 每次运行取令牌，`finally` 与 AbortError 状态回写只有当前持有者才能执行，避免被顶替的先行者解开后继者的锁、清掉 `abortCtrl`、或把状态栏写成「已停止」。

`ui-shell.js` 继续只放纯 UI 分类器，不读 vault、不写 localStorage。闸门纯函数放 `vault.js`；读 DOM/闭包采集 flags 与执行替换放 `app.js`。

响应式断点契约：写章左右栏分别在 1050px/1200px 以下变为抽屉；资料文件树在 760px 以下变为带遮罩的抽屉。抽屉关闭时必须同时设置 `inert` 与 `aria-hidden`，并提供 Esc、遮罩点击和焦点恢复。

安全边界：API Key 不进入 localStorage、书稿、恢复缓存或设置 JSON。正式 Windows 客户端仅通过 Rust 设置层的 DPAPI 密文持久化；Python 服务仅用于本机调试。
