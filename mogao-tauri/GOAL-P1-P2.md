# Goal P1 + P2

承接 P0（开库/建库/文件 CRUD/快照恢复）。本批：

## P1

| ID | 项 | 完成标准 |
|----|-----|----------|
| P1-1 | 设置/顶栏展示并**一键复制**绝对 vault 路径 | 按钮复制成功提示 |
| P1-2 | **一键发布包**：exe + ui 同步脚本 | `build-release.ps1` / `.bat` 产出可拷贝目录 |
| P1-3 | 构建时 **novel-writer → release/ui 强制同步** | 打包脚本内置，防旧 UI |
| P1-4 | 工作区保存 md **必 reload 工程内存** | 写章台与工作区不再互相覆盖 |

## P2

| ID | 项 | 完成标准 |
|----|-----|----------|
| P2-1 | 更好 Markdown 预览 | 服务端 `pulldown-cmark` 或前端增强；表格/代码/列表可用 |
| P2-2 | 更可靠文件监视 | 缩短轮询 + 可选 notify；或 `/api/books/{slug}/watch` 增量 + 前端 focus 立即 poll |
| P2-3 | 设置页展示 vault/引擎/版本 | 设置 modal 增加只读信息与开库入口 |

## 任务拆分

| Agent | 任务 |
|-------|------|
| T-backend | pulldown-cmark 预览 API；watch 增强；settings 字段补全 |
| T-frontend | 复制路径、预览对接、保存后 reload、设置页、watch 更勤 |
| T-release | build-release 脚本、同步 ui、README、验收 |

## 验收清单

- [x] 复制 vault 路径可用
- [x] `build-release.bat` 生成完整 release 目录
- [x] 工作区存章节后写章台正文一致（onBookMutated + 切入写章台 reload）
- [x] 预览支持表格、代码块、引用（pulldown-cmark API）
- [x] 外部改文件后更快反映（800ms 轮询 + focus 立即 poll）

**Goal 状态：P1+P2 已落地。** 发布：`build-release.bat` → `release/墨稿-Tauri.exe` + `ui/`