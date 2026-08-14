# Inkwell RAG + Harness 设计说明（v0.9）

## 调研摘要（2024–2025 实践）

长篇连载不能只靠「塞更长上下文」，业界有效组合是：

| 层 | 方案 | 本项目对应 |
|----|------|------------|
| Story Bible | 结构化设定库 + 锁定事实 | `detailCanon` / `细节设定.md` |
| Hierarchical memory | 原文 → 章摘要 → 卷/线位置 | 章正文块 + digests + storyline |
| Loop lifecycle | 伏笔/悬念可开启、推进与关闭 | `plotLoops` |
| Dynamic state | 人物位置、伤势、能力、持有物、时间线 | `entityStates` / `timelineEvents` |
| Style memory | 叙述规则与人物声线 | `styleBible` |
| Hybrid RAG | BM25/词法 + 可选 dense + 元数据 | `rag.js` |
| Query 分解 | 多查询 / 实体 / 钩子 | `buildQueriesFromTask` |
| Agent Harness | Plan→Retrieve→Generate→Update | `harness.js` |
| Quality gate | 写后审查与有限局部修订 | continuity review / repair |
| Write-back | 生成后更新记忆再索引 | digest handoff + reindex |

参考方向（概念层，非强制依赖）：GraphRAG/社区摘要、RAPTOR 树摘要、Corrective/Adaptive RAG、MemGPT 式分层记忆、LangGraph 显式流水线。

## 本仓库实现边界

- **不引入** Pinecone/LangChain 等重依赖；跑在浏览器 + Tauri。
- **默认 BM25 混合检索**（零额外 API）；可选 `ragUseEmbeddings` 走反代 `/v1/embeddings`。
- embeddings 模式使用宽候选池：词法命中 + Canon/状态/钩子/时间线 + 相邻正文，而不是只重排 Top-8。
- 自动修订只接受正文中唯一命中的局部替换，最多一轮并复检；不会自动全文重写。

## 写章数据流

```
任务卡
  → Harness.retrieve（多查询 BM25 ± embed）
  → packForWrite（故事线 + canon + RAG hits + 上章文末 + 任务）
  → LLM 写正文（gemini-3.6-flash）
  → 连续性审查（可选局部修订 + 一次复检）
  → 章后交接 JSON → memoryRoll / detailCanon / plotLoops / entityStates / timeline / storyline
  → 关系增量
  → RAG reindex
```

## 配置

| 项 | 默认 | 含义 |
|----|------|------|
| harnessEnabled | true | 走完整流水线 |
| ragEnabled | true | 本地检索 |
| ragUseEmbeddings | false | 向量重排 |
| ragTopK | 8 | 命中条数 |
| ragMaxChars | 3200 | 注入 prompt 上限 |
| contextBudgetChars | 16000 | 总上下文预算 |
| contextBudgetTokens | 12000 | 输入 token 保守估算上限 |
| manualAutoHandoff | true | 普通生成后自动更新长期记忆 |
| continuityReviewEnabled | true | 交接前运行连续性审查 |
| continuityAutoRepair | true | 是否允许唯一命中局部修订 |
| chapterBeatEnabled | true | 写前本章细纲 |
| proseLintEnabled | true | 写后套话/开场检查 |
| ragFailurePolicy | warn | `warn` 或 `strict` |

## 持久化

除 `book.json` 外，连续性状态会镜像到 `记忆/plot-loops.json`、`continuity-issues.json`、`entity-states.json`、`timeline-events.json`、`continuity-reviews.json`、`context-manifests.json`；风格圣经位于 `策划/style-bible.json`。旧书缺少新字段时从历史摘要迁移。

## 评测

`scripts/eval-continuity.mjs` 统计任务完成、blocker/major、Canon 冲突、钩子、RAG 命中、开场撞车、细纲覆盖和套话风险。

离线（不花额度）：

```bat
node scripts/eval-continuity.mjs --score vault\books\<slug>\book.json
node scripts/eval-continuity.mjs --compare baseline.json current.json
```

真实模型 10–30 章回归必须显式设置 `INKWELL_EVAL_CONFIRM=YES` 和 `INKWELL_API_KEY`。可选 `INKWELL_EVAL_BASELINE` 与上一份报告对比。门槛不过时进程退出码为 2。

## 文件

- `rag.js` / `harness.js`
- 落盘：`记忆/rag-index.json` 等
- 测试：`tests/test_rag_harness.mjs`
