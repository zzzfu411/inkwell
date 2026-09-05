# Goal：Inkwell 稳定化、长篇化与可发布性修复

## 0. Goal 定义

### 0.1 目标

在不丢失现有用户稿件、不回退当前 RAG/Harness/叙事分析能力的前提下，完成以下闭环：

1. **唯一写权威**：章节正文以 `章节/*.md` 为权威；工作区、写章台和 `book.json` 不再互相盲目覆盖。
2. **长篇可保存**：整本请求不被 Axum 默认 2 MiB 限制阻断；运行时 RAG 索引不进入 `book.json` 和 localStorage。
3. **分析可恢复**：每块 extraction、graph、meta 原子落盘；退出/崩溃后能从磁盘续跑且不会漏合并或重复计数。
4. **本地安全**：设置写入无竞态；安装版使用用户可写目录；文件 API 防 symlink/junction 越界；Markdown 不执行原始 HTML。
5. **可复现发布**：源码、内嵌 UI、release UI、正式 EXE 由同一清单生成并通过 hash/版本门禁。

### 0.2 不变量

- 不删除、清空或移动现有 `vault/`、`release/` 与用户未提交源码。
- 未显式设置 `clearChapters: true` 时，任何整本保存都不得删除未知章节文件。
- 外部编辑器产生的新文件或较新修改必须被保留，并在响应中给出可见警告。
- RAG、分析缓存损坏时允许重建，但不得影响正文和策划数据。
- 所有迁移均向后兼容旧 `book.json`、旧 `mogao-settings.json` 和旧 `rag-index.json`。

### 0.3 当前基线

- `mogao-tauri` 与 `novel-writer` 为两个独立 Git 仓；工作树均有未提交改动。
- 当前回归：Rust 34/34、Node 16/16、Python 9/9，通过。
- 当前正式 `release/Inkwell.exe` 与 `target/release/mogao-tauri.exe` hash 不一致。
- 当前十章样例完整 RAG 运行时索引约 0.98 MiB，已接近 Axum 2 MiB 默认 JSON 上限。

---

## 1. P0：章节写权威与稿件安全

### S1.1 工作区 Markdown 解析

**问题**：工作区编辑器持有包含 YAML front matter 的完整 Markdown，`mergeWorkspaceIntoProject` 却将完整文本写入 `chapter.body`；Rust 随后再次生成 front matter。

**实现**：

- 在 `novel-writer/app.js` 增加纯函数 `chapterBodyFromMarkdown(text)`。
- 仅当 `Ws.isDirty()` 为 true、打开路径属于 `章节/*.md` 时执行工作区→工程合并。
- 匹配章节后只写正文，不把 front matter 放入 `body`。
- merge 失败时维持“只保存文件、不 PUT 整本”的保护策略。
- 将解析函数暴露给测试，不依赖 DOM。

**验收**：

- 带 front matter 的章节经“工作区编辑→切写章台→整本保存”后只有一层 front matter。
- 工作区未修改时，后台保存不得改变任意章节 body。
- 工作区打开 A 章、写章台修改 B 章时，A/B 均保持正确。

### S1.2 外部修改保护

**问题**：整本保存会删除 incoming `chapters` 中不存在的 `.md`，且可能覆盖外部编辑器的新版本。

**实现**：

- `Vault::load_book` 与磁盘章节加载结果增加 `_fileMtime`。
- 保存已有章节时比较目标文件 mtime 与 incoming `updatedAt/_fileMtime`：磁盘明显更新且正文不同则保留磁盘版。
- 未被 incoming 引用的 `.md` 默认保留并合并回返回项目。
- 仅 `clearChapters: true` 允许清空；未来显式删除单章走文件 API，不依赖 orphan cleanup。
- 标题改名时根据稳定 `_file` 身份迁移旧文件，避免留下重复文件。
- 保存响应返回 `saveWarnings`，前端在状态栏提示外部冲突/保留文件。

**验收**：

- 外部新增章节后整本保存不删除该文件。
- 外部较新修改不会被旧内存覆盖。
- 应用内修改的较新正文可正常覆盖旧磁盘文件。
- 标题改名只保留新文件名，正文不变。

---

## 2. P0：长篇保存与 RAG 生命周期

### S2.1 请求体与错误契约

- 对 `PUT /api/books/{slug}`、迁移和分析写入设置明确上限；整本保存临时上限 64 MiB。
- 其他普通 JSON API 保持较小默认限制。
- 413/JSON rejection 返回结构化中文错误，前端展示具体原因。
- 增加 >2 MiB API/序列化回归。

### S2.2 RAG 运行时/持久化分离

