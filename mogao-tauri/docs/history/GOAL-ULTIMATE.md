# Goal：墨稿终极形态 —— 创作 + 叙事分析一体化工作台

## 0. 对照分析

### 0.1 参考项目优点（ops120/ai-novel-screenplay-analyzer）

| 能力 | 要点 |
|------|------|
| **长任务引擎** | 后台 loop、暂停/继续/取消、429 降并发、失败切片重试、刷新恢复 |
| **切章/分块** | 中文「第N章/回」、序章/楔子；块前注入章节上下文 |
| **关系数据模型** | nodes/edges + chapter + occurrence；档案/演化轨迹可计算 |
| **关系全景 UX** | G6 图、次数过滤、章节范围、关系行数、预览/全量 |
| **人物档案** | 度数、邻居、章节、可追溯 |
| **关系演化时间线** | 同一对人物跨章变化 |
| **多模型管理** | OpenAI / 火山 / 百炼；密钥本地、测连 |
| **持久化** | SQLite + 大文本 progress 专用通道（非 5MB LS） |
| **工程** | 大量单测、API 契约检查、安全回归（CORS 白名单、body limit、LLM 密钥不外泄） |
| **产品定位** | 「不是替你读，是让团队读同一本」— 可复核底稿 |

### 0.2 墨稿现状优点

| 能力 | 要点 |
|------|------|
| **创作管线** | idea→world→cast→spine→tasks→写章→digest→graph delta |
| **Vault 书库** | 开/建/导入、BookDir 纠偏、force、搜索、renameFolder |
| **工作区** | Obsidian 式树/编辑/预览/DnD/快照/epoch |
| **桌面壳** | Tauri + 单实例 + 内嵌 Axum + rust-embed |
| **数据闸** | token、slug 白名单、空 chapters 不抹盘、tasks merge、IO 主锁 |
| **短上下文** | 专为网页反代/小窗口设计的 pack 策略 |

### 0.3 墨稿仍存缺点（上轮审核残留 + 产品缺口）

| 级 | 缺口 |
|----|------|
| P0 | 关窗 file→PUT 整本可盖新 md；auto 章间解锁+save 绑 active；slim 迁入空 body；dirty 工作区切走再回丢稿 |
| P1 | token 挂 URL；预览消毒浅；IO 锁未盖 rename/import；无 clearChapters UI；app.js 巨石；分析能力弱（仅 Mermaid 文本） |
| 产品 | 无「导入全书→切章分块→长任务分析」；无关系次数/章节筛选；无档案/演化面板；无分析断点；图谱非交互 |

### 0.4 最终目标（产品定义）

> **墨稿 = 本地优先的「自动连写创作台」+「叙事关系分析台」**  
> 一书一 vault 目录；创作产物与分析产物同一书下共存；关窗不丢稿；分析可暂停续跑；图谱可筛选可点选。

**非目标（本 Goal 不做）**：完整移植 G6/Electron/SQLite 整仓；云协作；插件市场；自动更新 CDN。

**本 Goal 交付定义（V1 完成）**：

1. **写权威闭合**（上轮 P0 A1–A4 全绿）
2. **叙事分析 V1**：切章分块、块抽取、合并 graph、档案、演化时间线、次数/章节筛选、分析进度可续
3. **安全/工程**：token 启动后清 URL；rename/import 进 IO 锁；预览加强；单测+CI+release

---

## 1. 信息架构（目标）

```
books/<slug>/
  book.json              # 创作工程
  章节/*.md
  策划/ …
  关系/graph.json        # 合并后全图（分析+创作共用）
  分析/
    meta.json            # 进度：chunks, last_completed, status
    chapters.json        # 切章边界
    extractions/0001.json
    timeline.json        # 可选缓存
    report.md
```

前端模式：

| 模式 | 职责 |
|------|------|
| workspace | 文件工作区（已有） |
| pipeline | 策划/任务（已有） |
| write | 写章台（已有） |
| **analyze** | **叙事分析工作台（新建）** |
| graph | 升级为筛选+档案+时间线（或并入 analyze） |
| control | 设置/模型（增强多协议说明） |

