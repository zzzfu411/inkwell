# Goal 0.11 · 墨稿编辑台彻底优化

**产品**：Inkwell / 墨稿  
**版本目标**：`0.11.0`  
**状态**：执行中  
**正式源**：只改 `novel-writer/`，验收后 `sync-ui.ps1` 同步三套 UI。

---

## 0. 为什么要开这一轮

0.10 已经把「四入口 + 脉络条 + Composer + 连续性闭环 + 分析续跑」搭起来，但作者体感仍是**工具集合**，不是**编辑台**：

| 现象 | 根因 |
|------|------|
| 章节标题、正文、图谱像后台表单 | CSS 新旧两层叠在一起；故事/分析页仍是 lede + JSON + Mermaid 源码 |
| 关系图不可用 | 主视图是 `<pre>` 文本，不是可点选图 |
| 改一处怕炸 | `app.js` ~5050 行承担写章事务、故事中心、图谱、boot |
| 发不干净 | 两个仓工作树脏；`app.js` 仍有 `0.8.0` fallback |
| 长篇分析卡窗 | runner 跑在 UI 线程，无 Worker |

本 Goal 分三期。本期（0.11）先做**作者每天看见的面**和**可测的模块边界**；不重写记忆算法，不换 React。

---

## 1. 设计立场

继续「报馆夜校 / 编辑部纸墨」，再往前走一步：

1. **稿纸是第一视觉**。正文区是朱丝栏稿纸，不是带边框的 textarea。
2. **关系是星图，不是源码**。Mermaid / JSON 进高级折叠。
3. **故事页说作者语言**。禁止把「网页反代短上下文」写在主 lede。
4. **一个主操作**。每页只强调一个下一步。
5. **原生 HTML/CSS/JS**。不引入 React/Vue/打包器。ID 契约保持，事件不丢。

记忆点：打开写作页像摊开一叠毛边纸；打开人物关系像看见一群名字围坐。

---

## 2. 不变量

- 不改 vault 目录、book.json 语义、Canon / RAG / 审查 / 交接算法。
- 不覆盖用户正文；保存 / 生成锁 / 冲突双栏 / 关窗 flush 行为保持。
- API Key 仍不进 localStorage / 书稿 / 设置 JSON。
- 组件 CSS 仍只引用语义 Token（禁止在组件层写死 hex/rgba）。
- 自动化：Node / Python / Rust / 前端契约 / Playwright 布局必须绿。视觉基线随 0.11 更新。

---

## 3. 分期与完成定义

### P0 · 作者可见的编辑台（本轮必须交付）

| ID | 项 | 完成标准 |
|----|----|----------|
| P0-1 | 补齐缺失 Token | `--bg-grad-*`、`--color-border-subtle` 有定义；浅色主题无未定义变量 |
| P0-2 | 去掉死布局 | 删除仍声明 `200px` 书库栏的旧 `.shell`；顶栏第一层不再 `flex-wrap` |
| P0-3 | 稿纸 | 正文朱丝栏 + 左栏朱线；标题用 `--color-text`；对比度 ≥ 4.5:1 |
| P0-4 | 关系星图 | `graph-view.js` 渲染可点选节点/连线；故事页与分析页共用；Mermaid 进高级视图 |
| P0-5 | 故事/分析文案 | 主 lede 改为作者语言；去掉「适配网页反代」对外话术 |
| P0-6 | 版本 | 全仓 `0.11.0`；消灭 `app.js` 的 `0.8.0` fallback |

### P1 · 前端结构（本轮尽量交付，可跨提交）

| ID | 项 | 完成标准 |
|----|----|----------|
| P1-1 | 抽出 `graph-view.js` | 布局纯函数可 `node --test`；`app.js` / `analyze-ui.js` 只负责选中态 |
| P1-2 | 抽出 `write-ui.js` | 写章渲染 / Composer / 检查器离开 `app.js`；契约测试改指向新文件 |
| P1-3 | 抽出 `story-ui.js` | 策划 / 主线 / 图谱渲染离开 `app.js` |
| P1-4 | CSS 死代码 | 未使用的 `.vault-bar`、重复 `.topbar` 第一层删除或合并 |

### P2 · 正确性与性能（下一轮，本 Goal 记账）

| ID | 项 | 完成标准 |
|----|----|----------|
| P2-1 | 分析进 Worker | 切章/合图可进 Worker；UI 只收进度 |
| P2-2 | digest 本地闸 | locked Canon 冲突、自相矛盾钩子在交接前标红 |
| P2-3 | token 离开 URL | 启动改 bootstrap / invoke，query 不再长期挂 token |
| P2-4 | 干净发版 | 两仓提交后打非 dirty `Inkwell.exe` |

**0.11 可关闭条件**：P0 全绿 + P1-1 落地 + 契约/Node 测绿 + 三套 UI 同步。P1-2/P1-3 若本轮拆不完，记入下一提交，不阻塞 0.11 视觉关闭。

---

## 4. 技术设计

### 4.1 模块

```
narrative-model.js   合图 / 档案 / 轨迹（已有）
graph-view.js        布局 + DOM/SVG 渲染（新增）
analyze-ui.js        分析页选中态 → graph-view
app.js               故事图谱选中态 → graph-view（P1 后再拆 write/story）
```

`window.NOVEL_GRAPH_VIEW`：

```js
layoutNodes(nodes, { width, height }) → [{ id, x, y, degree }]
render(el, graph, { selectedId, onSelect })
```

布局：1 点居中，2 点左右，其余椭圆均匀分布；节点半径随度数；边走二次贝塞尔，避开圆心。

### 4.2 同步

新文件必须登记 `mogao-tauri/ui-files.txt`，并加入 `index.html` 脚本顺序（`narrative-model.js` 之后、`app.js` 之前）。禁止手改 `release/ui` / `ui-embed`。

### 4.3 风险

| 风险 | 缓解 |
|------|------|
| 改 CSS 打碎 Playwright 像素基线 | 更新 `visual-baselines`；布局烟测仍锁 ARIA/断点 |
| 抽模块漏掉 ID 契约 | 先抽纯渲染，事件委托留在原文件；改 `test_frontend_contract.mjs` |
| 星图人多挤成一团 | >36 节点只画度数 Top-36，其余进侧栏列表 |

---

## 5. 实施顺序

1. 写本文档（本文件）。
2. Token + 死 CSS + 稿纸 + 故事文案。
3. `graph-view.js` + 单测 + 故事/分析接入。
4. 版本 0.11.0、CHANGELOG、架构文档。
5. `node --test`、契约、按需同步 UI。
6. 若时间允许：开始拆 `write-ui.js`。

---

## 6. 非目标

- 不移植 AntV G6 / Electron / SQLite。
- 不改 Gemini 反代，不把 `gemini2api` 代理源码拉进本仓。
- 不做云同步、插件市场、自动更新。
- 不把 Python `server.py` 升为生产后端。
