# Inkwell 项目 Schema 与章节状态合同

当前持久化版本：`book.schemaVersion = 1`，`chapter.production.schemaVersion = 1`。

本合同覆盖 `book.json`、Vault 完整装载、localStorage recovery/slim 缓存和浏览器迁入。完整正文仍以 Vault 的 `章节/*.md` 为权威；schema 迁移只处理结构与可确定推导的状态投影，不猜测正文内容。

## 版本和迁移

- 缺少 `schemaVersion` 视为 v0；版本必须是非负整数。
- `project-migrations.js` 只注册相邻的 `vN → vN+1` 迁移。每个迁移必须可重复执行，第二次执行不得改变序列化结果。
- 根迁移记录写入 `book.schemaMigrationHistory`；production 迁移记录写入 `chapter.production.schemaMigrationHistory`。
- v0 → v1 补齐根数组、根版本，以及 production 的版本、状态、场面、错误和上下文 Manifest 容器。
- 读取后由 `chapter-state.js` 只修复能够从现有终态唯一推导的 task/production/handoff 投影；不创建当前时间，也不重写正文。
- 项目根版本或任一 production 版本高于客户端支持版本时，项目进入只读保护。迁移、恢复核对、工作区写入、快照恢复、批量迁入、异步/同步整本保存都不得覆盖该项目。

写入边界是 `NOVEL_PROJECT_MIGRATIONS.assertWritable(project)`。新增任何保存适配器时，必须在产生副作用之前调用它；仅在 Vault 请求内部补校验不够，因为调用方可能已经修改内存或工作区文件。

## 唯一状态转换边界

`chapter-state.js` 是以下三个持久化投影的唯一运行时写入者：

- `task.status`
- `chapter.production.status/stage`
- `chapter.handoffStatus`

业务代码调用命令，不直接拼字符串：

| 意图 | 命令 |
|---|---|
| 开始新/旧写章 | `markGenerating` / `markWriting` |
| 正文写完（旧链） | `markWritten` |
| 正文或签名变化 | `requestRevision` |
| 进入质量修订 | `markRevising` |
| 质量验收通过 | `markAccepted` |
| 开始/完成章后交接 | `startHandoff` / `completeHandoff` |
| 摘要完成 | `markDigestComplete` |
| 交接需重试 | `markHandoffStale` |
| 暂停/失败 | `markPaused` / `markFailed` |
| 撤销未交接生成 | `captureProjection` / `restoreProjection` |

合法 production 转换由 `PRODUCTION_TRANSITIONS` 显式声明；非法转换抛出 `ILLEGAL_CHAPTER_TRANSITION`。关键不变量：

1. `production=needs_revision` 时，task 必须为 `needs_revision`，handoff 不得为 `running/done`。
2. `production=done` 时，task 与 handoff 必须同时为 `done`。
3. 已验收正文需要重做交接时，从 `done` 回退到 `accepted_pending_handoff`，不能留下 `done + stale`。
4. strict 模式只有本事务刚验收通过，或持久化状态已验收且 `bodySig` 匹配时，才允许交接；`pending` 不是“未阻断即通过”。
5. 连续性自动修订必须在 Semantic Critic 之前完成；修订会作废旧报告，不能在质量验收后静默改正文。
6. 暂停/失败记录 `runtimeState` 和 `lastStableState`。已验收正文在交接阶段失败时保留为 `accepted_pending_handoff`，供安全重试，而不是伪装成未写稿。

## 写入和恢复顺序

```text
load/hydrate
  → inspect schema
  → migrate vN → vN+1
  → repair/validate chapter projections
  → reconcile authoritative bodySig
  → render

save/migrate/snapshot restore
  → assertWritable (before any side effect)
  → flush editor/workspace
  → validate projections again
  → serialize and write
```

`production-state.js` 负责正文签名、旧质量报告失效和交接准入；`chapter-state.js` 负责投影转换。两者不能合并为 UI 事件处理器，也不能由调用方复制同一逻辑。

## Golden fixtures

`tests/fixtures/projects/` 固定覆盖：

- v0 旧书；
- v0 空书；
- v1 中断场面；
- v1 外部改稿导致签名失效；
- v0 recovery 的非法终态修复；
- v1 当前书幂等无变化；
- v2 未来书保持原字节并只读。

修改 schema 或状态语义时，先新增 fixture 和向前迁移，不允许原地重释既有版本。需要破坏性变更时必须提升版本，并保留旧版读取测试。
