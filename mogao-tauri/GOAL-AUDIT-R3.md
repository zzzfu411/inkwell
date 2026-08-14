# Goal：第三轮审核修复（12 项）

来源：对 GOAL-REMAINING-12 落地后的复核审计（2026-08）。  
上轮 12 项主路径大多已绿，本批修**半落地/真实缺口**。

---

## P0 正确性（1–4）

### 1. ui-embed 补齐 `vault-ui.js`
- **问题**：`index.html` 已引用 `vault-ui.js`，`build-release`/`check-ui-sync` 已同步，但 `build.rs` FILES 漏项 → `ui-embed/` 无此文件 → 纯 rust-embed 路径开库/搜索/导入全挂。
- **交付**：
  - `src-tauri/build.rs` FILES 加入 `vault-ui.js`
  - 重建后 `ui-embed/vault-ui.js` 存在且与 novel-writer hash 一致
  - `lib.rs` 缺 UI 报错列表加入 `vault-ui.js`

### 2. 搜索 hit 字段统一 `title`
- **问题**：后端返回 `bookTitle`，前端读 `h.title` → 列表标题常退化成 slug。
- **交付**：
  - 后端 hits 同时含 `title` 与 `bookTitle`（兼容）
  - 前端：`h.title || h.bookTitle || h.slug`
  - 单测：search 命中含 `title`

### 3. CI 校验 ui-embed 与源一致
- **问题**：`check-ui-sync.ps1` 只比 novel-writer ↔ release/ui，embed 漂移无门禁。
- **交付**：
  - `check-ui-sync.ps1` 增加可选/默认第三源：`src-tauri/ui-embed`（文件存在时比对；缺 vault-ui 即 FAIL）
  - 或：比对 `build.rs` FILES 列表 ⊇ `index.html` 的 script src
  - `ci.ps1` 继续调用，文档说明需先 `cargo build` 一次以刷新 embed 或允许「源列表完整性」静态检查

### 4. 启动 settings 脏路径不崩溃
- **问题**：`lib.rs` `Vault::open_at(settings.vaultPath)` 遇 Unknown 非空目录直接 `Err`，应用起不来。
- **交付**：
  - 启动解析：若 settings 路径 BookDir/Unknown → 打日志 + 回退 `default_vault_dir()`（或 Empty 可 force ensure）
  - 仍写入/保留 settings 可选；健康接口可带 `vaultWarning`
  - 不在无确认时把用户家目录乱 ensure 成 vault

---

## P1 产品/可靠（5–8）

### 5. epoch 前端短路 + notify 务实落地
- **问题**：`notify` crate 死依赖；写操作 bump epoch，但 workspace 轮询仍全量比 mtime；外部编辑不 bump。
- **交付（务实）**：
  - 后端：对当前 vault root 启 `notify` watcher（失败则静默），外部变更也 `bump_content_epoch`
  - `/api/books/{slug}/watch` 已有 `epoch`；前端 `pollWatch`：若 epoch 未变则跳过 keys 对比（仍定期全量防漏）
  - 若 notify 初始化失败：行为与现网一致（纯轮询）

### 6. `save_book` 章节增量写
- **问题**：每次保存重写全部 `章节/*.md` 并删「不在 keep」的文件，外部改稿/并发窗口大、IO 重。
- **交付**：
  - 写前读已有文件内容；相同则跳过 `write_text_atomic`
  - 删除孤儿：仅当文件名不在 keep **且** 无法按 frontmatter id 匹配 keep 中章节时删除
  - 保持原子写；单测：二次相同 save 不改 mtime（或内容 hash 不变）

### 7. `safe_rel` 路径穿越加固
- **问题**：`canonicalize` 失败且 `!exists` 时 `starts_with` 校验可被绕过意图路径。
- **交付**：
  - 规范化相对段：禁止 `..`、绝对前缀、空段
  - 对尚未存在的路径：用 `bdir.join(rel)` 的 component 校验全部在 book 内
  - 单测：`../x`、绝对路径拒绝

### 8. 拖拽目标同名冲突
- **问题**：`fsRename` 到已存在文件可能覆盖或模糊错误。
- **交付**：
  - 后端 `fs_rename`：若 to 已存在且非 from → 明确错误 `target exists`
  - 前端 drop：失败 alert 已有；可选预检 `tree` 是否含 to
  - 文案中文可读

---

## P2 工程（9–12）

### 9. search / import / safe_rel 单测
- `cargo test` 增加：
  - search 命中 title+slug+正文
  - import_book_dir 返回 ok/slug/library
  - safe_rel 拒绝 `..`

### 10. embed 占位不伪装完整 UI
- **问题**：novel-writer 缺失时 placeholder `index.html` 使 `has_embedded_index()==true`，可能起假壳。
- **交付**：
  - `has_embedded_index` 要求同时存在 `index.html` + `app.js`（或 `vault-ui.js`）
  - placeholder 仅 index 时启动仍走「缺 UI」硬错误（除非磁盘有 ui）

### 11. 搜索结果 UX 小增强
- 点击 openFile 失败 → `alert`/`setVaultStatus`，不只 `console.warn`
- hit 展示优先 `title`（配合 #2）

### 12. CI / 发布收口
- `ci.ps1` 跑通 GREEN
- `build-release.bat` 产出最新 exe + ui（含 vault-ui）
- README 一句：第三轮修复说明（可选）
- 提交 mogao-tauri + novel-writer

---

## 任务拆分

| Agent | 负责 |
|-------|------|
| T-backend | 1(build.rs/lib), 2(API+test), 4, 5(notify), 6, 7, 8(API), 9, 10 |
| T-frontend | 2(消费), 5(epoch), 8(可选预检), 11 |
| T-integrate | 3, 12、总验收、commit |

## 验收清单

- [x] ui-embed 含 vault-ui.js；无外置 ui 时开库 UI 可加载
- [x] 搜索结果书名正确显示（title + bookTitle）
- [x] check-ui-sync 三方 + build.rs 清单门禁
- [x] settings 脏路径可启动（回退默认库）
- [x] notify watcher + 前端 epoch 短路（每 10 次强制全量）
- [x] 相同内容 save 跳过章文件写
- [x] safe_rel 拒 `..` / ParentDir
- [x] 拖到已存在路径前后端均拦截
- [x] cargo test 19 passed
- [x] ci.ps1 GREEN + release ~9.3MB

**Goal 状态：第三轮 12 项已落地（2026）。**
