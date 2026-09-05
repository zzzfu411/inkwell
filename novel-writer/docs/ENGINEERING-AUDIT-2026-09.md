# Inkwell 软件工程审计与重构执行计划

审计日期：2026-09-04  
范围：`novel-writer/`（唯一前端源与 Python 调试后端）+ `mogao-tauri/`（正式 Rust/Tauri 客户端、UI 镜像与发布链）

## 1. 结论

项目已经不是“缺功能的原型”：本地书库、原子写盘、冲突保护、快照、上下文/RAG、叙事生产引擎、Rust/Python/Node/浏览器回归都已存在。当前主要风险是**职责和持久化状态继续堆在少数巨型文件里，而正文又有多个写入入口**。这会让新增的文章质量能力在编辑、重载或冲突合并后失去不变量，表现为“流程看似完成，实际评分对应的是旧正文”。

因此不建议重写 UI 框架，也不建议继续靠增加 prompt 修补。正确路线是：

1. 先建立正文、质量报告、任务和交接之间的领域不变量；
2. 再按用例拆开 UI 控制、生成编排、持久化和冲突处理；
3. 用统一 schema、后端契约和真实模型 A/B 评测约束演进；
4. 最后收口发布目录与 CI，使“测试通过的源”和“交付的 exe”可证明一致。

Phase 0–7 的工程交付现已全部关闭：领域状态/schema、应用用例拆分、双后端核心存储合同、文章质量 A/B 发布门、静态/覆盖率/托管 CI、不可变发布事务，以及脱敏观测/性能预算/文档导航均已有可执行边界。Rust/Python 共同执行 HTTP contract v1；文章候选链使用固定 6×8 corpus、96 份可审计工件和 48 组盲评对。当前真实发布结论仍是 `hold`，而不是用 fixture 或引擎自评伪造“效果提升”，所以新安装仍默认旧 Harness。

Phase 8 现已关闭上一轮验收后暴露的剩余风险：质量报告同时绑定 corpus 与 27 个质量关键源码，默认引擎提升由 schema-v2 fail-closed 决策、promotion bundle 和 CI verifier 共同约束，47 个 classic scripts 也已有完整的全局依赖分类与启动前后校验。真实文章质量没有付费盲评证据，发布结论仍诚实保持 `hold`；这与工程阶段完成并不矛盾。Phase 0–8 的当前实现均已通过同构 CI。唯一架构入口见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，运行诊断合同见 [`OBSERVABILITY.md`](./OBSERVABILITY.md)，性能门见 [`PERFORMANCE-BUDGET.md`](./PERFORMANCE-BUDGET.md)。

## 2. 事实基线

### 2.1 当前拓扑

```text
index.html（显式清单约束的 IIFE 脚本装配顺序）
  ├─ project-migrations.js / chapter-state.js / production-state.js（纯领域边界）
  └─ app.js（页面装配 + DOM 端口 + 跨域事务入口）
       ├─ write/persistence/conflict-use-cases.js（应用用例）
       ├─ pipeline.js（薄编排门面）
       │    ├─ planning-service.js / handoff-service.js
       │    └─ legacy-generation-adapter.js
       ├─ production-engine.js + chapter-drafting-service.js + production-quality.js（编排、原子整章起草、纯质量闸门）
       ├─ context.js（上下文门面）
       │    ├─ context-evidence.js / context-budget.js / memory-reducers.js
       │    └─ rag.js / craft.js（检索、本地指标）
       ├─ store.js（localStorage 缓存/恢复）
       └─ vault.js → localhost HTTP
                         ├─ Rust/Tauri（正式、带会话 token）
                         └─ Python server.py（DEBUG ONLY、语义可能滞后）
```

正式源是 `novel-writer/`。canonical manifest 现有 53 个 UI 文件，日常同步只原子镜像到 `mogao-tauri/src-tauri/ui-embed/`；`release/ui/` 只会在完整发布 stage 内从 canonical 复制，普通同步和源码 CI 均不再写入或拿它与当前源码比较。当前本地 development release 仍是 Phase 6 生成的 49 项 UI/schema v4 产物，自带 manifest checksum 并明确记录双仓 `dirty=true`。Phase 8 日常同步未触碰该 release；standalone 复核仍通过 schema v4、双 EXE 和全部 49 个 UI hash，manifest SHA-256 保持 `e368e04288cfd5c50a707c0f2fb41dc176ec4358b697affee59d42b8cf75a75b`。

### 2.2 规模与耦合信号

