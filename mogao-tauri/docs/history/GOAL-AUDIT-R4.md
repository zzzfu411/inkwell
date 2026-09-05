# Goal：第四轮审核修复（P0 / P1 / P2）

来源：2026-08 全面审核报告 §7。  
目标：堵毁盘与跨域面、闭合生成事务、补一致性与工程门禁。

---

## P0 正确性 / 安全 / 丢稿（必须全绿）

### P0-1 本机 API 防跨域滥用
- **问题**：CORS `Allow-Origin: *` + loopback → 恶意页可读写书库
- **交付**：
  - 启动生成随机 `api_token`（uuid），注入 `AppState`
  - 所有 `/api/*` 中间件校验 `X-Mogao-Token`（或 `Authorization: Bearer`）
  - 静态页：在 `index.html` 注入或通过 `/api/bootstrap` **免 token 一次**返回 token？→ **更好**：HTML 由服务端在首屏注入  
    **务实方案**：
    1. `GET /` 仍静态；`GET /api/health` **无需 token**（仅 ok/version/port 提示）
    2. 其余 `/api/*` 需 header `X-Mogao-Token: <token>`
    3. 启动时把 token 写入 `exe旁 .mogao-session.json` 或通过 Tauri 启动 URL `?token=`
    4. 前端 `vault.js` / `api` 基座：从 `URLSearchParams` 或 `meta` 读 token，所有 req 带 header
  - CORS：改为 **不使用 Any**；同源 WebView 不需要 CORS。可直接 **移除 CorsLayer** 或仅允许 `null`/本 origin
- **测**：无 token 调 library → 401；有 token → 200

### P0-2 slug 白名单（拒 `.` 等）
- `book_dir`：拒 empty、`.`、`..`、以 `.` 开头、含 `/` `\`、Windows 保留名（CON/NUL/PRN 等可选）
- 单测：`book_dir(".")` / `".."` 失败；正常中文 slug 成功
- `delete_book` 依赖 book_dir，自然安全

### P0-3 save_book 空 chapters 不抹盘
- 若 body **缺少** `chapters` 字段 → **不修改**磁盘章节目录（不删不写章文件）
- 若 `chapters` 为 **空数组**：
  - 默认：**拒绝** 或 **不删现有 md**（推荐：不删，仅更新 book.json 其它字段 + 日志）
  - 仅当 `clearChapters: true` 或 `project._clearChapters` 才清空
- 单测：有 2 章 md，PUT chapters:[] → 文件仍在

### P0-4 生成事务：禁 mutate reload
- `onBookMutated`：若 `genLocked` / `__mogaoGen.locked` → **直接 return**（可 setStatus 提示）
- workspace `pollWatch`：gen 中 **不** `notifyBookMutated`（可仍刷新树只读）

### P0-5 生成事务：禁切模式 + 写章台只读
- `switchMode` 首行：`if (guardGen("切换模式")) return`
- `setGenLock(true)`：`#manuscript`、`#chapterTitle` 设 `readOnly`；false 时恢复
- CSS：`body.gen-locked .mode { pointer-events:none; opacity:.5 }`（停止按钮除外）
- 侧栏：`body.gen-locked .lib-main, body.gen-locked .library { pointer-events:none }`

### P0-6 默认 API Key 清空
- `config.js`：`apiKey: ""`；注释说明在设置中填写
- 同步进 release/ui、ui-embed（build 自动）

### P0-7 关窗先存工作区
- `__mogaoFlushSync`：先 `Ws?.saveCurrent?.()`（若有 dirty），再 PUT book
- 尽力同步（XHR 同步写文件 API 若太重可只 saveCurrent + saveAll + PUT book）

---

## P1 可靠与体验

### P1-1 per-book / 全局写串行
- 务实：`Vault` 内 `std::sync::Mutex<()>` 或 `parking_lot`，`save_book`/`write_file`/`fs_*`/`delete` 入口 lock
- 或 http 层对写操作 `vault.write().await`（会阻塞 switch；可接受短时）
- **推荐**：fs/book 写方法内部 `BOOK_IO: Mutex<()>` 全局串行写（实现简单）

### P1-2 save_book tasks merge
- `save_book` 写 `tasks.json` / `project.tasks` 前：读磁盘现有 tasks，`merge_tasks_preserving_progress`
- 单测：磁盘 done + 内存 pending → 结果 done

