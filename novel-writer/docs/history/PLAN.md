# 墨稿 · 本地书库（Vault）改造计划

## 0. 现状：内容存在哪？

| 数据 | 位置 | 说明 |
|------|------|------|
| 全书状态（含正文） | 浏览器 **localStorage** | key = `mogao_auto_novel_v2` |
| API 设置 | localStorage `mogao_novel_cfg_v1` | baseUrl / key / 模型 |
| 「导出」按钮 | 下载一个 `.md` 到「下载」目录 | **含策划 + 正文**（`## 正文` 下按章输出） |

痛点：

1. 不关浏览器就还在，清站点数据 / 换浏览器 = **全丢**  
2. 不是文件夹，不能用 Obsidian / VS Code / git 管章节  
3. 「＋新书」只是内存里多一个 project，没有磁盘实体  
4. 用户体感「导出只有策划」——多半是点导出时章节已被串章覆盖，或没往下翻到 `## 正文`

## 1. 目标

做成 **类 Obsidian 的本地小说工坊**：

- 书库根目录 `vault/`（可配置）  
- **＋新书** → 在 `vault/books/<书名>/` 建完整文件夹  
- 每章独立 `.md`，可用外部编辑器改，墨稿重载即读  
- 策划 / 任务 / 关系 / 记忆 / 锁定 均为可检视文件  
- 前端仍是现有 UI；`server.py` 提供本地 FS API  
- 本仓库 `novel-writer` 初始化为 **git 仓库**（书库 vault 默认不强制进 git，可自选）

## 2. 目录约定（每本书）

```text
vault/
  library.json                 # 书目索引 { books:[{slug,title,path,updatedAt}] }
  books/
    红莲渡鹤归/
      book.json                # 完整工程状态（权威元数据 + 章节索引）
      README.md                # 给人看的书卡
      章节/
        001-药奴名册.md        # YAML frontmatter + 正文
        002-....md
      策划/
        pitch.md
        world.json
        spine.json
        tasks.json
      关系/
        graph.json
      记忆/
        digests.json           # memoryRoll
      锁定/
        locks.json
```

### 章节 Markdown 格式

```markdown
---
id: "uuid"
taskId: "t001"
title: "第1章 药奴名册"
order: 1
updatedAt: 1710000000000
---

正文从这里开始……
```

**读写规则**

- 保存：写 `book.json` + 同步所有 `章节/*.md` + 策划/关系等镜像文件  
- 加载：读 `book.json`，再以 `章节/*.md` **覆盖**对应 `body`（外部改稿优先）  
- 删除书：删整个文件夹

## 3. 后端 API（`server.py`）

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/health` | 健康检查 + vault 绝对路径 |
| GET | `/api/library` | 书目列表 |
| POST | `/api/books` | 新书 `{title, idea?}` → 建夹 |
| GET | `/api/books/{slug}` | 加载全书（合并 md） |
| PUT | `/api/books/{slug}` | 保存全书到磁盘 |
| DELETE | `/api/books/{slug}` | 删除书文件夹 |
| POST | `/api/books/{slug}/reload` | 仅从磁盘重读（拾取外部修改） |
| POST | `/api/migrate` | 把 localStorage 整包迁入 vault |
| POST | `/api/reveal` | Windows：打开资源管理器到某路径 |

静态资源仍由同一服务提供；可选 `/v1` 反代不变。

## 4. 前端改造

| 文件 | 变更 |
|------|------|
| `vault.js` | 新建：封装上述 API |
| `store.js` | localStorage 作**缓存/离线兜底**；权威源改为 vault |
| `app.js` | 启动拉书库；save 防抖写盘；新书/切换/导出/迁移/打开文件夹 |
| `index.html` | 书库路径、打开目录、从浏览器迁移、重新扫描 |
| `start.bat` | 提示 vault 路径 |
| `README.md` | 文档更新 |

保存策略：

- 内存 state 立即更新（UI 流畅）  
- localStorage 同步写（崩溃兜底）  
- 磁盘 **400ms 防抖** 批量 PUT（避免每字一次 IO）  
- 切章 / 切书 / 退出写章台 → **立即 flush**

## 5. 迁移

启动时：

1. 若 vault 已有书 → 以 vault 为准  
2. 若 vault 空且 localStorage 有数据 → 提示「一键迁入本地书库」  
3. 迁入后 localStorage 仍保留缓存，但 UI 标注「已存盘：vault/books/…」

## 6. 实施顺序

1. `PLAN.md` + git init（本文件）  
2. `server.py` vault 引擎 + API  
3. `vault.js` + `store.js`  
4. `app.js` / `index.html` / `styles.css`  
5. `.gitignore`、`README`、初始 commit  

## 7. 非目标（本轮不做）

- 完整 Electron / 系统托盘  
- 多 vault 切换 UI（可用环境变量 `MOGAO_VAULT`）  
- 实时文件监视（靠「重新扫描」按钮）  
- 云同步  
