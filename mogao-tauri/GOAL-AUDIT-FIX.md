# Goal：审核遗留问题修复（P0–P2）

来源：全面审核报告 §8 / §10。

---

## P0（必须，体验坑）

### P0-1 开库目录类型探测与纠偏

**问题**：用户可能选「单书目录」（含 `章节/`）而非 vault 根（含 `books/`）。

**后端**

- `Vault::classify_path(path) -> VaultKind`
  - `VaultRoot`：已有 `books/` 或 `library.json`
  - `BookDir`：有 `章节/` 或 `book.json`，无上级 books 语义
  - `Empty`：空目录或不存在（可创建）
  - `Unknown`：其它
- `open` / `create` / Tauri pick：
  - `BookDir`：返回 `{ ok:false, kind:"bookDir", suggestion, parent? }` 或自动升一级若 parent 已是 vault
  - 可选：`importBookIntoVault` — 把单书目录 copy/move 进当前 vault（本批做 **检测+明确错误/建议**，自动导入为 P0-1b）
- P0-1b：若 kind=BookDir 且用户确认，API `POST /api/vault/import-book { path }` 将目录导入为 `books/<slug>/`

**前端**

- 打开库失败/特殊 kind 时弹清晰中文说明
- 若返回 `canImport`，询问是否「导入为当前库中的一本书」

### P0-2 修正 pick_and_* / afterVaultSwitch 返回值

**问题**：`{ ok:false, cancelled:true }` 被 `if (res)` 当成成功。

**前端**

```js
function isVaultSwitchOk(res) {
  return res && res.ok !== false && !res.cancelled;
}
```

- `pickOpenVault` / `pickCreateVault` 全面使用
- Tauri invoke 与 HTTP 统一

**后端**

- 保证 open/create/switch 成功体含 `"ok": true`
- 取消仅 cancelled，不写 settings

### P0-3 镜像文件写回 book 字段

**问题**：工作区改 `策划/pitch.md` 等不更新 `book.json` 内 pitch 等。

**后端** `write_file` 后：

| 路径 | 同步 |
|------|------|
| `策划/pitch.md` | 尽力解析卖点/意向 → pitch, ideaInput（简单启发式或整文件作 idea 附录） |
| `策划/world.json` | world |
| `策划/spine.json` | spine |
| `策划/tasks.json` | tasks（慎：可覆盖进度；仅当 JSON 合法时） |
| `关系/graph.json` | graph |
| `记忆/digests.json` | memoryRoll |
| `锁定/locks.json` | locks |
| `章节/*.md` | 已有 sync_chapter_md |

**前端**：保存上述路径后也 `onBookMutated`。

---

## P1（产品缺口）

### P1-1 重命名书可选改文件夹 slug

- API：`POST /api/books/{slug}/rename` 扩展 `{ title, renameFolder?: bool }`
- 若 renameFolder：物理 rename 目录 + 更新 library；冲突则 409
- UI：重命名时 confirm「是否同时修改文件夹名？」

### P1-2 工作区右键菜单（基础）

- 树节点右键：新建笔记/文件夹、重命名、删除、在资源管理器打开（若有 reveal file）
- 复用现有 fs API，不重复逻辑

### P1-3 快照 UX 强化

- 列表显示 reason、时间、章节数
- 恢复成功后明确提示「已恢复到 xxx，并已备份恢复前状态」
- 空列表引导「先点创建快照」

### P1-4 书库轻量搜索（跨书标题）

- 顶栏或书库栏输入框：按 title/slug 过滤 `libraryBooks`（前端过滤即可，不必新 API）

---

## P2（工程，本批做可落地部分）

### P2-1 发布校验脚本

- `scripts/check-ui-sync.ps1`：对比 novel-writer 与 release/ui 关键文件 hash，不一致 exit 1
- `build-release.bat` 已同步；文档写明必须跑脚本

### P2-2 不做本批（记入后续）

- app.js / vault.rs 大拆分（工作量大，单开 Goal）
- 原生 notify
- 完整 E2E
- 单文件 embed ui

---

## 任务拆分

| ID | Agent | 内容 |
|----|-------|------|
| T1 | backend | P0-1/1b、P0-3、P1-1 renameFolder、返回 ok |
| T2 | frontend | P0-2、开库纠偏 UI、P0-3 notify、P1-2/3/4 |
| T3 | integrate | check-ui-sync、build-release、cargo、提交 |

## 验收

- [x] 选单书目录有明确提示或可导入
- [x] 取消选夹不会切换 vault
- [x] 改 pitch.md / 镜像 json 后同步 book.json 字段
- [x] 书可改文件夹名（renameFolder）
- [x] 右键菜单可用
- [x] 快照恢复文案清晰
- [x] 书库标题过滤
- [x] cargo check + node --check + release 同步

**Goal 状态：审核遗留 P0–P1 + 部分 P2 已落地。**