| 文件 | 当前约行数 | 当前字节数 | 主要职责 |
|---|---:|---:|---|
| `app.js` | 4,484 | 172,559 | 页面装配、DOM 端口、跨域事务入口与组合根前后断言 |
| `server.py` | 2,212 | 82,097 | 调试 HTTP、书库、文件镜像、快照、迁移 |
| `context.js` | 1,294 | 52,932 | 上下文门面、兼容 API 与观测接线 |
| `pipeline.js` | 269 | 7,107 | 策划、生成、交接服务的薄门面 |
| `workspace.js` | 1,374 | 49,349 | 文件树、编辑器、预览、快照、外部变更 |
| `production-engine.js` | 1,226 | 52,265 | 新生成状态机与质量编排（确定性规则已抽离） |
| `production-quality.js` | 270 | 12,030 | 纯质量信号、归一化和放行规则 |
| `runtime-observability.js` | 511 | 20,145 | 纯错误分类、脱敏 envelope、指标白名单与报告 |
| `runtime-diagnostics-ui.js` | 128 | 4,768 | 错误展示和本地诊断下载适配器 |
| `quality-release-policy.js` | 98 | 3,900 | 默认引擎决策的 fail-closed 纯策略 |
| `composition-contract.js` | 259 | 9,338 | 47 个 classic scripts 的显式依赖与启动合同 |

行数不是质量指标。Phase 2 已将原本集中于 `app.js`、`pipeline.js`、`context.js` 的可独立职责拆到窄接口模块，并用架构测试同时约束行数与字节数，避免仅压缩排版绕过债务上限。Phase 5 又把质量信号与放行规则从 production 编排器抽离，将其债务上限由 1,400/65KB 下调到 1,250/54KB。浏览器端仍不引入模块构建器，继续依靠 `window.NOVEL_*` 与 `index.html` 显式顺序；ESLint correctness、领域覆盖率和两个仓库的 Windows workflow 已将该装配方式变成可执行合同。

### 2.3 数据权威面

同一章正文可能同时存在于：

- `chapter.body` 内存对象；
- 写章台 `<textarea>`；
- 工作区 Markdown 编辑器；
- `章节/*.md`；
- `book.json`；
- localStorage slim 缓存；
- localStorage recovery 副本；
- 保存冲突的 local/disk 快照。

这不是天然错误，但必须有一个统一的“载入/替换正文”领域操作。此前各入口只各自更新部分字段，导致质量状态、任务状态和交接状态可以互相矛盾。

## 3. 问题清单

### P0：正确性与数据语义

| ID | 问题 | 证据与影响 | 状态 |
|---|---|---|---|
| P0-01 | 正文变更后旧质量报告可继续有效 | 工作区 Markdown、磁盘重载和冲突裁决可以替换 `chapter.body`，却没有统一核对 `production.bodySig`；一个旧 `done` 章节可绕过质量复检进入交接 | **Phase 0 已关闭** |
| P0-02 | 缺少全书 schema 与幂等迁移注册表 | `book.json` 是宽松 JSON；新增字段主要靠读取时兜底。Rust、Python、localStorage 和前端都可能解释同一旧数据，无法证明迁移顺序、幂等性和回滚兼容 | **Phase 1 已关闭** |
| P0-03 | 三套状态机没有单一转换器 | `task.status`、`chapter.production.status/stage`、`handoffStatus` 在多个文件直接写字符串；可出现 task=`done`、production=`needs_revision`、handoff=`done` 的非法组合 | **Phase 1 已关闭** |
| P0-04 | 正文权威与保存事务分散 | 工作区保存会触发重载，整本保存又尝试 merge；冲突、恢复、静默重载各有一套条件。路径一多，任何新入口都可能漏掉恢复、签名或 dirty 规则 | **Phase 2 已用例化并补浏览器回归** |
| P0-05 | 质量通过报告未绑定实际生成源码 | `run.json` 只记录 corpus/protocol/model；prompt、上下文编译器、Harness、候选引擎或 gate 改动后，旧 live 报告仍可能继续满足现有 gate | **Phase 8A/8D 已关闭** |

### P1：可维护性、测试可信度与发布

| ID | 问题 | 证据与影响 |
|---|---|---|
| P1-01 | 巨型控制器持续增长 | **Phase 2 已建立拆分边界和双重债务上限**；`app.js`/`workspace.js` 仍是存量 presentation 债务，Phase 8 不以机械压行数替代职责审计 |
| P1-02 | 全局依赖与加载顺序隐式 | `window.NOVEL_*` 的关键顺序已有局部断言，但没有完整 provides/requires 合同或启动前 fail-fast；可选依赖和真正缺失依赖仍难区分 | **Phase 8C/8D 已关闭** |
| P1-03 | 正式 Rust 与调试 Python 的 API 语义可能漂移 | **Phase 3 已关闭**：共享 v1 fixture、错误 code、并发 warning/baseline 与正式 Rust 浏览器 E2E 已进入本地 CI；有意差异和 Python 0.20.x 截止策略已文档化 |
| P1-04 | release 不是不可变产物 | **Phase 6 已关闭**：embed-only 日常同步、隔离 stage、schema v4 manifest checksum、精确文件集、源码 provenance、原子发布/回滚和 standalone 校验均已执行验证 |
| P1-05 | 质量门禁覆盖面不完整 | **Phase 5 已关闭**：固定 ESLint correctness、领域覆盖率阈值、双仓 Windows workflow、真实模块/正式后端 E2E 与失败工件留存 |
| P1-06 | 默认引擎提升缺少通用证据引用合同 | 当前测试直接断言 `hold/false`；未来可通过同时修改代码和断言绕过真实报告，且 `evaluatedReport` 没有可机器验证的 report/source digest | **Phase 8B/8D 已关闭** |

