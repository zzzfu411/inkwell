# Inkwell 叙事生成架构（Production Engine v1）

## 为什么旧链路会写出“能读但不好看”的文章

旧链路把策划、检索、场面调度、人物决策、文风控制、章末收束和事实维护压进一次整章模型调用。`chapterBeat` 只是文本清单，模型没有必须提交的因果接口；写完后才做连续性审查，默认 `warn` 仍会把有问题的稿件推进到 `done`；自动修复又只接受唯一命中的 search/replace，无法修复节奏、人物主动性或场面缺结果。

上下文也存在职责混杂：锁定 Canon、上章正文、滚动摘要、RAG 线索和作者临时指令被拼成一段平面文本，预算裁剪后模型无法区分“必须服从的事实”和“仅供参考的召回”。长期记忆主要来自模型摘要，缺少一个可恢复的生产状态和场面级检查点。

因此质量问题的根因是编排和数据契约，而不是单纯缺少更多提示词。

## 新的职责边界

```text
任务卡 + 上章余波 + 锁定 Canon
              │
              ▼
      Chapter Contract（目标/代价/冲突/POV/钩子）
              │
              ▼
      Scene Contracts（goal→obstacle→action→turn→outcome）
              │
              ▼
      Coherent Chapter Draft
      （一次模型调用消费完整场面契约）
              │
              ▼
      原子提交正文 + 契约完成清单
              │
              ▼
      Continuity Review / bounded repair
              │（若改稿，先作废旧报告）
              ▼
      Semantic Critic（因果/主动性/视角/张力/钩子）
              │
        不通过 ─┴─► bounded full-chapter revision（最多 N 次）
              │
              ▼
      Quality Gate（严格模式不通过就停在 needs_revision）
              │
              ▼
      Handoff：摘要 / Canon / 伏笔 / 状态 / 图谱 / RAG reindex
```

### 1. Chapter Contract

`chapter.production.contract` 是本章的可审计接口，包含目标、失败代价、主要冲突、单一 POV、必须兑现项和章末钩子。它由 `production-engine.js` 规范化，旧任务字段仍可作为输入。正文锚点覆盖、确定性本地指标、critic 结果归一化和质量放行规则位于无 I/O 的 `production-quality.js`；编排器只注入 craft、上一章查询和默认阈值，不能再用运行状态给质量结论自签名。

### 2. Scene Contract 与整章起草

每场仍必须给出具体地点、人物目标、阻力、行动、转折、结果和感官锚点，但默认 writer 一次消费整份契约并输出完整章节。逐场独立采样再拼接容易制造重复介绍、段首回顾、叙述距离漂移和场间因果接缝；`chapter-drafting-service.js` 因而把场面当成整章内部约束，而不是多次模型调用边界。

流式预览可以暂时显示在编辑器里，但只有完整输出通过长度和元标签校验后才原子提交；失败会恢复调用前正文。`chapter.production.draftManifest` 记录 prompt/body hash，`production.scenes` 只保留契约完成元数据，不复制整章正文。`productionMode=scene` 仅保留为低上下文旧模型兼容档。

### 3. Evidence Pack

`context.buildProductionEvidencePack()` 不再返回无标签的大杂烩，而是按可信度标记：

- `locked`：Canon 数字、专名和不可逆事实；
- `continuity`：上章已写结果；
- `state`：人物、时间线、伏笔和故事状态；
- `instruction` / `author`：本轮章节契约和作者指令；
- `reference`：RAG 召回线索，只能辅助定位，不能覆盖事实；
- `working`：本轮已完成场面和临时衔接。

预算按上述顺序确定性分配，Manifest 会记录使用、裁剪和省略的区块。

### 4. Semantic Critic 与 Quality Gate

连续性审查继续负责事实冲突；新的批评器负责“文章是否成立”：因果推进、人物主动性、场面完成、POV、张力、声线、钩子和 prose 八项评分。连续性自动修订必须先完成，再对最终正文运行 Semantic Critic；质量验收之后不得静默改稿。引擎同时计算本地可复现指标（场面 action/turn/outcome 命中、章末钩子、长度比例、既有 craft lint），防止模型返回 `pass` 却没有落地场面。

默认严格闸门要求：

- 批评器 verdict 为 `pass`；
- 综合分不低于 7/10；
- 场面与因果完成率不低于 75%；
- 正文达到目标长度的 55%；
- 没有 blocker/major 结构问题；
- 章末钩子在正文结尾有可观察落点。

