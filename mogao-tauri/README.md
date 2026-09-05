# Inkwell（墨稿）· Rust/Tauri client

Inkwell 是本地优先的长篇写作工作台。此仓库提供正式 Rust HTTP/Vault 后端、Tauri 桌面壳、嵌入式 canonical UI 镜像、完整 CI 和不可变发布事务。唯一 UI 源位于同级 `novel-writer/`。

## 当前文档入口

- [当前架构](../novel-writer/docs/ARCHITECTURE.md)
- [当前工程审计与 Phase 0–7 执行记录](../novel-writer/docs/ENGINEERING-AUDIT-2026-09.md)
- [不可变发布手册](./docs/RELEASE.md)

以上三处是当前入口。旧 GOAL 文档已归档，不参与当前实现与验收。

## 开发

环境：Rust stable、Node.js/npm、Windows WebView2；完整 CI 还需要 Python debug compatibility runtime。

```powershell
npm install
npm run tauri dev
```

完整门禁：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ci.ps1
```

它执行版本与 UI 清单、release helper、ESLint、Rust、Node/领域覆盖率、文章质量 fixture、20/100/400 章性能预算、Python、共享后端合同、正式 Rust 浏览器 E2E、布局和视觉基线。

## 发布

正式构建只接受两个干净仓库：

```powershell
.\build-release.bat
```

开发中的脏树验证必须显式使用 `scripts/build-release.ps1 -AllowDirty`；产物 manifest 会保留 dirty provenance，不会冒充正式发布。现有 release 可随时用以下命令按自身 manifest 独立校验：

```powershell
npm run verify:release
```

## Runtime boundaries

- Rust/Tauri 是正式后端；`novel-writer/server.py` 仅保留冻结的调试合同兼容。
- API 会话使用 `X-Mogao-Token`；正式 API Key 由当前 Windows 用户绑定的 DPAPI 密文保存。
- 默认 Vault 位于应用可写目录，可用 `MOGAO_VAULT` 覆盖开发路径。
- `src-tauri/ui-embed/` 是 canonical UI 的原子构建镜像；`release/` 只由完整发布事务替换。
- Runtime diagnostics 保持本地、可显式导出，并通过字段白名单排除正文、提示词、密钥、URL 与原始异常文本。