### P2：长期演进能力

| ID | 问题 | 影响 |
|---|---|---|
| P2-01 | 错误分类和观测数据分散 | **Phase 7 已关闭**：八类闭合枚举、失败 envelope、四类运行指标和脱敏本地导出已接入 |
| P2-02 | 没有可执行性能预算 | **Phase 7 已关闭**：20/100/400 章 fixture 对上下文、保存序列化、Markdown、诊断导出与体积执行 median/p95 门限 |
| P2-03 | 规划文档存在历史口径 | **Phase 7 已关闭**：17 份旧路线/GOAL 归档到 `docs/history/`，双 README 的三个链接由测试锁定 |
| P2-04 | 文章质量缺少发布级实验门 | **Phase 4 已关闭工程缺口**：固定 corpus、A/B 工件、独立 judge、人工盲评和发布阈值均可执行；未完成的真实付费证据明确保持 `hold` |

## 4. 根因

1. **领域状态没有先于 UI 功能建模。** 正文编辑、质量验收和交接是同一个聚合事务，却被分散到事件处理器、流水线和存储适配器。
2. **以文件而不是用例划边界。** `app.js` 变成所有 UI 行为的默认落点；`pipeline.js` 变成所有生成行为的默认落点。
3. **兼容层没有退出策略。** Harness、新 Production Engine、Rust、Python 都保留，但缺少“谁是唯一权威、兼容到何时”的契约。
4. **测试偏重回归数量，缺少架构和产物证明。** 当前测试能抓很多具体 bug，但不能自动阻止巨石增长、状态字符串复制或 release 漂移。

## 5. 目标架构

采用渐进式端口/适配器结构，继续使用当前静态 JS，不做 React/TypeScript 大爆炸重写：

```text
Presentation
  write-controller / workspace-controller / conflict-controller
        │ 只收 DOM 事件，渲染 ViewModel
        ▼
Application use cases
  GenerateChapter / EditChapterBody / ReloadBook / ResolveConflict / HandoffChapter
        │ 负责事务顺序、取消、checkpoint
        ▼
Domain（纯函数、无 DOM/网络/存储）
  Book/Chapter invariants
  ProductionStateMachine
  ContextCompiler
  QualityPolicy
        │ ports
        ▼
Adapters
  ModelGateway(api.js) / VaultRepository(vault.js) / Cache(store.js)
  Rust HTTP（正式）/ Python HTTP（仅契约兼容调试）
```

### 5.1 必须成立的不变量

1. 每一份被接受的质量报告都绑定一个 `bodyRevision/bodySig`；正文变化立即作废报告。
2. strict 策略下，只有“本事务刚验收通过”或“持久化签名仍匹配”的正文可交接。
3. `task.status` 不再独立决定真实状态；它由 production/handoff 状态映射，或只能通过同一 transition API 修改。
4. 完整正文的持久化权威是 Vault；localStorage 只做有界恢复，空 slim body 永不参与正文一致性判断。
5. 所有后端都通过同一组 JSON contract fixtures；Rust 是正式语义，Python 只能兼容或删除，不能自行演化。
6. release 只能由一次带源哈希的构建产生，日常开发同步不得修改已命名的 release 目录。

### 5.2 收敛后的状态模型

```text
draft/pending
   → generating
   → reviewing
      ├─ revision_required → revising → reviewing
      └─ accepted → handoff_pending → handing_off → done

任意 accepted/done + bodySig mismatch
   → revision_required（清除旧 gate/review，handoff=stale）
```

暂停、失败和取消是带 `lastStableState` 的运行结果，不应伪装成新的业务终态。

## 6. 详细执行计划

### Phase 0 — 封住状态与正文一致性（已完成，P0）

交付：

- 新增纯领域模块 `production-state.js`；
- 统一 body signature、质量阻断、报告失效、项目恢复核对、交接准入；
- 接入 localStorage 恢复、Vault load/reload、工作区 Markdown 合并、冲突裁决、编辑器和最终 handoff；
- 旧书无 `production` 时不强迁；早期 v1 已完成记录无签名时只建立基线；slim 空正文等待 Vault hydrate；
- 增加状态迁移、磁盘正文变化、最终交接兜底和架构边界测试。

验收：

