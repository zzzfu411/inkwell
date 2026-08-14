# 墨稿成熟化方案（Goal）

> 目标：把「能跑的原型」提升为 **可日用、可备份、可测试、可关窗不丢稿** 的本地桌面创作客户端。  
> 验收标准见文末 §7。

---

## 0. 成熟度定义

| 维度 | 原型（现状偏此） | 成熟（本目标） |
|------|------------------|----------------|
| 数据安全 | 整本抹写 md、无历史 | 增量写盘、原子写、自动快照 |
| 桌面壳 | 能开窗 | 单实例、关窗刷盘、版本号、健康检查 |
| 工程 | 单文件巨石 JS、无测试 | 模块边界清晰、核心路径有测 |
| 书库 UX | 下拉选书 | 侧栏书库、删/重命名、路径可见 |
| 外部协同 | 手动重载 | 窗口聚焦时检测 mtime 提示重载 |
| 文档 | README 片段 | 版本、变更、验收清单 |

**非目标（本轮不做）**：云同步、多用户、Electron 重写、插件市场、自动更新 CDN。

---

## 1. 工作包与优先级

### P0 — 数据与进程可靠（必须）

| ID | 项 | 完成标准 |
|----|-----|----------|
| P0-1 | 章节 **增量/安全写盘** | 先写新文件再删孤儿；禁止「先清空再写」丢稿窗口 |
| P0-2 | **原子写** 统一 | 所有 json/md 经 `.tmp` + replace |
| P0-3 | **历史快照** | 保存前可选快照；保留最近 N 份；可列可恢复 |
| P0-4 | 桌面 **单实例** | 二次启动提示并聚焦/退出，不双开写坏库 |
| P0-5 | 关窗 **强制 flush** | beforeunload + Tauri `CloseRequested` 拦截，eval 同步 `__mogaoFlushSync`；失败则提示并保持窗口 |
| P0-6 | `/api/health` 含 **version** | 前端展示版本，排障可对得上 |

### P1 — 产品体验

| ID | 项 | 完成标准 |
|----|-----|----------|
| P1-1 | 书库侧栏 | 列出 slug/标题/章数，点击切换 |
| P1-2 | 删书 / 重命名标题 | API + UI 确认 |
| P1-3 | 快捷键 | Ctrl+S 存盘、Ctrl+1..4 切模式、Ctrl+Enter 生成 |
| P1-4 | 脏标记与存盘状态 | 未存盘提示 · 存盘中 · 已同步 |
| P1-5 | 聚焦检测外部修改 | book.json mtime 变化 → 提示重载 |
| P1-6 | 空态与错误态 | 无书/离线/存盘失败可读 |

### P2 — 工程化

| ID | 项 | 完成标准 |
|----|-----|----------|
| P2-1 | `tests/test_vault.py` | 建书/存章/增量/快照/加载 绿 |
| P2-2 | `scripts/smoke.ps1` 或 `smoke.py` | 一键冒烟 |
| P2-3 | 前端抽 `library.js` | 书库操作离开 app 巨石 |
| P2-4 | CHANGELOG + 版本 `0.2.0` | 可发布说明 |
| P2-5 | README 成熟版 | 安装/日用/备份/排障 |

### P3 — 可后续（记录但不阻塞「成熟」）

- 文件 watchdog 实时同步  
- PyInstaller 单文件安装包  
- 章级 diff / 回收站  
- 多 vault 切换 UI  

---

## 2. 技术设计要点

### 2.1 安全写盘算法

```
save(slug, project):
  1. 若存在 book.json 且距上次快照 > 阈值 → snapshot()
  2. 规范化 chapters.order / 文件名
  3. 对每章 atomic_write(章节/NNN-title.md)
  4. 删除「当前 keep 集合之外」的旧 md（孤儿清理）
  5. atomic 写策划/关系/记忆/锁定镜像
  6. atomic 写 book.json
  7. 更新 library.json
```

### 2.2 快照

```
vault/books/<slug>/.history/
  20260328-153045/
    book.json          # 足够恢复
    meta.json          # reason, chapterCount
```

保留 `HISTORY_KEEP=20`；恢复 = 拷回 book.json 再 load（章节 md 从 book 重放）。

### 2.3 单实例

```
vault/.desktop.lock  → {pid, port, startedAt}
```

启动时若 pid 仍存活且 health ok → 退出并尝试 focus（Windows）。

### 2.4 外部修改

```
GET /api/books/{slug}/meta → { mtime, chapterCount, path }
```

窗口 `focus` 时对比，若 mtime 更新且本地无脏 → 自动静默重载；若脏 → 提示三选一。

---

## 3. 执行顺序（Goal）

1. 本文档落地  
2. P0 server 写盘/快照/health  
3. P0 desktop 单实例 + 关窗  
4. P1 API 扩展 + library.js + UI  
5. P1 快捷键/脏标记/focus  
6. P2 测试与文档  
7. 跑测试 + 冒烟，对照 §7 勾选  

---

## 4. 风险

| 风险 | 缓解 |
|------|------|
| 改写盘逻辑回归丢稿 | 单测 + 先快照再写 |
| 巨石 app.js 难拆 | 只抽 library/keyboard，不一次重写全部 |
| WebView 存储与浏览器分裂 | 文档写明以 vault 为准 |
| 快照占盘 | 限额 20 + 只存 book.json |

---

## 5. 版本规划

- **0.1.x** — vault + 桌面窗（已有）  
- **0.2.0** — 本成熟化 Goal（可靠写盘 + UX + 测试）  
- **0.3.x** — 监视/安装包/章历史 UI（后续）  

---

## 6. 目录（成熟后）

```text
novel-writer/
  desktop.py / server.py / requirements.txt
  js: app / api / vault / store / library / pipeline / context / prompts / config
  tests/test_vault.py
  scripts/smoke.py
  MATURITY.md  PLAN.md  CHANGELOG.md  README.md
  vault/   (运行时，gitignore books)
```

---

## 7. 验收清单（Goal Done）

- [x] 新书创建后磁盘出现完整目录树  
- [x] 连续写 3 章，章节 md 不丢、无「先空后满」可观测丢稿（先写后删孤儿 + 单测）  
- [x] 手动改某章 md 后聚焦客户端有提示或自动重载（mtime 检测）  
- [x] Ctrl+S 立即落盘，状态栏显示已同步  
- [x] 二次启动桌面客户端不会双开服务写库（`.desktop.lock`）  
- [x] 关窗前稿件在 vault 中可见（Tauri `CloseRequested` + prevent_close + 同步 `__mogaoFlushSync`；失败保持窗口）  
- [x] `python tests/test_vault.py` 通过  
- [x] README 可指导新人 5 分钟开写  
- [x] 版本号 0.2.0 展示在 UI  

**Goal 状态：0.2.0 已落地。** 后续 P3（watchdog / 安装包）不阻塞成熟日用。