未通过时最多执行一次整章救稿并复检；仍未通过则任务状态为 `needs_revision`，绝不会静默进入 `done`。

## 状态与恢复

`chapter.production.status` 的业务状态为：

`pending → needs_revision/revising → accepted → accepted_pending_handoff → done`

`contract / scene-writing / quality-review / paused` 是 `production.stage` 或 `runtimeState`，不再冒充业务终态。合法转换由 `chapter-state.js` 的 `PRODUCTION_TRANSITIONS` 声明；`task.status`、production 状态和 `handoffStatus` 只能通过该模块一起更新，非法转换会以 `ILLEGAL_CHAPTER_TRANSITION` 阻断写入。暂停和失败保留 `lastStableState`；已验收正文若在交接阶段失败，会留在 `accepted_pending_handoff` 供安全重试。

异常会保留 `errors`、`lastStage`、契约完成清单和质量报告。默认整章起草失败会原子恢复旧正文；兼容逐场模式仍可恢复到最近提交场面。重试 `needs_revision` 只进入救稿/复检，不重复追加正文；作者手改正文后系统把当前正文提升为新的 `baseBody`，避免覆盖作者修改。`revisions` 是累计审计计数，`revisionPasses` 是当前稿件的有限救稿预算，作者改稿后才会开启新的预算周期。完成交接或整章救稿后会清掉场面正文副本，并以 `bodyAuthoritative + bodySig` 标记 `chapter.body` 为唯一完整正文；恢复时先验证签名，防止压缩后的检查点再次拼接整章，作者外部改稿则自动开启新的复检周期。

严格规划模式下，契约规划器不可用或返回不可执行场面，且任务/作者细纲没有至少两个确定性场面时，状态会停在 `failed/PRODUCTION_PLAN_FAILED`，不会偷偷生成通用占位场面。关闭严格规划策略时才允许使用兼容回退。

正文签名与交接准入由独立的 `production-state.js` 维护，而不是由某个编辑器按钮维护。Vault 完整装载、localStorage 恢复、工作区 Markdown 合并、保存冲突裁决和手工编辑都走同一失效规则；最终 `handoffChapter` 还会重新核对签名，兜住未来新增但漏接主动失效逻辑的正文写入路径。strict 策略要求当前事务刚验收通过，或持久化状态已验收且签名仍匹配；`pending` 不再因为“没有显式阻断”而被放行。早期记录没有签名时只建立一次基线，slim 缓存的空正文则等待 Vault hydrate 后再判断。

全书与 production 都使用独立 `schemaVersion=1`。旧书通过幂等相邻迁移加载；未知更高版本只读，保存、工作区写入、快照恢复和浏览器缓存迁入都被拒绝。完整合同与 fixture 清单见 [`PROJECT-SCHEMA.md`](./PROJECT-SCHEMA.md)。

## 兼容与回退

- `productionEngineEnabled=false` 回到 0.19 的 Harness；
- `productionMode=chapter` 是候选生产引擎的默认起草方式，`scene` 只作兼容回退；
- 为兼容低额度旧书，关闭“写前本章细纲”（`chapterBeatEnabled=false`）时自动周期也回到旧 Harness；迁移/评测可用 `hooks.production=true` 强制新引擎；
- `written/digested/done` 旧章节不重写，只沿用原交接路径；
- 旧 `beatPlan` 仍由契约投影生成，现有细纲编辑器和 craft 指标继续可用；
- `manualAutoHandoff=false` 时，质量通过的正文停在 `accepted_pending_handoff`，不会伪报“已完成”。

## 验收方式

离线单测覆盖契约规范化、证据分层、场面恢复、质量阻断和有限救稿；现有 0.19 全量逻辑测试继续运行。真实模型回归应至少比较：

1. 任务覆盖率与场面 action/turn/outcome 完成率；
2. 质量闸门通过率、平均救稿次数和阻断原因；
3. blocker/major 连续性问题与 Canon 冲突数；
4. 人物主动性、因果推进、POV 稳定性和章末钩子人工盲评。

可执行固定 corpus、盲评协议和发布阈值见 [`QUALITY-EVALUATION.md`](./QUALITY-EVALUATION.md)。在完整真实 A/B 与人工盲评通过前，候选引擎不作为新安装默认值。
