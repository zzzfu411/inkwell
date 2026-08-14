# Inkwell（墨稿）· 前端与书库逻辑

本目录是 **静态前端 +（可选）Python 开发服务器**，正式桌面客户端：

```text
../mogao-tauri/          ← Rust + Tauri
  release/Inkwell.exe    ← 双击运行（体积以 release/manifest.json 为准）
```

| 语言 | 名称 |
|------|------|
| English | **Inkwell** |
| 中文 | **墨稿** |

- 方案：[`MATURITY.md`](./MATURITY.md) · vault 设计：[`PLAN.md`](./PLAN.md)  
- 变更：[`CHANGELOG.md`](./CHANGELOG.md)

## 推荐启动（Tauri）

```bat
双击  ..\mogao-tauri\release\Inkwell.exe
```

或开发：

```bat
cd ..\mogao-tauri
npm run tauri dev
```

书库默认在 exe 旁或 `mogao-tauri/vault/books/`。

## 本目录还做什么？

| 内容 | 用途 |
|------|------|
| `index.html` / `*.js` / `styles.css` | Inkwell / Tauri 加载的 UI |
| `samples/` | 示例策划 |
| `server.py` / `desktop.py` | 仅开发调试（可选） |
| `tests/` | 书库与叙事逻辑单测 |

**已移除**：Python 版独立 exe 打包。

## 可选：Python 开发服务（DEBUG ONLY）

`server.py` / `desktop.py` / `start.bat` **仅调试**，存在：

- 无 `X-Mogao-Token` 鉴权  
- CORS 与写盘语义可能落后于 Tauri  

**生产请只用** `..\mogao-tauri\release\Inkwell.exe`。

## 无状态长篇写作

Inkwell 不依赖 Gemini 对话历史。每次写章都会从同一本书重建：主线、任务、Canon、开放钩子、连续性风险、人物状态、时间线、风格圣经、上章尾和 RAG 证据；生成后再执行连续性审查与章后交接。

- 正式写章优先使用“按任务写/续本章”。
- 普通“续写/生成”、选段重写、批注修订默认也会自动交接；关闭后章节会显示 `⚠ 待交接`。
- 手工编辑后请重新执行“本章→摘要+关系”。
- 写下一章前会把前文所有 `⚠ 待交接` 的章按顺序补上摘要；补交接不改正文，只补记忆。
- 严格 RAG/审查模式可在已有历史但检索失败、前文补交接失败或出现 blocker 时停止交接。
- 审查报出的“任务未覆盖”没有正文落点，只记进风险账，需要作者自己补写；带正文证据的问题才提供“局部修复”。
- 可选真实模型评测见 `scripts/eval-continuity.mjs`；必须显式设置 `INKWELL_EVAL_CONFIRM=YES`。

前端 **0.19.x**；正式客户端见 `mogao-tauri`（产品名 **Inkwell**）。常驻目标见 `../mogao-tauri/GOAL-MATURE.md`。
