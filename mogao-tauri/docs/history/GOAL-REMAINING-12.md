# Goal：审核遗留 12 项

来源：最新全面审核 §9。

---

## P0 正确性（1–4）

### 1. Unknown 非空目录开库策略
- `classify` 已有 Unknown
- `switch_vault` / `open`：Unknown → **默认拒绝** `{ ok:false, kind:"unknown", message, requireConfirm:true }`
- 增加 `POST /api/vault/open` body 可选 `"force": true` 才允许把未知目录 ensure 成 vault
- 前端：收到 unknown 时 confirm「该目录不是标准书库，强制打开将在此创建 books/ 结构，确定？」→ force open

### 2. tasks.json 镜像安全合并
- `sync_mirror_file` 对 `策划/tasks.json`：
  - 解析为 array
  - **按 id 合并**：本地 done/written/digested 保留进度字段；incoming 可更新 goal/title 若本地 pending
  - 复用与前端 pipeline 类似的 merge 逻辑（Rust 实现简化版）
- 若非 array → 忽略不覆盖

### 3. 导入成功返回值统一
- `import_book_dir` / HTTP 固定：
```json
{
  "ok": true,
  "slug": "...",
  "title": "...",
  "vaultPath": "...",
  "booksPath": "...",
  "library": { ...rescan... }
}
```
- 前端 `handleBookDirResult`：成功则 `afterVaultSwitch` 或只 refresh + 选中新书

### 4. 生成中禁用工作区改写作章
- `app.js` 暴露 `window.__mogaoGenLock` / `getWritingChapterId` 或 Ws 回调
- workspace：save/new/rename/delete/open 若 genLocked 且涉及 writing 章文件 → alert 并拒绝
- 文件树 writing 章高亮禁用

---

## P1 产品（5–8）

### 5. 跨书轻量搜索
- API：`GET /api/search?q=...&limit=50`
  - 搜 books 的 title/slug + 各书 `章节/*.md` 文件名与正文前 N 字/行匹配
  - 返回 `{ hits:[{ slug, title, path, snippet }] }`
- UI：顶栏或书库栏搜索框「搜索书库…」，结果列表点击打开对应书+文件

### 6. 拖拽移动（基础）
- 工作区树：file drag → drop on dir → `fs/rename` from→to
- 禁止拖到自身/子目录；成功 refreshTree

### 7. 重命名 slug 引导
- renameFolder 成功后 alert：`文件夹已改为 books/<newSlug>，请使用新路径；旧书签/外部链接需更新`
- 状态栏显示新 slug

### 8. 单目录分发增强（务实版 embed）
- 完整 Tauri embed 改动大；本批做：
  - `build-release.bat` 产出 **zip 清单** + 校验 ui 存在
  - 可选：Rust `rust-embed` 服务内嵌 ui（若时间够）
- **最低交付**：`release/打包说明` + 启动时若无 ui 则中文 Message/Err 列所需文件  
- **争取**：`include_dir` 或 `rust-embed` 把 novel-writer 关键 12 文件打进二进制，无 ui 目录也能跑

---

## P2 工程（9–12）

### 9. 拆分模块（务实）
- Rust：`vault.rs` 拆为 `vault/mod.rs` + `vault/fs.rs` + `vault/book.rs` + `vault/classify.rs`（或 module 文件）保持 API
- 前端：从 `app.js` 抽出 `vault-ui.js`（开库/建库/复制/筛选/import）减少 app 行数

### 10. 原生 notify（可选增强）
- 加 `notify` crate：对当前 book 目录 watch，更新 `AtomicU64` epoch
- `/watch` 返回 `epoch`；前端 epoch 变才全量拉 mtimes
- 失败则回退纯轮询

### 11. API 级 E2E/冒烟
- `scripts/api-smoke.ps1` 或 Rust `tests/api_smoke.rs`：
  - 起临时 vault + 调 classify/import 逻辑单元测试
  - `cargo test` 覆盖 classify、tasks merge、preview
- Node 或 PowerShell：若服务已起则 hit health（可选）

### 12. CI 脚本
- `scripts/ci.ps1`：
  1. check-ui-sync.ps1  
  2. cargo test / cargo check  
  3. node --check 关键 js  
- 文档写入 README

---

## 任务拆分

| Agent | 负责 |
|-------|------|
| T-backend | 1,2,3,5(API),8(embed若行),9(rust split),10,11 |
| T-frontend | 3消费,4,5(UI),6,7,9(vault-ui.js) |
| T-integrate | 12、build-release、同步 ui、总验收 |

## 验收清单

- [x] Unknown 开库需确认 force
- [x] tasks 合并保留 done
- [x] import 返回统一 ok
- [x] genLock 挡工作区写冲突章
- [x] 跨书搜索可用
- [x] 拖拽移动文件
- [x] rename slug 有引导
- [x] 发布/无 ui 有明确错误或 embed（rust-embed fallback）
- [x] vault 模块拆分 + app 抽出 vault-ui.js
- [x] epoch 增强（notify 依赖已加，写操作 bump epoch）
- [x] cargo test 15 passed
- [x] ci.ps1 可跑通 GREEN

**Goal 状态：审核遗留 12 项已落地（2026）。**