- 已验收正文签名匹配时状态不变；
- 任一入口替换正文后，strict 模式均不能带旧报告交接；
- 对应任务回退为 `needs_revision`；
- 兼容 `warn` 和旧章节的行为明确且有测；
- 全量 Rust/Node/Python/浏览器/视觉回归通过。

### Phase 1 — schema 与唯一状态转换器（已完成，P0）

交付：

- 在 `book.json` 根增加 `schemaVersion`，在 production 增加独立 `schemaVersion`；
- 新建 `project-migrations.js`，使用 `vN → vN+1` 幂等迁移，禁止散落的“读时顺手补字段”；
- 新建 `chapter-state.js`，暴露 `startGeneration/accept/requestRevision/startHandoff/completeHandoff/fail`；
- 写入前校验非法组合，读取时迁移并保留迁移审计；
- 用旧书、空书、中断场面、外部改稿、恢复副本建立 golden fixtures。

验收：迁移执行两次结果相同；所有历史 fixture 能读；未知更高版本只读保护；源码中业务状态的直接赋值数量降到白名单内。

完成证据：

- `project-migrations.js` 提供相邻、幂等迁移和根/production 双版本审计；
- `chapter-state.js` 提供显式合法转换表，运行时状态写入已从 app/pipeline/harness/production/composer 撤销路径清除；
- strict 交接现在要求真正的 validated 状态，不能把 `pending` 当作“未阻断即通过”；
- 连续性自动修订移到 Semantic Critic 之前，防止验收后改稿；
- 七类 fixture 覆盖旧书、空书、中断场面、外部改稿、恢复副本、当前版和未来版；
- 保存、批量迁入、关窗同步、工作区与快照恢复均有未来 schema 写保护。

### Phase 2 — 按用例拆控制器与编排器（已完成，P1）

交付：

- 从 `app.js` 抽出 `write-use-cases.js`、`persistence-use-cases.js`、`conflict-use-cases.js`；
- 从 `pipeline.js` 分出 `planning-service.js`、`handoff-service.js`、`legacy-generation-adapter.js`；
- 从 `context.js` 分出 evidence selectors、budget allocator、memory reducers；
- controller 只持有页面局部状态，通过显式 `deps` 注入端口；
- 先保持 IIFE 兼容，接口稳定后再评估原生 ES modules。

验收：`app.js < 4,500` 行、`pipeline.js < 1,400` 行、`context.js < 1,500` 行；抽出的每个模块无 DOM 且有独立行为测试；现有 UI 不改变。

完成证据：

- `app.js` 4,495 行 / 173,432 字节，`pipeline.js` 271 行 / 7,050 字节，`context.js` 1,255 行 / 51,560 字节；双重债务上限由 `test_architecture_boundaries.mjs` 执行；
- 写作、持久化和冲突队列分别由 `write-use-cases.js`、`persistence-use-cases.js`、`conflict-use-cases.js` 持有事务顺序，DOM、XHR 与 localStorage 仅作为显式 ports 注入；
- 策划、交接和旧 Harness 适配分别落入 `planning-service.js`、`handoff-service.js`、`legacy-generation-adapter.js`；`pipeline.js` 只保留稳定门面；
- 证据选择、预算分配和记忆归并分别落入 `context-evidence.js`、`context-budget.js`、`memory-reducers.js`；
- 展示模型与安全 HTML 构造下沉到 `write-ui.js`、`story-records.js`、`graph-panel.js`、`library.js`，直接测试覆盖转义、排序、状态映射和表单幂等；
- 抢占中的生成/交接/修复使用带运行令牌的锁租约，旧任务的 `finally` 不得释放后继任务的锁；直接测试与两条真实浏览器回归共同锁住该不变量；
- Node 53/53、浏览器 49/49、视觉 1/1 通过，46 个 canonical/embed/release UI 文件在本阶段仍保持字节一致。

### Phase 3 — 后端契约统一（已完成，P1）

交付：

- 为 health/library/book load/save/reload/file/watch/conflict 建立共享请求响应 fixture；
- Rust 跑正式 contract suite；Python 跑相同 fixture，差异必须显式列入 debug compatibility 表；
- 至少一条浏览器 E2E 启动 Rust HTTP 服务，覆盖“加载→编辑→保存→外部改稿→冲突→恢复”；
- 决定 Python 后端的截止版本：只保留静态调试代理，或按 Rust contract 生成兼容层。

验收：关键 API 在 Rust/Python 的状态码、警告、并发基线和错误 code 一致；正式后端 E2E 进入 CI。

完成证据：

