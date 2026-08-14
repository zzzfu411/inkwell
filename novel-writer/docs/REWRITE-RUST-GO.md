# 客户端技术路线

## 现状

正式桌面客户端已采用 **Rust + Tauri**（`../mogao-tauri`）。

| 方案 | 状态 |
|------|------|
| Tauri / Rust | **当前正式方案**，~8MB |
| Python + PyInstaller exe | **已废弃并清理** |
| Go + Wails | 备选，未实施 |

## 为何不用 Python exe

- Anaconda 误打包曾到 300MB+  
- 精简后仍约 12MB，且关窗/锁/端口问题更多  
- 与「类 Obsidian 本地客户端」长期方向不如 Tauri 清晰  

## 开发时 Python 目录

`novel-writer/` 仅保留：

- 前端静态资源（Tauri 直接引用）  
- 可选 `server.py` 做浏览器调试  
- 单测  

不再提供 `build-exe.bat` / `墨稿.exe`。
