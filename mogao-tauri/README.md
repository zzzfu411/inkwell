# Inkwell（墨稿）· Tauri 客户端

**Inkwell** 是墨稿的英文产品名：用 **Rust + Tauri 2** 打造的本地小说工作室。  
内嵌 Axum HTTP，复用 `../novel-writer` 前端。

**定位**：本地优先的「**AI 连写创作** + **叙事关系分析**」一体化工作台（vault 一书一夹；分析可切章分块、暂停续跑、图谱筛选/档案/时间线）。

## 0.11 报馆稿纸与关系星图

写作页是朱丝栏稿纸。人物关系与分析页用可点选星图，不再把 Mermaid 源码当主视图。

## 0.10 墨色编辑台与连续性闭环

每次调用 `gemini-3.6-flash` 都可以是全新无状态请求。Inkwell 会从当前书目的持久化记忆装配写前上下文，并在生成后执行：

`Retrieve → Write → Continuity Review → Optional Local Repair → Handoff → Reindex`

记忆包括类型化 Canon、钩子生命周期、连续性风险、多实体状态、时间线、风格圣经、章摘要和历史正文 RAG。写前 manifest 会记录 token/字符预算、裁剪块、Canon 选择及 RAG 命中。

| 语言 | 名称 |
|------|------|
| English | **Inkwell** |
| 中文 | **墨稿** |

## 环境

- Rust stable（`rustc` / `cargo`）
- Node.js + npm（Tauri CLI）
- Windows：WebView2（系统通常自带）

## 开发运行

```bat
cd mogao-tauri
npm install
npm run tauri dev
```

会启动窗口，加载 `http://127.0.0.1:<随机端口>/`，静态页来自同级 `novel-writer/`。  
书库默认：`mogao-tauri/vault/`（可用环境变量 `MOGAO_VAULT` 覆盖）。

## 发布构建（推荐）

```bat
cd mogao-tauri
build-release.bat
```

会：

1. 同步 `../novel-writer` 前端 → `release/ui`
2. 运行版本/UI/Rust/Node/Python 完整 CI 门禁
3. `cargo build --release`
4. 输出 `release/Inkwell.exe` + `ui/` + `manifest.json`（EXE/UI SHA-256）+ 说明

正式发布默认要求 `mogao-tauri` 与 `novel-writer` 两个仓库均为干净工作树。开发过程中如需验证未提交改动，可显式运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -AllowDirty
```

该模式不会伪装成正式发布：`manifest.json` 会记录两个仓库的 `dirty=true`、可发布源码改动计数与完整源树哈希；`release`、`target`、`ui-embed`、测试输出和缓存不会污染该计数。

本地 CI：

```bat
powershell -File scripts\ci.ps1
```

无外置 `ui/` 时，二进制会尝试使用 **编译期嵌入的 ui-embed**。

Release 的设置与默认书库位于用户可写目录 `%LOCALAPPDATA%\Inkwell\`；Debug 仍使用源码目录。API Key 不写入设置 JSON：Windows 正式客户端通过当前用户绑定的 DPAPI 密文 `%LOCALAPPDATA%\Inkwell\api-key.dpapi` 保存，并会在首次加载时迁移旧版 JSON 明文。旧版设置文件仍保留用于非密钥配置回滚，请在确认迁移后妥善处理可能含旧密钥的历史副本。

## 与 novel-writer 关系

| | `novel-writer` | `mogao-tauri` |
|--|----------------|---------------|
| 角色 | 前端 UI + 可选 Python 调试 | **正式桌面客户端 Inkwell** |
| 后端 | （调试用）server.py | Rust vault + axum |
| 启动 | 浏览器 / start-desktop.bat | **Inkwell.exe** / `npm run tauri dev` |

**Python `novel-writer/server.py` 为 DEBUG ONLY**（无 token、能力落后），请勿当事生产后端。  
正式请只用本目录 **Inkwell.exe**。

API 仍为 `/api/health`、`/api/books/...` 等；会话需 `X-Mogao-Token`（由客户端注入）。
