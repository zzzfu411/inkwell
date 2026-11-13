# Inkwell（墨稿）

基于 Rust 与 Tauri 2 构建的本地优先（Local-First）AI 长篇小说写作工作台（`v0.19.0`）：串联大纲策划、基于磁盘记忆的无状态写章、连续性审查、章后交接与叙事关系分析。

[English](README.md) · 简体中文

## 核心能力

- **一书一夹本地书库** — 作品以纯文件目录落盘（`章节/*.md`、`book.json` 与设定资料），可直接用资源管理器或 Obsidian 打开，写入采用内容 SHA-256 与版本号校验并保留冲突双方。
- **无状态写章闭环** — 每次写章从磁盘记忆按预算装配上下文，不依赖不断膨胀的单条聊天历史：`Retrieve → 细纲 → Write → 连续性审查 → 可选局部修复 → 章后交接 → RAG 再索引`。
- **本地混合检索** — 内置 BM25 词法检索并支持可选 Embeddings，按上下文预算召回前文片段、人物状态与未回收伏笔。
- **叙事结构分析** — 支持既有长稿切章分块、人物档案提取、关系星图可视化与事件时间线梳理。
- **OpenAI 兼容接口与 DPAPI 凭据保护** — 接入用户自行配置的 OpenAI 兼容模型地址；Windows 正式客户端通过当前用户绑定的 DPAPI 加密存储 API Key（不写入明文 JSON），并支持导出不含正文与密钥的脱敏运行诊断。

## 快速开始

环境要求：**Windows（WebView2）**、**Rust stable**、**Node.js 24+** 与 **Python 3**（用于完整 CI 及可选调试后端）。

```powershell
git clone https://github.com/zzzfu411/inkwell.git
cd inkwell\mogao-tauri
npm ci
npm run tauri dev
```

若仅调试前端界面，也可启动 Python 兼容调试服（遵守共享 HTTP 契约 v2，但不具备正式客户端的会话鉴权与 DPAPI 密钥存储，仅限开发调试）：

```powershell
cd novel-writer
python server.py
```

## 构建与验证

```powershell
cd mogao-tauri
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ci.ps1  # Rust、Node、Python、HTTP v2 契约、浏览器 E2E、性能与视觉回归
.\build-release.bat                                                   # 干净工作树构建 -> release/Inkwell.exe + ui/ + manifest.json
npm run verify:release                                                # 按自身 SHA-256 清单校验已密封的发布包
```

开发期脏工作树验证可运行 `.\scripts\build-release.ps1 -AllowDirty -Candidate`（产物输出至 `output/candidate-release/`，不覆盖 `release/`）。分发 Windows 正式客户端时，`Inkwell.exe` 需与同目录 `ui/` 一并提供。

## 目录结构

构建与 UI 同步脚本假定以下两个子目录保持同级布局：

```text
inkwell/
├── novel-writer/  前端权威源、纯领域/应用层逻辑与 Python 调试后端
└── mogao-tauri/   Rust HTTP/Vault 正式后端、Tauri 2 桌面壳、UI 构建镜像与发布脚本
```

## 文档与许可

- [mogao-tauri/使用说明.md](mogao-tauri/使用说明.md) — 桌面客户端日常使用指南
- [novel-writer/docs/ARCHITECTURE.md](novel-writer/docs/ARCHITECTURE.md) 与 [FRONTEND-ARCHITECTURE.md](novel-writer/docs/FRONTEND-ARCHITECTURE.md) — 分层架构与持久化权威边界
- [novel-writer/docs/RAG-HARNESS.md](novel-writer/docs/RAG-HARNESS.md) 与 [BACKEND-CONTRACT.md](novel-writer/docs/BACKEND-CONTRACT.md) — 上下文装配、连续性审查与共享 HTTP v2 契约
- [mogao-tauri/docs/RELEASE.md](mogao-tauri/docs/RELEASE.md) 与 [novel-writer/CHANGELOG.md](novel-writer/CHANGELOG.md) — 不可变发布事务手册与变更记录

MIT 许可，详见 [LICENSE](LICENSE)。
