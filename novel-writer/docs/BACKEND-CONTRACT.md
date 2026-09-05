# Inkwell HTTP 后端合同 v2

正式语义权威是 Rust/Axum；Python `server.py` 只是在浏览器开发期实现同一份**核心存储合同**的调试适配器。当前可执行 fixture 位于 `tests/fixtures/http-contract/v2.json`；v1 文件保留供历史追溯。两个真实 HTTP 进程使用同一个 runner。

运行：

```powershell
cd ..\mogao-tauri
.\scripts\backend-contract.ps1
.\scripts\rust-backend-e2e.ps1
```

`inkwell-http` 是无窗口测试入口，但直接调用桌面客户端使用的 `http_api::start_server`，不复制路由或存储实现。Rust 浏览器 E2E 覆盖“加载 → 编辑 → 保存 → 外部改稿 → 冲突 → 采用磁盘 → 重载恢复”，并作为 `scripts/ci.ps1` 的固定阶段运行。

## v2 核心面

| 能力 | 方法与路径 | 共同合同 |
|---|---|---|
| 健康 | `GET /api/health` | `ok/app/version/engine/epoch/auth` |
| 书库 | `GET /api/library` | 书目数组、更新时间与 vault 路径 |
| 新建 | `POST /api/books` | 200；返回完整新书对象 |
| 加载/重载 | `GET /api/books/{slug}`、`POST .../reload` | 完整书对象带 `_bookRevision`；章节带 `_file/_fileMtime/_fileRevision/_bodyLoaded` |
| 保存 | `PUT /api/books/{slug}` | `bookRevision/saveWarnings/chapterBaselines/epoch`；重复保存不得制造假冲突 |
| 文件 | `GET/PUT .../file` | UTF-8 内容、mtime、size、revision；章节 Markdown 回写书对象 |
| 观察 | `GET .../watch` | `files/scannedAt/pollHintMs/epoch` |
| 删除 | `DELETE /api/books/{slug}` | `ok/epoch` |

普通失败统一返回：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST | NOT_FOUND | CONFLICT | UNAUTHORIZED | FORBIDDEN | PAYLOAD_TOO_LARGE | INTERNAL_ERROR",
    "message": "author-facing diagnostic",
    "status": 400
  }
}
```

全书加载携带 `_bookRevision`，保存必须原样提交；它校验 `book.json` 元数据（排除章节、运行时字段及更新时间）。元数据变化返回 HTTP 409 `BOOK_CONFLICT`，在任何写入前拒绝。保存成功后采纳响应的 `bookRevision`，不能自行获取新版本后重发旧设定。

章节加载携带 `_fileRevision`（原始 UTF-8 文件 SHA-256）、`_bodyLoaded: true`。正文不同且内容版本变化时，保留磁盘正文，在 200 响应中返回 `saveWarnings[].kind = "externalConflict"`，由现有双版本界面裁决。时间戳仅用于观察与显示。成功章通过 `chapterBaselines[].revision` 更新基线；冲突章不自动更新。主动清空已完整装载的正文可以保存；slim 缓存必须标记 `_bodyLoaded: false`，缺失正文继续受保护。

文件 GET 返回 `revision`；PUT 必须提交 `expectedRevision`。新文件使用字面值 `missing`；过期文件返回 HTTP 409 `FILE_CONFLICT`；全书或文件缺失必需版本返回 HTTP 428 `REVISION_REQUIRED`。工作区保存、离开保存和桌面同步关窗均携带基线。取消冲突处理保留草稿与 dirty 状态。分析输出在任务开始时收集版本，不能在提交前悄悄刷新基线。

本次 v2 是保存安全修复，旧客户端应升级；缺少版本的旧 HTTP 写入会被明确拒绝。当前保护范围是共享后端操作及章节文件外部编辑；直接编辑生成的元数据镜像需要通过导入/同步流程，不能假设它等同于更新 book.json。

## 有意差异（debug compatibility table）

| 面 | Rust 正式后端 | Python 调试后端 | 决策 |
|---|---|---|---|
| API 鉴权 | 除 health 外要求会话 token/cookie | 只接受同端口 loopback Origin；CLI 无 Origin 可访问 | 安全差异保留；合同只在 Rust 验证 401 |
| 密钥 | Windows DPAPI，密钥不进 settings JSON | 调试配置，不构成正式凭据边界 | Python 禁止用于生产 |
| Vault 选择/导入 | `/api/vault/open|create|import-book` + Tauri 目录对话框 | 不提供 | formal-only |
| Markdown 预览 | Rust sanitizer | 前端根据 health 的 engine 使用本地安全渲染，不请求缺失 API | formal-only |
| 文件夹 create/mkdir/rename | 完整正式 API | 仅核心 read/write/delete | formal-only；不得让 Python 定义新语义 |
| 桌面 reveal | 原生正式行为 | 调试辅助行为 | 不纳入跨后端合同 |

## Python 截止策略

Python 核心存储兼容层只维护到 **0.20.x（含）**。本次审计修复同步到 v2，避免调试服务继续静默覆盖正文；不增加正式能力。**0.21.0 起**，前端/浏览器默认测试只允许使用 Rust HTTP，Python 退化为可选静态页与模型代理。
