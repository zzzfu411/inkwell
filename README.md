# Inkwell（墨稿）

本地优先的 **AI 长篇写作工作台**：策划 → 锁主线 → 自动/半自动连写 → 章后交接 → 叙事关系分析。

| 语言 | 名称 |
|------|------|
| English | **Inkwell** |
| 中文 | **墨稿** |

当前版本 **0.19.0**。Windows 正式客户端是 `mogao-tauri/release/Inkwell.exe`（需与同目录 `ui/` 一起分发）。

## 它做什么

- **一书一夹** 书库，可对接资源管理器 / Obsidian
- 每次写章都是无状态请求：从磁盘记忆装配上下文，不依赖同一条聊天历史
- 写章闭环：`Retrieve → 细纲 → Write → 连续性审查 → 可选局部修复 → 交接 → RAG 再索引`
- 本地混合检索（BM25，可选 embeddings）
- 叙事分析：切章分块、关系星图、人物档案、时间线
- Windows 正式客户端用 DPAPI 保存 API Key，不把密钥写进 JSON

模型走 **OpenAI 兼容** 接口。请在设置里填写你自己的 Base URL 与 Key。

## 目录

```text
inkwell/
  novel-writer/    前端权威源 + Python 调试服（DEBUG ONLY）
  mogao-tauri/     Rust + Tauri 2 正式桌面客户端
```

构建脚本假定这两个目录是兄弟关系，请保持这个布局。

## 开发

需要：Rust stable、Node.js 24、Python 3、Windows WebView2。

```bat
cd mogao-tauri
npm ci
npm run tauri dev
```

调试前端也可以：

```bat
cd novel-writer
python server.py
```

`server.py` 是调试后端，核心读写遵守共享 HTTP 契约 v2；正式运行使用 Rust/Tauri 的会话鉴权与凭据存储。

## 发布

```bat
cd mogao-tauri
build-release.bat
```

会同步前端、跑完整 CI，输出 `release/Inkwell.exe` + `ui/` + `manifest.json`。

本地 CI：

```bat
powershell -File mogao-tauri\scripts\ci.ps1
```

根目录的 GitHub Actions 使用同一个提交检出两个子目录，不需要兄弟仓库 token 或配对 SHA 变量。完整 CI 包括 Rust、Node、Python、共享后端契约、真实浏览器流程、性能预算及视觉回归。工作区开发候选可使用 `mogao-tauri/scripts/build-release.ps1 -AllowDirty -Candidate`，输出到独立的 `output/candidate-release/`。

## 文档

- [使用说明](mogao-tauri/使用说明.md)
- [前端架构](novel-writer/docs/FRONTEND-ARCHITECTURE.md)
- [RAG / Harness](novel-writer/docs/RAG-HARNESS.md)
- [变更记录](novel-writer/CHANGELOG.md)
- [2026-09 成熟化修复与验收](docs/MATURITY-2026-09.md)

## 许可

MIT。见 [LICENSE](LICENSE)。