- 运行时索引：`docs + _tf + inverted + docLen`，只存在内存。
- 持久化索引：`version + builtAt + _sig + docs`，只存在 `记忆/rag-index.json`。
- 写 `book.json` 前移除 `ragIndex`、`_lastRag` 等运行时缓存，仅保留 `ragIndexMeta`。
- localStorage `slimForCache` 同样移除运行时索引。
- `load_book` 读取 `rag-index.json`；前端首次检索时按需重建 inverted。

### S2.3 内容签名

- 旧签名“章节长度列表”替换为基于文档 id/type/text 的确定性内容 hash。
- 正文同长度改写、设定同数量替换时必须触发重建。
- 签名包含索引 schema 版本，算法升级可自然失效。

**验收**：

- 十章样例保存后的 `book.json` 不包含 `inverted/_tf`。
- 重启后可从 sidecar 恢复并检索。
- 同长度正文变更导致 `_sig` 改变。
- localStorage 序列化不包含完整 RAG 索引。

---

## 3. P0：分析 checkpoint 与跨重启续跑

### S3.1 分析文件布局

```text
分析/
  meta.json              # 状态、源 hash、模型、chunk 参数、完成/失败块
  graph.json             # 当前分析累计图
  chapters.json          # 固定切块边界，续跑不得重新漂移
  extractions/<id>.json  # 每块抽取结果
  report.md
```

### S3.2 checkpoint 事务

- Runner 新增 `hooks.writeCheckpoint(payload)`。
- 每一块无论成功或失败，都在进度推进后 await checkpoint。
- 成功块先写 extraction，再写 graph，最后写 meta；meta 最后写作为提交标记。
- checkpoint 失败不得伪装为分析完成，应进入 `persistence_error`。
- AbortError 携带并落盘当前 result。

### S3.3 恢复

- 进入分析页时读取 `meta.json`、`chapters.json`、`graph.json` 与 extraction 列表。
- “续跑”必须校验 `sourceHash/chunkSize/overlap/model`；不匹配则要求重新开始。
- 续跑使用磁盘累计 graph 和 extraction 数组，不从空 graph 跳过已完成块。
- “重新开始”显式清理旧 extraction/checkpoint，但不清理正文或关系主图。

**验收**：

- 完成第 N 块后终止进程，重启从 N+1 开始。
- 已完成块不会重复增加 occurrence。
- 修改分析源后旧 checkpoint 被拒绝续跑。
- checkpoint 写失败时 UI 明确报错，不显示“分析完成”。

---

## 4. P1：设置、路径与本地安全

### S4.1 设置目录与迁移

- Debug：继续使用源码目录设置，便于开发。
- Release：Windows 使用 `%APPDATA%/com.yeux.mogao/mogao-settings.json`。
- 默认书库使用用户 Documents 下的 `Inkwell`，`MOGAO_VAULT` 仍可覆盖。
- 新设置不存在时读取 exe 旁/旧源码目录设置，并在下一次保存迁移到新位置。
- 不再用父目录名 `debug/release` 判断运行模式，避免编译机绝对路径泄漏进发行行为。

### S4.2 设置并发

- 设置模块提供单一 `update_settings`，锁住 read-modify-write 全过程。
- `/api/settings` 不再在锁外 load 后覆盖。
- 保持临时文件+替换的原子写策略。

### S4.3 路径 jail

- 对不存在目标，canonicalize 最近存在的父目录。
- 任一父级 symlink/junction 指向书目录外时拒绝创建、改名或写入。
- 增加可用平台上的 symlink/junction 测试；无权限时明确 skip。

### S4.4 Markdown 与 CSP

- pulldown-cmark 遍历事件时将 Raw HTML 转为普通文本/移除，禁止依赖正则识别 HTML 语法。
- Markdown link/image 的危险 scheme 在事件层中和。
- 保留后处理作为第二道防线。
- Tauri 增加有限 CSP：脚本/对象/框架仅 self/none，连接允许用户配置的 http/https API。

---

## 5. P1：性能与快照

- 自动保存仍防抖，但只写变更章节和元数据。
- 自动快照增加最短时间间隔；手动、恢复前快照不受限制。
- 快照中保留可恢复的 `book.json`，避免复制运行时 RAG 索引。
- `rescan_library` 不在每次无关文件写入后重复执行；需要时显式刷新。
- 大目录搜索/扫描后续迁移到 `spawn_blocking`，避免阻塞 Tokio worker。

**验收**：连续输入停顿不会在数秒内制造 20 份全量快照；十万字工程自动保存无明显冻结。

---

## 6. P1：版本、仓库与发布

### S6.1 版本统一