---

## 2. 详细执行计划

### Phase 0 — 写权威 P0（必须最先）

| ID | 项 | 交付 |
|----|-----|------|
| U0-1 | flush 一致性 | 关窗/flush：WS 内容 merge 进对应 chapter 后再 PUT；或 PUT 时对 open 章 path 以磁盘为准 |
| U0-2 | auto 全程锁 | 连写 for 循环内 lock 保持；仅更新 writingChapterId；`saveBook(p)` 固定书对象 |
| U0-3 | 迁入防护 | slim 项目 body 全空则拒绝迁入或只建 meta 不写 chapters |
| U0-4 | dirty 工作区 | 离开：取消=return；确认=先 saveCurrent；回场：同 slug 不 rebind 清空 |

### Phase 1 — 叙事核心库（无 UI 也可测）

| ID | 项 | 交付 |
|----|-----|------|
| U1-1 | `chapter-split.js` | detectChapterRanges / splitChunks（移植 ref 思想，纯函数+node 测） |
| U1-2 | `narrative-model.js` | mergeGraphs、buildCharacterProfile、buildRelationshipTracks、filterByOccurrence/Chapter |
| U1-3 | `analysis-runner.js` | 按块调 LLM 抽取 JSON、落 extractions、merge 到 graph、写 meta 进度 |
| U1-4 | vault API | `分析/` 目录读写：list/put extraction、get/put meta、get/put graph 已有 file API 即可 |

### Phase 2 — 分析 UI + 长任务体验

| ID | 项 | 交付 |
|----|-----|------|
| U2-1 | 模式 `analyze` | 导入文本/从章节拼接、切章预览、开始/暂停/继续、进度条 |
| U2-2 | 图谱增强 | 次数过滤、章节范围、点选人物→档案面板、关系时间线列表 |
| U2-3 | report | 生成 `分析/report.md` 概览+Top 人物+时间线摘要 |
| U2-4 | 与写章联动 | 分析 graph 写回 `关系/graph.json` + book.graph；写章 digest 仍增量 merge |

### Phase 3 — 安全与工程收口

| ID | 项 | 交付 |
|----|-----|------|
| U3-1 | token | 读入后 `history.replaceState` 去掉 query token |
| U3-2 | IO_LOCK | rename_book / import_book_dir / create_snapshot 持锁 |
| U3-3 | preview | 加强消毒（javascript:、embed、svg on*） |
| U3-4 | 测试 | chapter-split、narrative-model node 测；cargo 保持绿 |
| U3-5 | CI/release | ci GREEN + 发布包 |

### Phase 4 — 文档与版本

| ID | 项 |
|----|-----|
| U4-1 | README：创作+分析双工作流 |
| U4-2 | 版本 0.4.0 |
| U4-3 | GOAL 验收全勾 |

---

## 3. 任务拆分（Agent）

| Agent | Phase |
|-------|-------|
| T-write | U0-* 前端写权威 |
| T-narrative | U1-* 核心库 + 测 |
| T-ui | U2-* analyze UI + graph 增强 |
| T-secure | U3 后端锁/preview + token |
| T-integrate | U3-4/5、U4、总验收 |

## 4. 验收清单（V1 Done）

- [x] 关窗：WS merge 进 chapter 后再 PUT
- [x] 自动连写全程 genLock；flushProject(p)
- [x] 迁入拒绝 slim 空 body
- [x] dirty 工作区确认后 saveCurrent；同 slug 不 rebind
- [x] 切章/分块/analysis-runner 暂停续跑
- [x] 图谱筛选 + 档案 + 时间线 + 分析模式 UI
- [x] graph → 关系/graph.json + 分析/
- [x] token replaceState 清 URL
- [x] IO_LOCK 覆盖 rename/import/snapshot；preview 加强
- [x] cargo 33 + narrative 11 + ci + release

**Goal 状态：V1 已完成（2026）。版本 0.4.0。**