- `tests/fixtures/http-contract/v1.json` 是唯一共享请求/响应 fixture，`backend-contract-runner.mjs` 对 Python 与 Rust 两个真实进程执行同一场景；
- health/library/create/load/save/reload/file/watch/delete 的状态和字段统一；普通失败统一为 `ok:false + error.code/message/status`；
- 两端都验证重复保存不制造假冲突，陈旧 `_fileMtime` 必须返回 `externalConflict`、保留磁盘正文并回传新 `chapterBaselines`；
- 新增 `inkwell-http` 无窗口入口，直接复用桌面端 `http_api::start_server`，不维护第二套路由；
- `rust-backend.spec.mjs` 在真实正式后端完成“加载→编辑→保存→外部改稿→冲突→采用磁盘→重载恢复”，并已接入 `scripts/ci.ps1`；
- `BACKEND-CONTRACT.md` 列出 token/DPAPI/Vault 选择等有意差异；Python 存储兼容层冻结到 0.20.x，0.21 起退化为可选静态页/模型代理。

### Phase 4 — 文章质量成为可发布的工程指标（已完成，P0/P1）

交付：

- 固定 6–10 个不同题材的 seed、模型参数和 8 章运行协议；
- 同一 seed 对比旧 Harness 与 Production Engine，保存 prompt/context manifest/正文/critic 结果；
- 指标包含任务覆盖、因果闭环、人物主动性、POV、声线、钩子、Canon 冲突、重复开场和人工盲评；
- 模型批评分与本地确定性指标分开，防止 critic 自证；
- 设发布阈值：中位盲评不得下降，blocker/Canon 回归为 0，关键维度至少达到预定提升；
- 将失败样本固化为回归 fixture，而不是继续把特例堆进 prompt。

验收：可以从同一命令复现 A/B 报告；生产引擎默认开启必须由结果而非主观印象证明。

完成证据：

- `evaluation/corpus-v1.json` 固定 6 个不同题材、每个 8 章、温度/seed/输出预算、八维 rubric 和发布阈值；
- `quality-ab.mjs fixture|live|blind|gate` 从同一入口生成 96 份章节工件、48 个确定性隐藏标签配对、独立 judge、人工评分模板和机器报告；
- 可选模型审计端口保存去凭据的真实 messages/参数、finish reason、usage 和响应 hash；每份工件另存 context manifest、正文 SHA-256、引擎 critic、连续性结果与本地确定性信号；
- 本地指标、独立模型 judge、人工盲评严格分层；fixture 即使所有分数通过也只有 `calibration-pass` 且 `releaseEligible=false`；
- 发布门要求 live provenance、全部工件 hash 完整、candidate blocker/Canon 为 0、独立 judge 关键维度提升和人工中位不下降；缺任一证据都保持 `hold`；
- 逐场独立采样的复述/声线/接缝风险改为“完整场面契约 + 单次整章起草 + 原子提交”；`scene` 仅作兼容回退；
- `quality-release.js` 当前结论为 `hold`，因此候选引擎没有在无真实证据时成为新安装默认；失败样本已进入版本化回归 fixture；
- Phase 4 Node 全量回归 55/55 通过。真实付费 A/B 需调用者显式提供服务和费用确认，未运行不会阻塞后续工程阶段，也不会被记作通过证据。

### Phase 5 — 静态质量门禁与可执行架构（已完成，P1）

交付：

- 在 Tauri Node 工具链固定 ESLint flat config、`@eslint/js`、`globals` 和覆盖率工具；
- 第一阶段只启用 correctness 规则，不做全仓格式化；纯领域模块覆盖率门槛先设 statements 80%、branches 75%；
- 保留本次新增的巨石“债务上限”，拆分后逐版下调；
- 增加 Windows 托管 workflow：版本、同步、Rust、Node、Python、正式后端 E2E、浏览器与视觉；
- 失败输出测试种子、后端日志和产物路径。

验收：本地 `scripts/ci.ps1` 与托管 CI 同构；不能通过压缩代码绕过债务上限，代码审查以职责边界和覆盖率为主。

完成证据：

- Tauri Node 工具链固定 ESLint 10.9.1、`@eslint/js` 10.0.1、`globals` 17.12.0 与 c8 12.0.0；首批只启用 correctness 规则，lint 已全绿；
- lint 发现并修复重复对象键、被 `finally` 吞掉的 superseded 结果、无效初始化和错误 cause 丢失等真实缺陷；旧请求被新运行抢占的返回值与锁所有权已有直接回归；
- 新增 `production-quality.js`，`production-engine.js` 从 1,386 行降至 1,219 行，债务上限同步降至 1,250 行/54KB；
- `scripts/domain-coverage.ps1` 显式度量纯领域内核而非适配器填充分母；Phase 7 将 observability 纳入后当前 statements 96.52%、branches 78.63%，超过 80%/75% 门槛；
- `mogao-tauri` 与 `novel-writer` 都登记 Windows workflow，均以同一 `scripts/ci.ps1` 为唯一流水线；非同名或私有 sibling 仓库通过 repository variable 与 `INKWELL_SIBLING_TOKEN` 配置；
- CI 质量 fixture 输出 corpus hash、generation/judge/assignment seed 和报告路径；后端合同、Rust E2E、布局与视觉测试在 `-KeepArtifacts` 下保存日志、trace、截图和失败数据供托管 artifact 上传；
- 当前工作区没有 Git remote，故无法伪造一条 GitHub 执行记录；workflow 定义、本地等价命令、PowerShell 解析、lint、60 个 Node 测试与覆盖率门均已本地验证。

