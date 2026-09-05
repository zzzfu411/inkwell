# Inkwell（墨稿）· canonical UI

本仓库是 Inkwell 的唯一前端源、纯领域/应用层和可选 Python 调试后端。正式桌面客户端位于同级 `mogao-tauri/`，生产后端是 Rust/Tauri；`server.py` 只用于 debug compatibility。

## 当前文档入口

- [当前架构](./docs/ARCHITECTURE.md)
- [当前工程审计与 Phase 0–7 执行记录](./docs/ENGINEERING-AUDIT-2026-09.md)
- [不可变发布手册](../mogao-tauri/docs/RELEASE.md)

以上三处是当前入口。旧版路线与 GOAL 文档已归档，不参与实现决策。

## 开发运行

推荐从正式客户端启动：

```powershell
cd ..\mogao-tauri
npm install
npm run tauri dev
```

完整本地门禁：

```powershell
cd ..\mogao-tauri
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ci.ps1
```

Python 开发服务可用 `start.bat` 启动，但它没有正式客户端的会话 token、DPAPI 密钥和完整 Vault 安全边界，不得作为生产入口。

## Source-of-truth 约束

- `index.html` 显式声明静态 IIFE 脚本装配顺序。
- `mogao-tauri/ui-files.txt` 声明正式 UI 文件集。
- 日常同步只更新 `mogao-tauri/src-tauri/ui-embed/`，绝不更新 `release/`。
- Vault 是持久化权威；localStorage 仅做有界恢复。
- 新安装默认仍使用 Harness。候选整章生产引擎只有在真实模型 A/B 与人工盲评发布门通过后才可成为默认。
- 设置 → 高级可导出本地脱敏诊断；报告不含正文、提示词、密钥、URL 或原始错误消息。

当前前端版本：`0.19.x`。