- 本轮统一为 `0.8.0`。
- 同步 `package.json`、`Cargo.toml`、`tauri.conf.json`、Rust `VERSION`、前端 `NOVEL_APP_VERSION` 与 Python Debug 版本。
- CI 增加版本一致性检查。

### S6.2 单一 UI 清单

- `rag.js`、`harness.js` 纳入 release 同步和最终组装。
- build/check/release 使用一致文件清单；至少通过脚本门禁验证完全相同。
- 缺少任一关键文件时构建失败，不静默生成残缺 embed。

### S6.3 Git 卫生

- `.gitignore` 排除 `mogao-settings.json`、`vault/books/`、`vault/library.json`、构建和 release 二进制。
- 不在本 Goal 中删除用户工作区实际稿件；历史 Git 清理另做显式备份任务。
- 发布产物生成 `release/manifest.json`，记录版本、构建时间、EXE/UI SHA-256。

### S6.4 CI

CI 必须运行：

1. UI 同步和关键文件完整性；
2. 版本一致性；
3. `cargo fmt --check`、`cargo check`、`cargo test`；
4. 全部 Node `*.mjs` 功能测试，而非仅语法；
5. Python Debug 回归；
6. 大载荷/RAG/写权威/分析恢复集成测试；
7. release 后 EXE hash 和 UI hash 验证。

---

## 7. 文件级实施矩阵

| 文件 | 主要修改 |
|---|---|
| `novel-writer/app.js` | front matter 合并、保存 payload、冲突提示 |
| `novel-writer/workspace.js` | dirty/mtime 契约、工作区保存联动 |
| `novel-writer/rag.js` | 内容 hash、持久化索引恢复、运行时分离 |
| `novel-writer/store.js` | localStorage 去运行时缓存 |
| `novel-writer/analysis-runner.js` | checkpoint、source hash、恢复一致性 |
| `novel-writer/analyze-ui.js` | checkpoint IO、启动加载、可靠续跑 |
| `mogao-tauri/src-tauri/src/vault/book.rs` | 外部修改保护、未知章节保留、RAG sidecar |
| `mogao-tauri/src-tauri/src/vault/fs_ops.rs` | 最近存在父目录 canonical jail |
| `mogao-tauri/src-tauri/src/http_api.rs` | 请求上限、设置事务、错误契约 |
| `mogao-tauri/src-tauri/src/settings.rs` | AppData、旧设置迁移、并发锁 |
| `mogao-tauri/src-tauri/src/preview.rs` | 事件级 Raw HTML/URL 安全 |
| `build-release.bat` / `scripts/*.ps1` | 完整清单、全测试、manifest、hash |

---

## 8. 回滚与数据迁移

- 修改前不批量改写现有 Vault；首次正常保存才按新格式写 sidecar。
- 新版 `book.json` 仍能被旧版读取，旧版只会忽略新增 `_fileMtime/saveWarnings`。
- RAG sidecar 缺失或 schema 不匹配时直接重建，不影响正文。
- 分析 checkpoint 不兼容时要求“重新开始分析”，不自动删除旧报告；清理前保留 report。
- 设置迁移先读旧文件，成功写新文件后仍不删除旧文件，便于人工回退。

---

## 9. Done 标准

- [x] P0 写权威集成测试全部通过，无重复 front matter/跨章覆盖/外部文件删除。
- [x] >2 MiB 工程可保存，`book.json`/localStorage 无完整 RAG 运行时索引。
- [x] 分析跨重启续跑，不漏图、不重复 occurrence，源变更能阻断错误续跑。
- [x] Release 设置写入用户目录；设置并发测试通过。
- [x] symlink/junction 越界与 Raw HTML 执行被阻断。
- [x] Rust、Node、Python、集成测试全部进入 CI 并通过。
- [x] `release/Inkwell.exe`、兼容 EXE 与 target hash 一致。
- [x] release UI、ui-embed、novel-writer 关键文件 hash 一致。
- [x] 版本统一、manifest 完整、使用说明与实现一致。

## 10. 执行结果（2026-08-10）

- 版本：`0.8.0`。
- CI：Rust `47/47`、Node `22/22`、Python `9/9`。
- 大载荷：HTTP 集成测试成功保存超过 Axum 默认 2 MiB 的 3 MiB 项目。
- UI：`ui-files.txt` 中 21 个资产在源码、`release/ui`、`ui-embed` 间 SHA-256 一致。
- Release：三个 EXE 均为 `10,132,480` bytes，SHA-256 均为 `68e025b29d323c79af83dd84ae37ee2fe47f1ce96009ccf85af3e442c9d1a106`。
- 发布清单：`release/manifest.json` 已生成并由 `scripts/verify-release.ps1` 验证通过。