### Phase 6 — 发布不可变与可追溯（已完成，P1）

交付：

- 日常 UI 同步只更新 Tauri embed/staging，不再写 `release/`；
- `build-release.ps1` 从干净工作树创建临时 stage，构建后一次性生成 release、manifest 和哈希；
- `verify-release.ps1` 校验 manifest 中的全部 UI 文件（当前 49 个）、exe、版本、源 commit、dirty 状态和 manifest；
- CI 对源码检查 sync，对正式发布检查 immutable artifact，两者不混用。

验收：修改 canonical UI 后，旧 release 仍自洽；只有正式构建会产生新 release；任一文件被手改都使 verify 失败。

完成证据：

- `sync-ui.ps1` 只在同卷 stage 中组装并原子替换 `src-tauri/ui-embed`；实测同步前后 `release/` 整树指纹不变，`check-ui-sync.ps1` 也只比较 canonical ↔ embed；
- `build-release.ps1` 在 `output/release-stage-*` 组装 49 项 UI、双 EXE 与说明，stage 通过源码 provenance 校验后才用带备份回滚的目录级原子切换发布；失败 stage 保留供 CI 上传；
- schema v4 manifest 记录双仓 commit/dirty/changeCount/source-tree、Cargo.lock、UI manifest、工具链、构建源、全部 UI/工件字节数与 SHA-256；`manifest.sha256` 保护 manifest 本身，精确文件集拒绝未声明文件；
- standalone `verify-release.ps1` 只依赖产物自己的 manifest；`-CompareSource` 是正式 stage 的额外校验。伪工件回归证明 UI 篡改、额外文件、manifest 篡改必失败，并保留 schema v3 历史校验；
- 本地以 `-AllowDirty` 生成了明确标记的 development release：全量 CI 先通过，EXE 10,910,720 bytes、SHA-256 `1f672faf74466e08edb2c346e49b0867bd525978f57c276a803789bff3a9c967`，manifest SHA-256 `e368e04288cfd5c50a707c0f2fb41dc176ec4358b697affee59d42b8cf75a75b`；随后源码继续变化时 standalone 校验仍通过；
- `release-build.yml` 只从干净 checkout 调用同一构建事务，要求显式 writer ref，并上传通过自验的目录；当前工作区无 remote，因此没有伪造远端正式发布记录。

### Phase 7 — 观测、性能与文档收口（已完成，P2）

交付：

- 统一错误枚举：model/retrieval/plan/quality/handoff/storage/conflict/cancel；
- 对上下文构建、模型阶段、章后交接、保存体积记录本地可导出指标，不记录密钥或正文；
- 建立 20/100/400 章规模预算和交互延迟回归；
- 将历史目标文档归档为 `docs/history/`，README 只链接当前架构、当前审计和发布手册。

验收：一次失败能回答“在哪个阶段、哪个状态、使用哪份正文和证据、是否可安全重试”；新人只读 README 即能找到唯一当前方案。

完成证据：

- `runtime-observability.js` 定义唯一闭合枚举 `model/retrieval/plan/quality/handoff/storage/conflict/cancel`；原先 `revision/unknown` 等展示分类已收敛为 category + stage/code；
- 失败 envelope 只记录 stage、task/production/handoff 状态、正文 FNV-1a 签名/字符数/revision/权威字段、context manifest 签名/计数和 retry policy；同一 Error 跨层只记一次，project/task/chapter 均可定位 `lastFailure`；
- API、上下文编译、交接、保存和写作用例均已接线。模型指标只有请求/输出字符数、tokens、finish reason 与耗时；上下文/交接/存储分别记录预算计数、阶段耗时和序列化字节数；
- `runtime-diagnostics-ui.js` 从 `app.js` 抽走错误展示和导出适配，`app.js` 当前 4,478 行/172,290 bytes，未靠上调债务上限容纳 Phase 7；设置 → 高级可导出 JSON；
- 指标只接受固定字段白名单，项目最多 240 条、会话最多 500 条，导出时再次清洗和去重；测试用正文、prompt、Key、Authorization、RAG 文本和原始异常消息哨兵证明不会泄漏；
- `performance-budget.mjs` 用固定 seed 建立 20/100/400 章项目，CI 实测 context p95 为 2.377/2.589/3.055 ms，400 章保存序列化 p95 3.890 ms，均低于 30/75/120 ms 与 20/60/180 ms 门限；报告保存到 `output/performance/report.json`；
- 新增 `ARCHITECTURE.md`、`OBSERVABILITY.md`、`PERFORMANCE-BUDGET.md` 和 Tauri `docs/RELEASE.md`；3 份旧 Python/Vault/Rust 路线与 14 份 GOAL 已归档，仓库根不再残留旧入口；
- `test_documentation_navigation.mjs` 断言两个 README 都且只链接当前架构、当前审计、发布手册，并验证全部 17 份旧文档的归档位置；
- canonical/embed 现为 51 项且字节一致；Phase 6 的 49 项旧 development release 在源码变化后仍通过 standalone schema-v4 校验，证明归档和同步未污染不可变产物；
- 最终同构 CI 全绿：Rust 69、Node 60、Python 31（1 skipped）、Rust/Python contract v1 各 1、正式 Rust E2E 1、布局 49、视觉 1；纯领域 statements 96.52%、branches 78.63%，其中 observability 自身 99.21%/86.23%。

