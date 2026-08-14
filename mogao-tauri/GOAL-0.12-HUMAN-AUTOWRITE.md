# Goal 0.12 · 自动连写读起来像人写

**产品**：Inkwell / 墨稿  
**版本目标**：`0.12.0`  
**状态**：执行中  
**正式源**：只改 `novel-writer/`，验收后同步三套 UI。

---

## 0. 为什么是这一刀

0.11 把编辑台做成了稿纸和星图。作者真正要的下一件事是：

> 点「自动连写」，连出的章节像一个具体的人写的，而不是每章重演高潮、套话开场、把幻觉写进设定库。

当前管线是 `Retrieve → Write → Review → Handoff`。缺的是人会做、机器没做的三步：

| 缺口 | 后果 |
|------|------|
| `chapterBeat` 从未调用 | 模型对着任务卡直接开写，场面同质、开场撞车 |
| 交接 JSON 无本地闸 | 幻觉数字/假事实能进 Canon |
| 套话与开场类型不检查 | 「夜色/雾/嘴角一抹」连章复读 |
| 自动修复默认关 | 连写不会修 blocker |
| digest 不收 `abandoned_loops` | 钩子只能开不能弃 |

本 Goal **不**拆 `app.js`、不搬分析进 Worker。那些是工程债；这期先抬正文质量。

---

## 1. 产品定义

自动连写一章的完整闭环变为：

```
Retrieve → Plan(细纲) → Write → Prose Lint → Review → Optional Repair → Handoff(闸过的 digest) → Reindex
```

作者仍可关细纲或关修复。默认对「按任务写 / 自动连写」打开。

**像人写**在本仓库的可执行含义（不是文青口号）：

1. 本章有 2–5 个场面，每个场面有地点、动作、转折，而不是一段情绪空转。
2. 开场类型不与上一已写章相同（天气/醒来/走路/对白/神态轮换）。
3. 上章高潮只写后果，不重演。
4. 锁定数字与专名不得被交接改写；证据不在正文里的事实不得入库。
5. 风格圣经里的禁词出现时记风险，供审查/修复。

---

## 2. 不变量

- 不改 vault 目录与 book.json 权威字段语义（可在 chapter 上增加 `beatPlan` / `openingKind`）。
- 已 `written/digested/done` 仍禁止叠章。
- 局部修复仍只接受正文唯一命中。
- 不引入打包器。新文件必须进 `ui-files.txt`。

---

## 3. 交付

### P0（本轮必须）

| ID | 项 | 完成标准 |
|----|----|----------|
| P0-1 | `craft.js` | 纯函数：开场类型、套话检查、细纲规范化、digest 闸 |
| P0-2 | 写前细纲 | harness / fallback 在写章前调用 `planChapterBeat`；细纲进 `packForWrite` 硬保块 |
| P0-3 | 写章纪律 | `writeChapter` 要求按细纲场次写、禁套话、禁撞开场 |
| P0-4 | 交接闸 | digest 入库前丢掉无证据 / 与锁定冲突的 canon；规范化 `abandoned_loops` |
| P0-5 | 套话回流 | 写后 lint 写入 `continuityIssues`，下一章看得到 |
| P0-6 | 默认修复 | `continuityAutoRepair` 默认开；设置页勾选 |
| P0-7 | 版本 | 全仓 `0.12.0` |

### P1（记账，不阻塞 0.12 关闭）

- 续写 Composer 与 harness 完全同路径
- 真模型多章评测纳入日常可选门禁
- 按卷变化节奏（闲章/高潮章）自动调字数与场次数

---

## 4. 技术要点

新模块 `window.NOVEL_CRAFT`：

```js
detectOpeningKind(text) → weather|waking|walking|dialogue|expression|other
recentOpeningKinds(project, task, n=3)
lintProse({ body, prevBody, styleBible, recentKinds }) → issues[]
normalizeBeatPlan(raw) → { scenes, emotion_curve, payoffs, avoid, opening }
buildBeatBlock(plan) → string
validateDigest(project, digest, body, ctx) → { canon_facts, dropped, abandoned_loops }
buildDiscipline(project, task) → 写章末尾纪律
```

`pipeline.planChapterBeat`：失败默认告警后继续写（`chapterBeatPolicy: warn`），strict 才停。

细纲落在 `chapter.beatPlan`，重跑同任务且正文未变则复用。

---

## 5. 完成定义

- 自动连写路径会先出细纲再写；细纲出现在写前 manifest 的 used 块里。
- 无证据 / 顶撞锁定的 digest 事实不会进 `detailCanon.facts`。
- 连续两章相同开场类型会留下可看见的连续性风险。
- Node 测覆盖 craft 与 pipeline 细纲跳过/写入。
- 三套 UI 同步；版本一致。
