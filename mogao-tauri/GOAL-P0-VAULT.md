# Goal P0：Vault 生命周期 + 文件生命周期 + 快照恢复

## 目标

对齐「类 Obsidian」最低可用集：

1. **选择已有文件夹作为 Vault**
2. **新建 Vault（到指定目录）**
3. **工作区：新建 / 重命名 / 删除 md 与文件夹**
4. **快照列表 + 恢复**

## 架构约定

- Vault 根目录结构：
  ```text
  <vault>/
    library.json
    books/<slug>/...
    .mogao-config.json   # 可选：记录元数据
  ```
- 配置文件（记住上次 vault）：  
  `%APPDATA%/com.yeux.mogao/settings.json` 或 exe 旁 `mogao-settings.json`  
  字段：`{ "vaultPath": "D:/..." }`
- 热切换 Vault：替换 `AppState.vault`（`Arc<RwLock<Vault>>`），前端重新 boot 书库。
- 文件 API 一律相对 **当前书** `books/<slug>/`（与现树一致）；库级操作走新 API。

## API 增补

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/settings` | `{ vaultPath, version }` |
| POST | `/api/vault/open` | body `{ path }` 打开已有目录为 vault |
| POST | `/api/vault/create` | body `{ path, name? }` 在 path 下建标准 vault |
| POST | `/api/vault/pick-open` | **Tauri 命令** 调系统选夹后 open（可选，UI 也可先 invoke） |
| POST | `/api/books/{slug}/fs/mkdir` | `{ path }` 相对书根 |
| POST | `/api/books/{slug}/fs/create` | `{ path, content? }` 新建文件 |
| POST | `/api/books/{slug}/fs/rename` | `{ from, to }` |
| DELETE | `/api/books/{slug}/fs` | query/body `path` |
| POST | `/api/books/{slug}/restore` | `{ id }` 恢复快照 |

## UI

- 顶栏/书库栏：
  - 显示 **绝对 vault 路径**（可截断 + title 全路径）
  - 按钮：**打开库** / **新建库**
- 工作区文件树右键或工具条：
  - 新建笔记、新建文件夹、重命名、删除
- 快照：侧栏或弹层列出 `.history`，一键恢复（确认）

## 验收

- [x] 打开任意空/已有目录为 vault，书库列表刷新（打开库… + API）
- [x] 新建 vault 到用户选的路径（新建库… + API）
- [x] 重启客户端记住上次 vault（mogao-settings.json）
- [x] 工作区新建 md → 树出现 → 可编辑保存
- [x] 重命名/删除文件生效
- [x] 快照创建后可从列表恢复
- [x] `cargo check` / 前端无语法错误

**Goal 状态：P0 已落地**（2026 集成）。请用 `release/墨稿-Tauri.exe` + 最新 `ui/` 手测。

## 任务拆分

| ID | 负责 | 内容 |
|----|------|------|
| T1 | Agent-backend | Rust：settings、vault open/create、fs CRUD、restore、AppState RwLock |
| T2 | Agent-frontend | UI：开库/建库、树操作、快照恢复、vault.js API |
| T3 | Agent-integrate | 同步 release/ui、README、冒烟、修冲突 |