### Phase 8 — 质量证据与组合根收敛（已完成，P0/P1）

#### Phase 8A — 质量源码指纹与实验身份（已实现）

交付：

- 建立唯一、显式排序的质量关键源码清单，覆盖 baseline/candidate 生成、prompt、上下文、检索、模型适配、确定性评分和 gate；
- 对文本按 LF 规范化后逐文件 SHA-256，再生成聚合 fingerprint，避免 Windows checkout 换行差异制造假失效；
- 每次 fixture/live 运行把完整源码 manifest、唯一 run id 与 corpus hash 一起写入 `run.json`；
- gate 同时验证 manifest 内部完整性和“运行时源码指纹 == 当前源码指纹”，旧报告不得跨关键源码变化复用；
- 先补 characterization test，证明旧 gate 确实不检查源码，再以缺失文件、篡改 hash、源码漂移和正常 fixture 覆盖修复。

验收：任一关键文件改动、缺失或清单变化都会使旧 run 结论变为 `hold`；相同源码跨 CRLF/LF 得到相同 fingerprint；fixture 仍只能是 `calibration-pass`。

实现证据：`quality-source-contract.mjs` 同时向 `eval-continuity.mjs` 提供真实运行清单、向 A/B 工具提供 27 文件证据清单；run id 由 provenance/corpus/source/model/judge/time 共同派生。gate 新增 `quality-source-manifest` 与 `quality-source-current`，测试覆盖 CRLF/LF、路径逃逸、缺文件、hash 篡改、旧 run 和运行期间源码漂移。当前 fingerprint 为 `10455dc80244b59781922040857a3c26f4fdc02696a51d1bb9291dc684d6ff92`。

#### Phase 8B — 默认引擎提升证据合同（已实现）

交付：

- 将 `quality-release.js` 提升为带当前源码 fingerprint 的版本化决策记录；
- 增加纯策略验证器：`hold` 必须关闭默认候选且不得伪装已评估，`pass` 必须引用 live、releaseEligible 的 report digest、corpus digest、source fingerprint 和评分覆盖；
- 增加 promotion bundle 生成/验证命令；非通过报告、fixture、源码漂移或字段不全都不得产生可接受提升记录；
- 把验证接入本地/托管 CI，而不是靠针对当前 `false` 的正则断言。

验收：手改 `productionDefaultEnabled=true`、复用旧报告或删掉证据字段均使 CI 失败；回滚到 `hold` 不需要删除历史实验工件。

实现证据：`quality-release.js` 升为 schema v2；浏览器策略对不完整 pass 自动 fail-closed，Node verifier 不接受这种运行时降级。`quality-ab.mjs promote` 只对当前源码上的 live/pass 报告生成去正文 bundle，记录 report/artifact/judge/human/blind-key digest；`verify-quality-release.mjs` 已进入 `ci.ps1`。当前没有伪造 approved bundle，决策仍为 `hold/false`。

#### Phase 8C — 静态组合根显式合同（已实现）

交付：

- 为 canonical 脚本建立 providers/requires/optional 合同，区分必需依赖、可选能力和 composition-root side effect；
- 根据 `index.html` 验证唯一 provider、缺失依赖、加载逆序、未知全局引用和循环依赖；
- 在 `app.js` 启动前执行 fail-fast，错误直接指出缺失 global 与提供文件；
- canonical/embed 清单继续由同一同步事务维护，不修改旧 release。

验收：删除脚本、交换关键顺序、重复 provider 或新增未登记 `NOVEL_*` 引用时，Node 架构测试在浏览器启动前失败。

实现证据：`composition-contract.js` 与 `index.html` 同序描述 47 个脚本；所有全局引用均归类为 eager/deferred/optional/external。静态测试拒绝重复 provider、逆序依赖、未知引用和清单漂移；`app.js` 在捕获 ports 前执行 preflight，在 `__mogaoReady` 前核对 deferred globals。新增策略与组合合同后 canonical/embed 清单为 53 项。

#### Phase 8D — 回归、兼容与文档关闭（已完成）