### P1-3 reveal 仅 vault 内
- `reveal(path)`：canonicalize 后必须 `starts_with(vault.root)`
- 单测：vault 外路径 bail

### P1-4 预览消毒
- `preview.rs`：渲染后 strip `<script`、`on\w+=` 或禁用 raw HTML  
- pulldown-cmark 默认会输出 raw HTML；增加后处理：regex 移除 script/iframe/on*  
- 单测：`"<script>alert(1)</script>"` 不出现在输出可执行形式

### P1-5 启动脏路径不静默丢 settings
- `open_vault_for_startup` 回退时：**不** `save_vault_path(default)` 覆盖；或写入 `lastVaultError` + 仅 memory 用 default
- settings API 返回 `vaultWarning` 字符串
- 前端 boot 若有 warning → alert/status

### P1-6 空库 bootstrap
- `afterVaultSwitch` / `bootFromVault`：若 library 空且 projects 空 → 自动 `createBook` 或引导
- 修复：`if (!state.projects.length) ensureEmptyVaultBook()`

### P1-7 switchMode dirty 真正取消
- confirm 为 false → `return`（不切 mode）

### P1-8 侧栏 gen lock 持久
- CSS `body.gen-locked` 禁点 library/mode（见 P0-5）
- `renderSidebar` 时若 locked 给按钮 disabled

### P1-9 btnRewriteSel 进 genLock
- 与 generate 同路径 `setGenLock(true, ch.id)` / finally false

### P1-10 localStorage 降级（务实）
- vault 在线时 `saveAll`：可只存 `{ activeId, projects: projects.map 精简 stub（无 chapters body）}`  
  **更稳妥最小改**：vault 在线时 projects 写入前 **截断** chapter.body 为前 0 或仅 meta（避免 5MB+）  
  **本批交付**：`saveAll` 增加 `slimForCache(state)`：chapters 只保留 id/title/order/字数，body 置空字符串；完整正文以 vault 为准
- cfg/meta 不变

### P1-11 build-release 强制门禁
- `build-release.bat` 开头调用 `check-ui-sync.ps1`（失败 exit）+ 可选 `cargo test`
- 至少 check-ui-sync

---

## P2 工程与打磨

### P2-1 safe_rel 读不建目录
- `safe_rel(rel, opts)` 或 `safe_rel_read`：read_file 不 `create_dir_all`
- write 路径才建父目录

### P2-2 health 真实探测
- `books.is_dir()` + 可写探测；失败 `ok:false`

### P2-3 搜索 per-book cap + snippet 按 char
- 每书最多 N 条 hit；snippet 用 char_indices

### P2-4 版本统一
- `package.json` version → `0.3.0` 与后端一致

### P2-5 newNote 尊重 targetDir
- `workspace.js` 新建笔记用 `targetDir()`，默认仍可章节

### P2-6 右键 reveal 文件
- 上下文菜单加「在资源管理器中显示」→ 已有 reveal API

### P2-7 单测补强
- P0-2/P0-3、reveal jail、tasks save merge、preview strip、token 401（若易测）

---

## 任务拆分

| Agent | 项 |
|-------|-----|
| T-backend | P0-1(服务端), P0-2, P0-3, P1-1, P1-2, P1-3, P1-4, P1-5, P2-1, P2-2, P2-3, P2-7 |
| T-frontend | P0-1(消费 token), P0-4, P0-5, P0-6, P0-7, P1-6..P1-10, P2-4..P2-6, styles |
| T-integrate | P1-11, ci, release, commit |

## 验收

- [x] 无 token → 401；带 token 正常（URL 注入 + X-Mogao-Token）
- [x] slug `.` 删除失败（is_valid_slug + 单测）
- [x] 空 chapters 不删 md（clearChapters 才清空）
- [x] 生成中不可切 mode / 不可 mutate reload / manuscript 只读
- [x] config 无真实 key
- [x] 关窗路径先 WS + token
- [x] save tasks merge；reveal jail；preview 消毒；IO 锁
- [x] cargo test 29 passed；ci / release 门禁

**Goal 状态：第四轮 P0/P1/P2 已落地（2026）。**
