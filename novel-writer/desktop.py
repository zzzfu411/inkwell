#!/usr/bin/env python3
"""Inkwell（墨稿）· Python 桌面调试壳 — DEBUG ONLY

⚠️ 非正式发行。请使用 mogao-tauri/release/Inkwell.exe。
本文件仅便于开发时用 pywebview 调试 novel-writer 前端。

- 单实例锁（陈旧锁自动清理）
- 端口占用可回退到随机端口
- 关窗必停服务、清锁
- 无控制台时错误用 MessageBox 提示
"""
from __future__ import annotations

import atexit
import json
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path


def _runtime_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


ROOT = _runtime_root()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
_SRC = Path(__file__).resolve().parent if not getattr(sys, "frozen", False) else ROOT
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

import server as mogao_server  # noqa: E402

LOCK_FILE = mogao_server.VAULT / ".desktop.lock"
_httpd = None
_bind_port = mogao_server.PORT


def _msg(title: str, text: str, error: bool = False) -> None:
    try:
        if sys.platform.startswith("win"):
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, text, title, 0x10 if error else 0x40)
            return
    except Exception:
        pass
    try:
        print(f"{title}: {text}")
    except Exception:
        pass


def _out(msg: str = "") -> None:
    try:
        print(msg)
    except Exception:
        pass


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int) -> int:
    if _port_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform.startswith("win"):
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)) == 0:
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait_health(port: int, timeout: float = 8.0) -> bool:
    import urllib.request

    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.12)
    return False


def _read_lock() -> dict | None:
    try:
        if LOCK_FILE.exists():
            return json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _write_lock(port: int, owned_server: bool) -> None:
    mogao_server.ensure_vault()
    data = {
        "pid": os.getpid(),
        "port": port,
        "startedAt": int(time.time() * 1000),
        "ownedServer": owned_server,
        "version": mogao_server.VERSION,
    }
    tmp = LOCK_FILE.with_suffix(".lock.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(LOCK_FILE)


def _clear_lock(force: bool = False) -> None:
    """force=True 时无论 pid 是否匹配都删除（用于陈旧锁）。"""
    try:
        if not LOCK_FILE.exists():
            return
        if force:
            LOCK_FILE.unlink(missing_ok=True)
            return
        cur = _read_lock()
        if not cur or int(cur.get("pid") or 0) == os.getpid():
            LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        try:
            LOCK_FILE.unlink(missing_ok=True)
        except Exception:
            pass


def acquire_single_instance() -> bool:
    """True=可以启动；False=已有存活实例。"""
    mogao_server.ensure_vault()
    cur = _read_lock()
    if not cur:
        return True

    pid = int(cur.get("pid") or 0)
    port = int(cur.get("port") or mogao_server.PORT)

    # 进程已死 → 陈旧锁
    if pid == os.getpid():
        return True
    if not _pid_alive(pid):
        _out(f"[mogao] 清除陈旧锁 (dead pid={pid})")
        _clear_lock(force=True)
        return True

    # 进程活着但 health 不通 → 僵尸，清锁抢启动
    if not _wait_health(port, 1.2):
        _out(f"[mogao] 锁进程无响应，清除锁 (pid={pid})")
        _clear_lock(force=True)
        return True

    # 真·已在运行
    _msg(
        "墨稿 · 单实例",
        f"墨稿已在运行（PID {pid}）。\n请切换到现有窗口，或结束该进程后再开。",
        error=False,
    )
    return False


def start_backend(port: int):
    global _httpd, _bind_port
    # 临时改 server 监听端口
    mogao_server.PORT = port
    _bind_port = port

    httpd = mogao_server.create_httpd()

    def run():
        try:
            httpd.serve_forever()
        except Exception:
            traceback.print_exc()

    t = threading.Thread(target=run, name="mogao-http", daemon=True)
    t.start()
    if not _wait_health(port, 8.0):
        try:
            httpd.shutdown()
        except Exception:
            pass
        raise RuntimeError(f"书库服务启动失败（端口 {port} 无 health 响应）")
    _httpd = httpd
    return t, httpd


def shutdown_backend() -> None:
    global _httpd
    httpd = _httpd
    _httpd = None
    if httpd is not None:
        try:
            httpd.shutdown()
        except Exception:
            pass
        try:
            httpd.server_close()
        except Exception:
            pass
    _clear_lock(force=False)
    # 若仍残留自己的锁，强制清
    cur = _read_lock()
    if cur and int(cur.get("pid") or 0) == os.getpid():
        _clear_lock(force=True)


def main() -> None:
    global _bind_port
    atexit.register(shutdown_backend)

    _out()
    _out(f"  墨稿 · 桌面客户端  v{mogao_server.VERSION}")
    _out(f"  书库  {mogao_server.VAULT}")
    if getattr(sys, "frozen", False):
        _out(f"  程序  {sys.executable}")
    _out()

    try:
        if not acquire_single_instance():
            sys.exit(0)

        port = _pick_port(mogao_server.PORT)
        if port != mogao_server.PORT:
            _out(f"[mogao] 默认端口占用，改用 {port}")

        _thread, httpd = start_backend(port)
        _write_lock(port, owned_server=True)

        url = f"http://127.0.0.1:{port}/?desktop=1&v={mogao_server.VERSION}"
        _out(f"  UI    {url}")

        try:
            import webview
        except ImportError:
            import subprocess

            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "pywebview>=5.0"],
                cwd=str(ROOT),
            )
            import webview

        class Api:
            def reveal(self, path: str = "") -> dict:
                try:
                    mogao_server.reveal_path(path or str(mogao_server.VAULT))
                    return {"ok": True}
                except Exception as e:
                    return {"ok": False, "error": str(e)}

            def vault_path(self) -> str:
                return str(mogao_server.VAULT)

            def open_vault(self) -> dict:
                return self.reveal(str(mogao_server.BOOKS))

            def version(self) -> str:
                return mogao_server.VERSION

            def ping(self) -> dict:
                return {"ok": True, "version": mogao_server.VERSION, "pid": os.getpid(), "port": _bind_port}

        api = Api()
        window = webview.create_window(
            title=f"墨稿  v{mogao_server.VERSION}",
            url=url,
            width=1480,
            height=940,
            min_size=(1100, 700),
            background_color="#12100e",
            text_select=True,
            confirm_close=False,  # 避免关闭流程卡死导致锁不释放
            js_api=api,
        )

        def on_loaded():
            try:
                window.set_title(f"墨稿 · 书稿工作区  v{mogao_server.VERSION}")
            except Exception:
                pass

        def on_closing():
            try:
                window.evaluate_js(
                    """(function(){ try { if (window.__mogaoFlushSync) window.__mogaoFlushSync(); } catch(e) {} return true; })()"""
                )
            except Exception:
                pass
            # 尽早停服务，避免关窗后端口/锁残留
            shutdown_backend()
            return True

        try:
            window.events.loaded += on_loaded
            window.events.closing += on_closing
        except Exception:
            pass

        webview.start(debug=False, http_server=False)
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc()
        _msg("墨稿启动失败", f"{e}\n\n若反复失败：删除 vault\\.desktop.lock 后再试。", error=True)
        shutdown_backend()
        sys.exit(1)
    finally:
        shutdown_backend()
        _out("墨稿已退出")


if __name__ == "__main__":
    main()