交付：更新质量评测、架构与审计文档；同步 canonical/embed；执行 lint、领域覆盖率、质量 fixture、性能、Rust/Python contract、Rust E2E、布局、视觉和 immutable release standalone 校验。

验收：本地同构 CI 全绿；当前 53 项 canonical/embed 一致；Phase 6 的 49 项旧 release 仍独立自洽；真实文章质量未有付费盲评证据前发布结论继续为 `hold`。

完成证据：同构 CI 全绿——Rust 69、Node 63、Python 31（1 skipped）、Rust/Python contract v1 各 1、正式 Rust E2E 1、布局 49、视觉 1。纯领域 statements 96.66%、branches 79.56%，新 `quality-release-policy.js` 自身 100%/98.14%。20/100/400 章 context p95 为 2.273/2.257/3.021 ms，400 章保存序列化 p95 3.877 ms。质量 fixture 生成 96 工件/48 对且只能得到 `calibration-pass`；release verifier 得到 `hold/false`。canonical/embed 53 项一致，旧 release standalone 仍验证 49 UI hash 与原 manifest digest。

## 7. Phase 0–8 完成总览

| 项 | 状态 |
|---|---|
| 共享 Production State 领域模块 | 已实现 |
| Vault/localStorage/编辑器/工作区/冲突/交接接入 | 已实现 |
| production engine 复用同一 body signature | 已实现 |
| 状态、交接兜底与加载适配器单测 | 已实现 |
| 架构债务上限与纯模块边界测试 | 已实现 |
| UI 资产清单 | canonical/embed manifest 53 个；Phase 6 的 immutable release 自带 49 个并保持独立自洽 |
| Phase 1 schema/transition registry | 已完成：幂等迁移、合法转换表、写前校验、未来版只读、golden fixtures |
| Phase 1 全量 CI 基线 | 已通过：Rust 69、Node 43、Python 31（1 skipped）、浏览器 49、视觉 1 |
| release 不可变事务 | Phase 6 已完成：旧污染被检测；schema v4 development release 经全量 CI、源码比对、standalone 校验与篡改回归通过 |
| controller/use-case 拆分 | Phase 2 已完成：硬上限、纯模块边界、直接行为测试和 UI 回归均通过 |
| Phase 2 全量 CI | 已通过：Rust 69、Node 53、Python 31（1 skipped）、浏览器 49、视觉 1 |
| Phase 3 后端合同 | 已通过：Python/Rust contract v1 各 1 套；正式 Rust 浏览器 E2E 1/1 |
| Phase 4 文章质量发布门 | 已实现：6×8 固定 corpus、96 工件、48 盲评对、fixture 校准通过；真实默认结论保持 hold |
| Phase 5 静态质量与托管 CI | 已实现：lint 全绿；纳入 observability 后领域 statements 96.52%、branches 78.63%；双仓 Windows workflow 与失败工件留存 |
| Phase 6 不可变 release | 已实现：49 项 UI、双 EXE、manifest checksum、精确文件集、原子发布/回滚和干净 hosted release workflow |
| Phase 7 脱敏观测 | 已实现：八类错误、正文/证据身份、retry policy、上下文/模型/交接/存储指标与设置内 JSON 导出 |
| Phase 7 性能预算 | 已实现：20/100/400 章 deterministic fixture、项目体积及四项 median/p95 硬门，已进入同一 CI |
| Phase 7 文档收口 | 已实现：17 份历史计划已归档；双 README 的唯一三个当前入口由 Node 测试锁定 |
| Phase 7 最终 CI | 已通过：Rust 69、Node 60、Python 31（1 skipped）、双后端合同、Rust E2E 1、布局 49、视觉 1 |
| Phase 8A 质量源码指纹 | 已实现：27 文件有序 manifest、LF 规范化、唯一 run id、当前源码 gate 与负向测试 |
| Phase 8B 默认提升证据合同 | 已实现：schema-v2 fail-closed 决策、promotion bundle、Node/CI verifier |
| Phase 8C 静态组合根合同 | 已实现：47 脚本全局依赖分类、静态顺序/引用检查、boot 前后断言 |
| Phase 8D 全量关闭 | 已通过：Rust 69、Node 63、Python 31（1 skipped）、双后端合同、Rust E2E 1、布局 49、视觉 1；领域 96.66%/79.56% |

## 8. 实施原则与回滚

- 不做大爆炸重写；每一步保持旧 UI 和旧书可用。
- 先为现有行为补 characterization tests，再移动职责。
- 每个新领域模块必须无 DOM/网络/存储，且有直接单测。
- 兼容开关必须写明移除条件；不能永久保留两套默认路径。
- 数据迁移只追加、幂等；写盘前保留快照，未知 schema 不覆盖。
- release 只在所有质量门通过且工作树干净时重建。本次源码仍有未提交开发改动，因此不伪造新的正式发布包。
