#!/usr/bin/env python3
"""Inkwell（墨稿）· Python 本地书库服务 — DEBUG ONLY

⚠️ 非正式发行路径。正式客户端请用 mogao-tauri/release/Inkwell.exe（Rust/Tauri）。

本服务仅供前端开发调试：
- API 仅接受本机同源浏览器请求
- 不提供正式客户端的会话 token 与完整安全边界
- 保存语义有回归测试，但凭据仍按调试配置文件保存
请勿当作生产后端。

- 静态前端（本目录）
- /api/*  本地 vault 文件系统（类 Obsidian）
- /v1/*   可选反代上游 OpenAI 兼容 API

环境变量:
  MOGAO_PORT=8765
  MOGAO_VAULT=<绝对或相对路径>   默认 ./vault
  MOGAO_PROXY_UPSTREAM=https://example.com/v1
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from functools import wraps
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

VERSION = "0.19.0"
PORT = int(os.environ.get("MOGAO_PORT", "8765"))
UPSTREAM = (os.environ.get("MOGAO_PROXY_UPSTREAM") or "").rstrip("/")


def _app_root() -> Path:
    """源码目录，或 PyInstaller 解包目录（静态前端）。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


def _user_data_root() -> Path:
    """可写数据目录：exe 旁，或源码旁。书库 vault 放这里。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = _app_root()
USER_DATA = _user_data_root()
VAULT = Path(os.environ.get("MOGAO_VAULT") or (USER_DATA / "vault")).expanduser().resolve()
BOOKS = VAULT / "books"
LIBRARY_FILE = VAULT / "library.json"
SETTINGS_FILE = Path(os.environ.get("MOGAO_SETTINGS") or (USER_DATA / "mogao-settings.json")).expanduser().resolve()
HISTORY_KEEP = int(os.environ.get("MOGAO_HISTORY_KEEP", "20"))
SNAPSHOT_MIN_INTERVAL_MS = int(os.environ.get("MOGAO_SNAPSHOT_INTERVAL_MS", "120000"))  # 2min
MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
WEB_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; img-src 'self' data: blob: http: https:; "
    "connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; "
    "frame-src 'none'; form-action 'none'"
)
SETTINGS_LOCK = threading.Lock()
LIBRARY_LOCK = threading.RLock()
_BOOK_LOCKS_GUARD = threading.Lock()
_BOOK_LOCKS: dict[str, threading.RLock] = {}

INVALID_FS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class RequestBodyTooLarge(ValueError):
    pass


def parse_content_length(value: str | None) -> int:
    try:
        length = int(value or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid Content-Length") from exc
    if length < 0:
        raise ValueError("invalid Content-Length")
    if length > MAX_REQUEST_BODY_BYTES:
        raise RequestBodyTooLarge(
            f"request body exceeds {MAX_REQUEST_BODY_BYTES // (1024 * 1024)} MiB limit"
        )
    return length

# slug -> last snapshot wall time
_last_snapshot_at: dict[str, int] = {}


# ─── helpers ─────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    sys.stderr.write(f"[mogao {ts}] {msg}\n")
    sys.stderr.flush()


def is_trusted_browser_origin(origin: str | None, port: int | None = None) -> bool:
    """仅允许本机同源调试页；无 Origin 的 CLI/本机工具仍可访问。"""
    if not origin:
        return True
    try:
        parsed = urlparse(origin)
        expected_port = int(port or PORT)
        host = (parsed.hostname or "").lower()
        actual_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return parsed.scheme == "http" and host in {"127.0.0.1", "localhost", "::1"} and actual_port == expected_port
    except (TypeError, ValueError):
        return False


def ensure_vault() -> None:
    with LIBRARY_LOCK:
        BOOKS.mkdir(parents=True, exist_ok=True)
        if not LIBRARY_FILE.exists():
            write_json(LIBRARY_FILE, {"version": 1, "books": [], "updatedAt": now_ms()})


def now_ms() -> int:
    return int(time.time() * 1000)


def write_text_atomic(path: Path, text: str, encoding: str = "utf-8") -> None:
    """原子写文本：先写同目录临时文件再 replace，避免半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        path.name + f".{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp"
    )
    try:
        tmp.write_text(text, encoding=encoding)
        tmp.replace(path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def write_json(path: Path, data: Any) -> None:
    write_text_atomic(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def path_is_within(base: Path, target: Path) -> bool:
    """比较解析后的完整路径；兼容 Windows 盘符大小写并拒绝跨盘。"""
    try:
        base_resolved = base.resolve()
        target_resolved = target.resolve()
        common = Path(os.path.commonpath((str(base_resolved), str(target_resolved))))
        return os.path.normcase(str(common)) == os.path.normcase(str(base_resolved))
    except (OSError, ValueError):
        return False


def book_io_lock(slug: str) -> threading.RLock:
    """同一本书的整本/单文件/快照 IO 必须串行，避免多线程请求交错落盘。"""
    key = os.path.normcase(str(book_dir(slug)))
    with _BOOK_LOCKS_GUARD:
        lock = _BOOK_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _BOOK_LOCKS[key] = lock
        return lock


def book_io_locked(fn):
    @wraps(fn)
    def wrapped(slug: str, *args, **kwargs):
        with book_io_lock(slug):
            return fn(slug, *args, **kwargs)

    return wrapped


def library_io_locked(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with LIBRARY_LOCK:
            return fn(*args, **kwargs)

    return wrapped


def load_settings() -> dict[str, Any]:
    value = read_json(SETTINGS_FILE, {})
    return value if isinstance(value, dict) else {}


def update_settings(body: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("body must be object")
    with SETTINGS_LOCK:
        settings = load_settings()
        if "clientCfg" in body:
            incoming = body.get("clientCfg")
            current = settings.get("clientCfg")
            if body.get("replaceClientCfg") or not isinstance(current, dict) or not isinstance(incoming, dict):
                settings["clientCfg"] = incoming if isinstance(incoming, dict) else {}
            else:
                settings["clientCfg"] = {**current, **incoming}
        if "uiState" in body:
            incoming = body.get("uiState")
            current = settings.get("uiState")
            if isinstance(current, dict) and isinstance(incoming, dict):
                settings["uiState"] = {**current, **incoming}
            else:
                settings["uiState"] = incoming if isinstance(incoming, dict) else {}
        write_json(SETTINGS_FILE, settings)
        return settings


def settings_payload(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    settings = settings if isinstance(settings, dict) else load_settings()
    return {
        "vaultPath": str(VAULT),
        "booksPath": str(BOOKS),
        "version": VERSION,
        "engine": "python-debug",
        "settingsFile": str(SETTINGS_FILE),
        "clientCfg": settings.get("clientCfg") if isinstance(settings.get("clientCfg"), dict) else {},
        "uiState": settings.get("uiState") if isinstance(settings.get("uiState"), dict) else {},
    }


def slugify(title: str) -> str:
    s = INVALID_FS.sub("_", (title or "").strip())
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s or "未命名")[:80]


def unique_slug(base: str) -> str:
    ensure_vault()
    slug = slugify(base)
    if not (BOOKS / slug).exists():
        return slug
    for i in range(2, 1000):
        cand = f"{slug}-{i}"
        if not (BOOKS / cand).exists():
            return cand
    return f"{slug}-{uuid.uuid4().hex[:6]}"


def reserve_unique_slug(base: str) -> str:
    """在库锁内原子占用书目录，避免并发建书拿到同一 slug。"""
    with LIBRARY_LOCK:
        slug = unique_slug(base)
        book_dir(slug).mkdir(parents=True, exist_ok=False)
        return slug


def book_dir(slug: str) -> Path:
    raw = str(slug or "")
    if (
        not raw
        or raw in {".", ".."}
        or raw != raw.strip(" .")
        or "/" in raw
        or "\\" in raw
        or "\x00" in raw
        or Path(raw).is_absolute()
    ):
        raise ValueError("invalid slug")
    p = (BOOKS / raw).resolve()
    if not path_is_within(BOOKS, p) or p == BOOKS.resolve():
        raise ValueError("invalid slug")
    return p


def safe_filename(title: str, order: int) -> str:
    base = INVALID_FS.sub("_", (title or f"第{order}章").strip()) or f"第{order}章"
    base = re.sub(r"\s+", "-", base)[:60]
    return f"{order:03d}-{base}.md"


# ─── frontmatter ─────────────────────────────────────────────────────────────

FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", re.DOTALL)


def parse_chapter_md(text: str) -> tuple[dict, str]:
    m = FM_RE.match(text or "")
    if not m:
        return {}, (text or "").strip()
    meta: dict[str, Any] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if k in ("order", "updatedAt"):
            try:
                meta[k] = int(float(v))
            except ValueError:
                meta[k] = v
        else:
            meta[k] = v
    return meta, m.group(2).lstrip("\n")


def try_int(value: Any) -> int | None:
    """Parse an int; 0 is a real value. None/''/bool/garbage → None."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def coerce_int(value: Any, default: int) -> int:
    parsed = try_int(value)
    return default if parsed is None else parsed


def dump_chapter_md(ch: dict) -> str:
    title = ch.get("title") or "未命名章"
    order = coerce_int(ch.get("order"), 0)
    lines = [
        "---",
        f'id: "{ch.get("id") or ""}"',
        f'taskId: "{ch.get("taskId") or ""}"',
        f'title: "{title.replace(chr(34), "")}"',
        f"order: {order}",
        f"updatedAt: {ch.get('updatedAt') or now_ms()}",
        "---",
        "",
        (ch.get("body") or "").rstrip() + "\n",
    ]
    return "\n".join(lines)


def load_chapter_path(path: Path, fallback_order: int, base: dict | None = None) -> dict:
    """Load one chapter markdown file with the same concurrency metadata used by Tauri."""
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_chapter_md(raw)
    chapter = dict(base or {})
    order = coerce_int(meta.get("order"), fallback_order)
    md_id = str(meta.get("id") or "").strip()
    chapter.update(
        {
            "id": md_id or chapter.get("id") or str(uuid.uuid4()),
            "taskId": meta.get("taskId") or chapter.get("taskId"),
            "title": meta.get("title") or chapter.get("title") or path.stem,
            "order": order,
            "body": body,
            "updatedAt": coerce_int(meta.get("updatedAt"), 0) or chapter.get("updatedAt") or now_ms(),
            "_file": f"章节/{path.name}",
            "_fileMtime": int(path.stat().st_mtime * 1000),
        }
    )
    return chapter


def _chapter_file_name(ch: dict | None) -> str:
    if not isinstance(ch, dict):
        return ""
    rel = str(ch.get("_file") or "").replace("\\", "/")
    if rel.startswith("章节/"):
        name = rel[len("章节/") :]
        if name and "/" not in name and name not in {".", ".."}:
            return name
    return ""


def _stored_chapter_for_file(project: dict | None, filename: str) -> dict | None:
    name = str(filename or "").replace("\\", "/")
    if not name or not isinstance(project, dict):
        return None
    for ch in project.get("chapters") or []:
        if not isinstance(ch, dict):
            continue
        if _chapter_file_name(ch) == name:
            return ch
    return None


def _index_stored_chapters(project: dict | None) -> tuple[dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_file: dict[str, dict] = {}
    for ch in (project or {}).get("chapters") or []:
        if not isinstance(ch, dict):
            continue
        copied = dict(ch)
        cid = str(ch.get("id") or "").strip()
        if cid:
            by_id[cid] = copied
        fname = _chapter_file_name(ch)
        if fname:
            by_file[fname] = copied
    return by_id, by_file


def chapter_baselines(project: dict) -> list[dict]:
    """保存后回传每章的落盘基线（文件名 + mtime）。

    客户端必须拿它刷新乐观并发的比对点：保存本身会重写章节文件、把 mtime 推新，
    基线不跟着走的话，同一次会话里第二次改同一章就会被判成「外部修改」。
    """
    rows: list[dict] = []
    for ch in project.get("chapters") or []:
        if not isinstance(ch, dict):
            continue
        rel = str(ch.get("_file") or "")
        mtime = ch.get("_fileMtime")
        if not rel or not mtime:
            continue
        rows.append({"id": ch.get("id"), "order": ch.get("order"), "file": rel, "mtime": mtime})
    return rows


# ─── book IO ─────────────────────────────────────────────────────────────────

def default_book(title: str = "新书", idea: str = "") -> dict:
    bid = str(uuid.uuid4())
    return {
        "id": bid,
        "slug": "",
        "title": title or "新书",
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "stage": "idea",
        "ideaInput": idea or title or "",
        "authorNote": "",
        "authorCastNote": "",
        "authorSpineLock": "",
        "authorForbidden": "",
        "targetChapters": 20,
        "title_candidates": [],
        "pitch": "",
        "genre": "",
        "sub_genre": "",
        "hooks": [],
        "tone": "",
        "audience": "",
        "risks": [],
        "world": None,
        "graph": {"nodes": [], "edges": [], "stats": {}},
        "cast_summary": "",
        "spine": {"logline": "", "theme": "", "spine": [], "volumes": [], "foreshadow": []},
        "tasks": [],
        "locks": {"logline": "", "forbidden": [], "mustHonor": [], "lockedFields": []},
        "memoryRoll": [],
        "plotLoops": [],
        "continuityIssues": [],
        "entityStates": {},
        "timelineEvents": [],
        "continuityReviews": [],
        "contextManifests": [],
        "continuityMeta": {"loopSchema": 1, "issueSchema": 1, "entitySchema": 1},
        "styleBible": {"pov": "", "tense": "", "pacing": "", "dialogue": "", "punctuation": "", "rules": [], "forbiddenPhrases": [], "examples": []},
        "storyState": {
            "updatedAt": 0,
            "lastChapter": "",
            "chapterCount": 0,
            "protagonistState": "",
            "openLoops": [],
            "establishedFacts": [],
            "recentHook": "",
            "endingNote": "",
            "powerOrSystem": "",
            "location": "",
            "timeline": "",
        },
        "detailCanon": {"updatedAt": 0, "facts": [], "conflicts": []},
        "storyline": {
            "updatedAt": 0,
            "currentTaskId": "",
            "currentOrder": 0,
            "volumeId": "",
            "volumeTitle": "",
            "positionSummary": "",
            "lastSummary": "",
            "nextDirection": "",
            "nextTaskId": "",
            "nextTaskGoal": "",
            "chapterLogs": [],
        },
        "appearanceLog": [],
        "chapters": [],
        "activeChapterId": None,
        "activeTaskId": None,
        "pipelineLog": [],
        "autoWrite": False,
    }


def chapter_order_map(project: dict) -> dict[str, int]:
    m: dict[str, int] = {}
    for t in project.get("tasks") or []:
        if t.get("id"):
            m[t["id"]] = int(t.get("order") or 0)
    return m


def resolve_chapter_order(ch: dict, task_order: dict[str, int], fallback: int) -> int:
    parsed = try_int(ch.get("order"))
    if parsed is not None:
        return parsed
    tid = ch.get("taskId")
    if tid and tid in task_order:
        return task_order[tid]
    # try parse from title 第N章
    m = re.search(r"第\s*(\d+)\s*章", ch.get("title") or "")
    if m:
        return int(m.group(1))
    return fallback


def write_book_readme(bdir: Path, project: dict) -> None:
    title = project.get("title") or bdir.name
    lines = [
        f"# {title}",
        "",
        f"> {project.get('pitch') or project.get('ideaInput') or ''}",
        "",
        f"- 阶段: `{project.get('stage')}`",
        f"- 章节数: {len(project.get('chapters') or [])}",
        f"- 任务数: {len(project.get('tasks') or [])}",
        f"- 更新: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime((project.get('updatedAt') or now_ms())/1000))}",
        "",
        "## 目录",
        "",
        "- `章节/` 正文 Markdown（可用 Obsidian 打开）",
        "- `策划/` 立项 / 世界 / 主线 / 任务板",
        "- `关系/graph.json` 人物关系",
        "- `记忆/digests.json` 滚动摘要",
        "- `锁定/locks.json` 作者锁定",
        "- `book.json` 墨稿完整状态",
        "",
    ]
    write_text_atomic(bdir / "README.md", "\n".join(lines) + "\n")


def history_dir(slug: str) -> Path:
    return book_dir(slug) / ".history"


@book_io_locked
def maybe_snapshot(slug: str, reason: str = "auto") -> str | None:
    """距上次快照超过间隔则备份 book.json。返回快照 id 或 None。"""
    bdir = book_dir(slug)
    src = bdir / "book.json"
    if not src.exists():
        return None
    now = now_ms()
    last = _last_snapshot_at.get(slug, 0)
    if reason == "auto" and now - last < SNAPSHOT_MIN_INTERVAL_MS:
        return None
    return create_snapshot(slug, reason=reason)


@book_io_locked
def create_snapshot(slug: str, reason: str = "manual") -> str:
    bdir = book_dir(slug)
    src = bdir / "book.json"
    if not src.exists():
        raise FileNotFoundError("no book.json to snapshot")
    hid = time.strftime("%Y%m%d-%H%M%S") + f"-{uuid.uuid4().hex[:6]}"
    dest = history_dir(slug) / hid
    # 极短时间内多次快照不覆盖
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest / "book.json")
    meta = {
        "id": hid,
        "reason": reason,
        "createdAt": now_ms(),
        "title": (read_json(src) or {}).get("title"),
        "chapters": len((read_json(src) or {}).get("chapters") or []),
    }
    write_json(dest / "meta.json", meta)
    _last_snapshot_at[slug] = now_ms()
    # 清理超额
    entries = sorted(
        [p for p in history_dir(slug).iterdir() if p.is_dir()],
        key=lambda p: p.name,
        reverse=True,
    )
    for old in entries[HISTORY_KEEP:]:
        shutil.rmtree(old, ignore_errors=True)
    log(f"snapshot {slug} -> {hid} ({reason})")
    return hid


@book_io_locked
def list_snapshots(slug: str) -> list[dict]:
    h = history_dir(slug)
    if not h.exists():
        return []
    out = []
    for p in sorted([x for x in h.iterdir() if x.is_dir()], key=lambda x: x.name, reverse=True):
        meta = read_json(p / "meta.json") or {"id": p.name}
        meta["id"] = meta.get("id") or p.name
        meta["path"] = str(p)
        out.append(meta)
    return out


@book_io_locked
def restore_snapshot(slug: str, snap_id: str) -> dict:
    snap = history_dir(slug) / snap_id / "book.json"
    if not snap.exists():
        raise FileNotFoundError(snap_id)
    # 恢复前再拍一份当前
    try:
        create_snapshot(slug, reason="pre-restore")
    except Exception:
        pass
    data = read_json(snap)
    if not data:
        raise ValueError("empty snapshot")
    data["_forceChapterOverwrite"] = True
    return save_book_to_disk(slug, data, do_snapshot=False)


@book_io_locked
def book_meta(slug: str) -> dict:
    bdir = book_dir(slug)
    if not bdir.is_dir():
        raise FileNotFoundError(slug)
    bj = bdir / "book.json"
    mtime = int(bj.stat().st_mtime * 1000) if bj.exists() else 0
    proj = read_json(bj) or {}
    return {
        "slug": slug,
        "title": proj.get("title") or slug,
        "path": str(bdir),
        "mtime": mtime,
        "updatedAt": proj.get("updatedAt"),
        "chapters": len(proj.get("chapters") or []),
        "stage": proj.get("stage"),
        "id": proj.get("id"),
    }


@book_io_locked
def save_book_to_disk(slug: str, project: dict, do_snapshot: bool = True) -> dict:
    """安全落盘：可选快照 → 先写新章节文件 → 再删孤儿 → 镜像 → book.json。"""
    bdir = book_dir(slug)
    bdir.mkdir(parents=True, exist_ok=True)
    for sub in ("章节", "策划", "关系", "记忆", "锁定"):
        (bdir / sub).mkdir(exist_ok=True)

    if do_snapshot:
        try:
            maybe_snapshot(slug, reason="auto")
        except Exception as e:
            log(f"snapshot skip: {e}")

    has_chapters_key = "chapters" in project
    clear_chapters = bool(project.get("clearChapters") or project.get("_clearChapters"))
    force_chapter_overwrite = bool(project.get("_forceChapterOverwrite"))
    project = dict(project)
    project["slug"] = slug
    project["updatedAt"] = now_ms()
    if not project.get("id"):
        project["id"] = str(uuid.uuid4())
    # 去掉仅运行时字段
    project.pop("_path", None)
    project.pop("_dirty", None)
    project.pop("_mtime", None)
    project.pop("_stub", None)
    project.pop("clearChapters", None)
    project.pop("_clearChapters", None)
    project.pop("_forceChapterOverwrite", None)
    project.pop("_saveWarnings", None)

    task_order = chapter_order_map(project)
    chap_dir = bdir / "章节"
    incoming = project.get("chapters") if has_chapters_key else None
    incoming = list(incoming) if isinstance(incoming, list) else []
    save_warnings: list[dict] = []
    disk_project = read_json(bdir / "book.json") or {}

    # A missing chapters key, or an accidental empty array, is metadata-only.
    # Only the explicit clearChapters flag authorizes deleting all markdown files.
    if not has_chapters_key or (not incoming and not clear_chapters):
        chapters = load_chapters_from_md(bdir, disk_project)
        project["chapters"] = chapters
    else:
        chapters = []
        for i, raw_ch in enumerate(incoming):
            # Keep compatibility with the historical debug helper: successful
            # saves annotate the caller's chapter object with file metadata.
            ch = raw_ch if isinstance(raw_ch, dict) else {}
            ch["order"] = resolve_chapter_order(ch, task_order, i + 1)
            chapters.append(ch)

    keep_names: set[str] = set()
    saved_chapters: list[dict] = []
    for ch in chapters if has_chapters_key and (incoming or clear_chapters) else []:
        order = coerce_int(ch.get("order"), 0)
        name = safe_filename(ch.get("title") or f"第{order}章", order)
        # 重名冲突：追加 id 短后缀
        if name in keep_names:
            stem = name[:-3] if name.endswith(".md") else name
            name = f"{stem}-{str(ch.get('id') or '')[:6]}.md"
        target_path = chap_dir / name
        old_rel = str(ch.get("_file") or "").replace("\\", "/")
        old_name = old_rel.removeprefix("章节/") if old_rel.startswith("章节/") else ""
        if not old_name or "/" in old_name or old_name in {".", ".."}:
            old_name = ""
        source_path = chap_dir / old_name if old_name and (chap_dir / old_name).is_file() else target_path

        # Optimistic concurrency: a newer external edit wins until the user resolves it.
        if source_path.is_file() and not force_chapter_overwrite:
            disk_mtime = int(source_path.stat().st_mtime * 1000)
            try:
                baseline = int(ch.get("_fileMtime") or 0)
            except (TypeError, ValueError):
                baseline = 0
            try:
                incoming_updated = int(ch.get("updatedAt") or 0)
            except (TypeError, ValueError):
                incoming_updated = 0
            disk_meta, disk_body = parse_chapter_md(source_path.read_text(encoding="utf-8"))
            incoming_body = str(ch.get("body") or "")
            # slim 缓存会把已落盘章的 body 置成空串；禁止用空串原子盖掉磁盘正文。
            if not incoming_body.strip() and disk_body.strip():
                disk_ch = load_chapter_path(source_path, order, base=ch)
                keep_names.add(source_path.name)
                saved_chapters.append(disk_ch)
                save_warnings.append(
                    {
                        "kind": "preservedExternal",
                        "path": f"章节/{source_path.name}",
                        "chapterId": disk_ch.get("id"),
                        "message": "incoming 正文为空，已保留磁盘章节",
                    }
                )
                continue
            disk_title = str(disk_meta.get("title") or "")
            content_diff = disk_body != incoming_body or (disk_title and disk_title != str(ch.get("title") or ""))
            disk_changed = (
                disk_mtime > baseline + 1
                if baseline > 0
                else disk_mtime > incoming_updated + 500
            )
            if content_diff and disk_changed:
                disk_ch = load_chapter_path(source_path, order, base=ch)
                keep_names.add(source_path.name)
                saved_chapters.append(disk_ch)
                save_warnings.append(
                    {
                        "kind": "externalConflict",
                        "path": f"章节/{source_path.name}",
                        "chapterId": disk_ch.get("id"),
                        "message": "检测到较新的外部修改，已保留磁盘版本",
                    }
                )
                continue

        keep_names.add(name)
        ch["_file"] = f"章节/{name}"
        md = dump_chapter_md(ch)
        if not target_path.is_file() or target_path.read_text(encoding="utf-8") != md:
            write_text_atomic(target_path, md)
        if old_name and old_name != name:
            old_path = chap_dir / old_name
            if old_path.is_file():
                old_path.unlink()
        ch["_fileMtime"] = int(target_path.stat().st_mtime * 1000)
        saved_chapters.append(ch)

    if has_chapters_key and (incoming or clear_chapters):
        for old in sorted(chap_dir.glob("*.md")):
            if old.name in keep_names:
                continue
            if clear_chapters:
                old.unlink()
                continue
            disk_ch = load_chapter_path(
                old, len(saved_chapters) + 1, base=_stored_chapter_for_file(disk_project, old.name)
            )
            disk_id = disk_ch.get("id")
            if disk_id and any(ch.get("id") == disk_id for ch in saved_chapters):
                continue
            saved_chapters.append(disk_ch)
            save_warnings.append(
                {
                    "kind": "preservedExternal",
                    "path": f"章节/{old.name}",
                    "chapterId": disk_id,
                    "message": "发现项目列表外的章节文件，已保留并合并",
                }
            )
        saved_chapters.sort(key=lambda ch: coerce_int(ch.get("order"), 0))
        chapters = saved_chapters
        project["chapters"] = chapters

    pitch = project.get("pitch") or ""
    hooks = project.get("hooks") or []
    pitch_md = "\n".join(
        [
            f"# {project.get('title') or slug}",
            "",
            f"**卖点** {pitch}",
            "",
            f"**类型** {project.get('genre') or ''} / {project.get('sub_genre') or ''}",
            "",
            f"**文风** {project.get('tone') or ''}",
            "",
            f"**受众** {project.get('audience') or ''}",
            "",
            "## 钩子",
            "",
            *[f"- {h}" for h in hooks],
            "",
            "## 意向原文",
            "",
            project.get("ideaInput") or "",
            "",
        ]
    )
    write_text_atomic(bdir / "策划" / "pitch.md", pitch_md)
    write_json(bdir / "策划" / "world.json", project.get("world"))
    write_json(bdir / "策划" / "spine.json", project.get("spine"))
    # 整本 PUT：payload 里出现 tasks 数组即为权威列表（含用户删除）。
    # 重跑主线的进度保留由 pipeline.mergeTasksPreservingProgress、
    # 以及资料区「策划/tasks.json」写入路径上的 merge 负责。
    if not isinstance(project.get("tasks"), list):
        existing = (
            disk_project.get("tasks")
            if isinstance(disk_project.get("tasks"), list)
            else None
        )
        if not isinstance(existing, list):
            existing = read_json(bdir / "策划" / "tasks.json")
        if not isinstance(existing, list):
            existing = []
        project["tasks"] = existing
    write_json(bdir / "策划" / "tasks.json", project.get("tasks") or [])
    write_json(bdir / "关系" / "graph.json", project.get("graph") or {"nodes": [], "edges": []})
    write_json(bdir / "记忆" / "digests.json", project.get("memoryRoll") or [])
    write_json(bdir / "记忆" / "canon.json", project.get("detailCanon") or {"facts": [], "conflicts": []})
    write_json(bdir / "记忆" / "storyline.json", project.get("storyline") or {})
    write_json(bdir / "记忆" / "appearances.json", project.get("appearanceLog") or [])
    write_json(bdir / "记忆" / "plot-loops.json", project.get("plotLoops") or [])
    write_json(bdir / "记忆" / "continuity-issues.json", project.get("continuityIssues") or [])
    write_json(bdir / "记忆" / "entity-states.json", project.get("entityStates") or {})
    write_json(bdir / "记忆" / "timeline-events.json", project.get("timelineEvents") or [])
    write_json(bdir / "记忆" / "continuity-reviews.json", project.get("continuityReviews") or [])
    write_json(bdir / "记忆" / "context-manifests.json", project.get("contextManifests") or [])
    write_json(bdir / "策划" / "style-bible.json", project.get("styleBible") or {})
    ri = project.get("ragIndex") or {}
    if isinstance(ri, dict) and ri.get("docs"):
        write_json(
            bdir / "记忆" / "rag-index.json",
            {"version": ri.get("version", 2), "builtAt": ri.get("builtAt", 0), "docs": ri.get("docs")},
        )
    md = project.get("detailCanonMarkdown") or ""
    if isinstance(md, str) and md.strip():
        write_text_atomic(bdir / "记忆" / "细节设定.md", md)
    write_json(bdir / "锁定" / "locks.json", project.get("locks") or {})

    write_json(bdir / "book.json", project)
    write_book_readme(bdir, project)
    touch_library_entry(slug, project)
    log(f"saved {slug} chapters={len(chapters)}")
    if save_warnings:
        project["_saveWarnings"] = save_warnings
    return project


def load_chapters_from_md(bdir: Path, project: dict) -> list[dict]:
    """用 章节/*.md 覆盖/补全书 chapters body，并保留 book.json 里 md 没有的章状态。"""
    by_id, by_file = _index_stored_chapters(project)

    chap_dir = bdir / "章节"
    if not chap_dir.exists():
        return list(project.get("chapters") or [])

    loaded: list[dict] = []
    for path in sorted(chap_dir.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_chapter_md(raw)
        cid = str(meta.get("id") or "").strip()
        order = try_int(meta.get("order"))
        if order is None:
            m = re.match(r"^(\d+)", path.stem)
            order = int(m.group(1)) if m else len(loaded) + 1
        # 只按 id 或文件名对齐；禁止按 order 借用另一章的身份。
        if cid:
            base = by_id.get(cid) or {}
        else:
            base = by_file.get(path.name) or {}
        ch = dict(base)
        ch["id"] = cid or ch.get("id") or str(uuid.uuid4())
        ch["taskId"] = meta.get("taskId") or ch.get("taskId")
        ch["title"] = meta.get("title") or ch.get("title") or path.stem
        ch["order"] = int(order)
        ch["body"] = body
        ch["updatedAt"] = try_int(meta.get("updatedAt")) or ch.get("updatedAt") or now_ms()
        ch["_file"] = f"章节/{path.name}"
        ch["_fileMtime"] = int(path.stat().st_mtime * 1000)
        loaded.append(ch)

    # 保留 md 里没有、但 book.json 有的空章？以 md 为准更像 Obsidian
    if loaded:
        loaded.sort(key=lambda c: coerce_int(c.get("order"), 0))
        return loaded
    return list(project.get("chapters") or [])


@book_io_locked
def load_book_from_disk(slug: str) -> dict:
    bdir = book_dir(slug)
    if not bdir.is_dir():
        raise FileNotFoundError(slug)
    project = read_json(bdir / "book.json")
    if not project:
        # 容错：只有 md
        project = default_book(slug)
        project["title"] = slug
    project["slug"] = slug
    # 镜像文件可补缺
    if not project.get("world"):
        project["world"] = read_json(bdir / "策划" / "world.json")
    if not project.get("spine"):
        project["spine"] = read_json(bdir / "策划" / "spine.json") or project.get("spine")
    if not project.get("tasks"):
        project["tasks"] = read_json(bdir / "策划" / "tasks.json") or []
    if not project.get("graph") or not (project.get("graph") or {}).get("nodes"):
        g = read_json(bdir / "关系" / "graph.json")
        if g:
            project["graph"] = g
    if not project.get("memoryRoll"):
        project["memoryRoll"] = read_json(bdir / "记忆" / "digests.json") or []
    if not project.get("detailCanon") or not (project.get("detailCanon") or {}).get("facts"):
        c = read_json(bdir / "记忆" / "canon.json")
        if c:
            project["detailCanon"] = c
    if not project.get("storyline") or not (project.get("storyline") or {}).get("positionSummary"):
        s = read_json(bdir / "记忆" / "storyline.json")
        if s:
            project["storyline"] = s
    if not project.get("appearanceLog"):
        project["appearanceLog"] = read_json(bdir / "记忆" / "appearances.json") or []
    for field, filename, fallback in (
        ("plotLoops", "plot-loops.json", []),
        ("continuityIssues", "continuity-issues.json", []),
        ("entityStates", "entity-states.json", {}),
        ("timelineEvents", "timeline-events.json", []),
        ("continuityReviews", "continuity-reviews.json", []),
        ("contextManifests", "context-manifests.json", []),
    ):
        if not project.get(field):
            project[field] = read_json(bdir / "记忆" / filename) or fallback
    if not project.get("styleBible"):
        project["styleBible"] = read_json(bdir / "策划" / "style-bible.json") or {}
    locks = read_json(bdir / "锁定" / "locks.json")
    if locks:
        project["locks"] = locks

    project["chapters"] = load_chapters_from_md(bdir, project)
    project["_path"] = str(bdir)
    bj = bdir / "book.json"
    project["_mtime"] = int(bj.stat().st_mtime * 1000) if bj.exists() else 0
    return project


@book_io_locked
@library_io_locked
def touch_library_entry(slug: str, project: dict) -> None:
    ensure_vault()
    lib = read_json(LIBRARY_FILE, {"version": 1, "books": []}) or {"version": 1, "books": []}
    books = [b for b in (lib.get("books") or []) if b.get("slug") != slug]
    books.insert(
        0,
        {
            "slug": slug,
            "id": project.get("id"),
            "title": project.get("title") or slug,
            "updatedAt": project.get("updatedAt") or now_ms(),
            "stage": project.get("stage"),
            "chapters": len(project.get("chapters") or []),
            "path": str(book_dir(slug)),
        },
    )
    # 按更新时间
    books.sort(key=lambda b: b.get("updatedAt") or 0, reverse=True)
    lib["books"] = books
    lib["updatedAt"] = now_ms()
    write_json(LIBRARY_FILE, lib)


@library_io_locked
def rescan_library() -> dict:
    ensure_vault()
    books = []
    for d in sorted(BOOKS.iterdir() if BOOKS.exists() else [], key=lambda p: p.name):
        if not d.is_dir():
            continue
        if d.name.startswith("."):
            continue
        proj = read_json(d / "book.json") or {}
        title = proj.get("title") or d.name
        books.append(
            {
                "slug": d.name,
                "id": proj.get("id"),
                "title": title,
                "updatedAt": proj.get("updatedAt") or int(d.stat().st_mtime * 1000),
                "stage": proj.get("stage"),
                "chapters": len(proj.get("chapters") or []),
                "path": str(d.resolve()),
            }
        )
    books.sort(key=lambda b: b.get("updatedAt") or 0, reverse=True)
    lib = {"version": 1, "books": books, "updatedAt": now_ms(), "vault": str(VAULT)}
    write_json(LIBRARY_FILE, lib)
    return lib


def search_group_for_path(rel: str, kind: str = "file") -> str:
    """将搜索命中映射到前端固定的作者语义分组。"""
    if kind == "book":
        return "other"
    normalized = str(rel or "").replace("\\", "/").casefold()
    if normalized.startswith("章节/"):
        return "chapter"
    if normalized.startswith("关系/") or any(
        marker in normalized for marker in ("entity-states", "timeline-events", "人物")
    ):
        return "character"
    if any(marker in normalized for marker in ("canon", "细节设定", "设定", "锁定")):
        return "canon"
    if any(marker in normalized for marker in ("plot-loops", "foreshadow", "伏笔", "钩子")):
        return "loop"
    return "other"


@library_io_locked
def search_vault(query: str, limit: int = 50) -> dict:
    """跨书轻量搜索；与正式 Rust API 保持字段、上限和安全边界一致。"""
    ensure_vault()
    raw_query = str(query or "").strip()
    capped_limit = max(1, min(int(limit or 50), 200))
    if not raw_query:
        return {"ok": True, "q": raw_query, "hits": []}

    needle = raw_query.casefold()
    hits: list[dict[str, Any]] = []
    text_suffixes = {".md", ".markdown", ".txt", ".json"}

    for entry in sorted(BOOKS.iterdir() if BOOKS.exists() else [], key=lambda item: item.name.casefold()):
        if len(hits) >= capped_limit:
            break
        if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
            continue
        slug = entry.name
        bdir = book_dir(slug)
        with book_io_lock(slug):
            project = read_json(bdir / "book.json", {}) or {}
            title = str(project.get("title") or slug)
            per_book_limit = min(8, capped_limit - len(hits))
            book_hits = 0
            if needle in title.casefold() or needle in slug.casefold():
                hits.append(
                    {
                        "slug": slug,
                        "title": title,
                        "bookTitle": title,
                        "path": "",
                        "snippet": title,
                        "kind": "book",
                        "group": "other",
                    }
                )
                book_hits += 1

            for root, dirs, files in os.walk(bdir, followlinks=False):
                root_path = Path(root)
                try:
                    relative_root = root_path.resolve().relative_to(bdir.resolve())
                except (OSError, ValueError):
                    dirs[:] = []
                    continue
                if len(relative_root.parts) >= 6:
                    dirs[:] = []
                dirs[:] = sorted(
                    [
                        name
                        for name in dirs
                        if not name.startswith(".")
                        and name not in SKIP_DIR_NAMES
                        and not (root_path / name).is_symlink()
                    ],
                    key=str.casefold,
                )
                for name in sorted(files, key=str.casefold):
                    if book_hits >= per_book_limit or len(hits) >= capped_limit:
                        break
                    candidate = root_path / name
                    if candidate.is_symlink() or candidate.suffix.casefold() not in text_suffixes:
                        continue
                    try:
                        resolved = candidate.resolve()
                        resolved.relative_to(bdir.resolve())
                        rel = resolved.relative_to(bdir.resolve()).as_posix()
                        raw = resolved.read_bytes()[: 8 * 1024]
                        text = raw.decode("utf-8", errors="replace")
                    except (OSError, ValueError):
                        continue
                    folded = text.casefold()
                    name_match = needle in name.casefold()
                    body_index = folded.find(needle)
                    if not name_match and body_index < 0:
                        continue
                    if body_index >= 0:
                        start = max(0, body_index - 40)
                        snippet = text[start : start + 40 + len(raw_query) + 60].replace("\n", " ").replace("\r", "")
                    else:
                        snippet = name
                    hits.append(
                        {
                            "slug": slug,
                            "title": title,
                            "bookTitle": title,
                            "path": rel,
                            "snippet": snippet,
                            "kind": "file",
                            "group": search_group_for_path(rel),
                        }
                    )
                    book_hits += 1
                if book_hits >= per_book_limit or len(hits) >= capped_limit:
                    break

    return {"ok": True, "q": raw_query, "hits": hits}


def create_book(title: str, idea: str = "") -> dict:
    slug = reserve_unique_slug(title or "新书")
    project = default_book(title=title or "新书", idea=idea)
    project["slug"] = slug
    project["pipelineLog"] = [{"t": now_ms(), "msg": f"创建本地书夹 vault/books/{slug}"}]
    try:
        save_book_to_disk(slug, project)
        return project
    except Exception:
        with book_io_lock(slug):
            shutil.rmtree(book_dir(slug), ignore_errors=True)
        raise


@book_io_locked
@library_io_locked
def delete_book(slug: str) -> None:
    bdir = book_dir(slug)
    if bdir.exists():
        shutil.rmtree(bdir)
    lib = read_json(LIBRARY_FILE, {"books": []}) or {"books": []}
    lib["books"] = [b for b in (lib.get("books") or []) if b.get("slug") != slug]
    lib["updatedAt"] = now_ms()
    write_json(LIBRARY_FILE, lib)


def migrate_projects(projects: list[dict]) -> list[dict]:
    """把浏览器 localStorage 里的 projects 写入 vault。"""
    out = []
    created: list[str] = []
    try:
        for index, p in enumerate(projects or []):
            if not isinstance(p, dict):
                raise ValueError(f"migration project {index + 1} must be an object")
            title = p.get("title") or "迁入作品"
            slug = reserve_unique_slug(p.get("slug") or title)
            created.append(slug)
            p = dict(p)
            p["slug"] = slug
            p["pipelineLog"] = list(p.get("pipelineLog") or [])
            p["pipelineLog"].append({"t": now_ms(), "msg": f"从浏览器 localStorage 迁入 → {slug}"})
            saved = save_book_to_disk(slug, p)
            out.append({"slug": slug, "title": saved.get("title"), "id": saved.get("id")})
        rescan_library()
        return out
    except Exception:
        for slug in reversed(created):
            with book_io_lock(slug):
                shutil.rmtree(book_dir(slug), ignore_errors=True)
        try:
            rescan_library()
        except Exception:
            pass
        raise


def _win_focus_explorer() -> None:
    """把最近的资源管理器窗口拉到前台（Windows）。"""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        SW_RESTORE = 9
        targets: list[int] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def enum_proc(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            # 类名 CabinetWClass = 资源管理器
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value in ("CabinetWClass", "ExploreWClass"):
                targets.append(hwnd)
            return True

        time.sleep(0.25)
        user32.EnumWindows(enum_proc, 0)
        if not targets:
            return
        hwnd = targets[0]
        user32.ShowWindow(hwnd, SW_RESTORE)
        # 允许跨进程 SetForegroundWindow
        try:
            kernel32.AllowSetForegroundWindow(-1)  # ASFW_ANY
        except Exception:
            pass
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
    except Exception:
        pass


# ─── 书内文件树（Obsidian 风格工作区）────────────────────────────────────────

SKIP_DIR_NAMES = {".history", "__pycache__", ".git", "node_modules"}
EDITABLE_SUFFIX = {".md", ".json", ".txt", ".markdown"}


def safe_rel_under_book(slug: str, rel: str) -> Path:
    """将相对路径解析到书目录内，禁止 .. 穿越。"""
    bdir = book_dir(slug)
    raw = str(rel or "")
    if raw.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[/\\]", raw) or "\x00" in raw:
        raise ValueError("absolute path is not allowed")
    rel = raw.replace("\\", "/")
    if not rel or rel.endswith("/"):
        raise ValueError("invalid path")
    parts = [p for p in rel.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("path traversal")
    target = (bdir.joinpath(*parts)).resolve()
    if not path_is_within(bdir, target) or target == bdir.resolve():
        raise ValueError("path outside book")
    return target


@book_io_locked
def build_file_tree(slug: str) -> dict:
    bdir = book_dir(slug)
    if not bdir.is_dir():
        raise FileNotFoundError(slug)

    base = bdir.resolve()
    seen = {base}

    def walk(dir_path: Path, prefix: str = "", depth: int = 0) -> list[dict]:
        if depth >= 8:
            return []
        nodes: list[dict] = []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return nodes
        for ent in entries:
            if ent.is_symlink():
                continue
            if ent.name.startswith(".") and ent.name not in (".",):
                # 隐藏 .history 等
                if ent.name in SKIP_DIR_NAMES or ent.name.startswith("."):
                    continue
            if ent.name in SKIP_DIR_NAMES:
                continue
            rel = f"{prefix}/{ent.name}".lstrip("/") if prefix else ent.name
            try:
                resolved = ent.resolve()
                resolved.relative_to(base)
            except (OSError, ValueError):
                continue
            if ent.is_dir():
                if resolved in seen:
                    continue
                seen.add(resolved)
                nodes.append(
                    {
                        "type": "dir",
                        "name": ent.name,
                        "path": rel.replace("\\", "/"),
                        "children": walk(ent, rel, depth + 1),
                    }
                )
            elif ent.is_file():
                suf = ent.suffix.lower()
                try:
                    st = ent.stat()
                    mtime = int(st.st_mtime * 1000)
                    size = st.st_size
                except OSError:
                    mtime, size = 0, 0
                nodes.append(
                    {
                        "type": "file",
                        "name": ent.name,
                        "path": rel.replace("\\", "/"),
                        "ext": suf,
                        "editable": suf in EDITABLE_SUFFIX,
                        "mtime": mtime,
                        "size": size,
                    }
                )
        return nodes

    return {
        "slug": slug,
        "root": str(bdir),
        "tree": walk(bdir),
        "scannedAt": now_ms(),
    }


@book_io_locked
def read_book_file(slug: str, rel: str) -> dict:
    target = safe_rel_under_book(slug, rel)
    if not target.is_file():
        raise FileNotFoundError(rel)
    suf = target.suffix.lower()
    if suf not in EDITABLE_SUFFIX and suf not in {".md", ".json", ".txt"}:
        raise ValueError(f"unsupported file type: {suf}")
    text = target.read_text(encoding="utf-8")
    st = target.stat()
    return {
        "slug": slug,
        "path": rel.replace("\\", "/"),
        "name": target.name,
        "ext": suf,
        "content": text,
        "mtime": int(st.st_mtime * 1000),
        "size": st.st_size,
    }


@book_io_locked
def write_book_file(slug: str, rel: str, content: str) -> dict:
    target = safe_rel_under_book(slug, rel)
    suf = target.suffix.lower()
    if suf not in EDITABLE_SUFFIX:
        raise ValueError(f"not editable: {suf}")
    target.parent.mkdir(parents=True, exist_ok=True)
    # 写前轻量快照（仅 book.json 仍走 maybe_snapshot；单文件不强制）
    write_text_atomic(target, content if content is not None else "")
    st = target.stat()
    log(f"file write {slug}/{rel} bytes={st.st_size}")
    rel_n = str(rel or "").replace("\\", "/")
    try:
        if rel_n.startswith("章节/") and rel_n.endswith(".md"):
            _sync_chapter_md_into_book(slug, rel_n, content or "")
        else:
            _sync_mirror_file(slug, rel_n, content or "")
    except Exception as e:
        log(f"mirror sync skip: {e}")
    return {
        "ok": True,
        "slug": slug,
        "path": rel_n,
        "mtime": int(st.st_mtime * 1000),
        "size": st.st_size,
    }


@book_io_locked
def delete_book_path(slug: str, rel: str) -> dict:
    target = safe_rel_under_book(slug, rel)
    bdir = book_dir(slug)
    if target == bdir:
        raise ValueError("cannot delete book root")
    if not target.exists():
        raise FileNotFoundError(rel)
    was_dir = target.is_dir()
    if was_dir:
        shutil.rmtree(target)
    else:
        target.unlink()

    rel_n = str(rel or "").replace("\\", "/").strip("/")
    if rel_n == "章节" or rel_n.startswith("章节/"):
        project = read_json(bdir / "book.json") or {}
        chapters = project.get("chapters") or []
        prefix = rel_n.rstrip("/") + "/"

        def retained(chapter: Any) -> bool:
            chapter_path = str(chapter.get("_file") or chapter.get("path") or "").replace("\\", "/").strip("/")
            return chapter_path != rel_n and not (was_dir and chapter_path.startswith(prefix))

        project["chapters"] = [chapter for chapter in chapters if retained(chapter)]
        project["updatedAt"] = now_ms()
        write_json(bdir / "book.json", project)
        touch_library_entry(slug, project)
    return {"ok": True, "slug": slug, "path": rel_n, "deleted": True}


def _try_json_value(content: str) -> Any | None:
    try:
        return json.loads(content)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def parse_pitch_md(content: str) -> tuple[str, str]:
    """从 pitch.md 启发式提取卖点与意向，字段与 Rust parse_pitch_md 对齐。"""
    text = (content or "").replace("\r\n", "\n")
    pitch = ""
    marker = "**卖点**"
    idx = text.find(marker)
    if idx >= 0:
        after = text[idx + len(marker) :]
        line_rest = after.split("\n", 1)[0].strip().lstrip(":： \t")
        if line_rest:
            pitch = line_rest[:200]
        else:
            for line in after.splitlines()[1:]:
                t = line.strip()
                if not t or t.startswith("#"):
                    continue
                pitch = t.lstrip("*- ")[:200]
                break
    idea = ""
    for heading in ("## 意向原文", "## 意向"):
        idx = text.find(heading)
        if idx < 0:
            continue
        after = text[idx + len(heading) :]
        end = after.find("\n## ")
        idea = (after if end < 0 else after[:end]).strip()
        break
    if not pitch:
        for line in text.splitlines():
            t = line.strip()
            if not t or t.startswith("#") or t.startswith("**卖点**"):
                continue
            pitch = t[:200]
            break
        if not pitch:
            body = " ".join(
                line.strip()
                for line in text.splitlines()
                if line.strip() and not line.strip().startswith("#")
            )
            pitch = body[:200]
    return pitch, idea


_PROGRESSED_TASK_STATUS = {"done", "written", "digested", "writing"}


def _task_is_progressed(task: dict, chapters: list | None) -> bool:
    st = str(task.get("status") or "pending")
    if st in _PROGRESSED_TASK_STATUS:
        return True
    tid = str(task.get("id") or "")
    if not tid or not chapters:
        return False
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        if ch.get("taskId") == tid and str(ch.get("body") or "").strip():
            return True
    return False


def merge_tasks_preserving_progress(
    existing: list, incoming: list, chapters: list | None = None
) -> list:
    """与 Rust merge_tasks_preserving_progress 对齐：资料区草稿/重跑策划时，有进度的任务不被洗掉。整本 PUT 不走这里。"""
    old_by_id: dict[str, dict] = {}
    old_by_order: dict[int, dict] = {}
    for task in existing or []:
        if not isinstance(task, dict):
            continue
        tid = str(task.get("id") or "")
        if tid:
            old_by_id[tid] = task
        old_by_order[coerce_int(task.get("order"), 0)] = task
    used: set[str] = set()
    result: list[dict] = []
    for neu in incoming or []:
        if not isinstance(neu, dict):
            continue
        tid = str(neu.get("id") or "")
        old = old_by_id.get(tid) if tid else None
        if old is None:
            old = old_by_order.get(coerce_int(neu.get("order"), 0))
        if old is None:
            merged = dict(neu)
            merged.setdefault("status", "pending")
            result.append(merged)
            continue
        oid = str(old.get("id") or "")
        if oid:
            used.add(oid)
        if _task_is_progressed(old, chapters):
            merged = dict(neu)
            for key in (
                "status",
                "lastError",
                "lastErrorStage",
                "id",
                "order",
                "chapterId",
                "writtenAt",
                "digestedAt",
            ):
                if key in old:
                    merged[key] = old[key]
            for key in ("must_include", "must_not", "beats", "hook_end", "conflict"):
                val = old.get(key)
                keep = False
                if isinstance(val, list) and val:
                    keep = True
                elif isinstance(val, str) and val:
                    keep = True
                elif val not in (None, [], ""):
                    keep = True
                if keep:
                    merged[key] = val
            for key in ("chapter_title", "goal"):
                if str(old.get(key) or ""):
                    merged[key] = old[key]
            result.append(merged)
        else:
            merged = dict(neu)
            merged["status"] = "pending"
            if not tid and old.get("id"):
                merged["id"] = old["id"]
            result.append(merged)
    for old in existing or []:
        if not isinstance(old, dict):
            continue
        oid = str(old.get("id") or "")
        if not oid or oid in used:
            continue
        if _task_is_progressed(old, chapters):
            result.append(dict(old))
    result.sort(key=lambda t: coerce_int(t.get("order"), 0))
    return result


def _sync_mirror_file(slug: str, rel: str, content: str) -> None:
    """工作区改镜像文件后回写 book.json 对应字段（不经 save_book，避免覆盖其它 md）。"""
    rel_n = rel.replace("\\", "/")
    bdir = book_dir(slug)
    bj = bdir / "book.json"
    proj = read_json(bj) or default_book(slug)
    changed = False

    def assign_json(field: str) -> None:
        nonlocal changed
        parsed = _try_json_value(content)
        if parsed is None:
            return
        proj[field] = parsed
        changed = True

    if rel_n == "策划/world.json":
        assign_json("world")
    elif rel_n == "策划/spine.json":
        assign_json("spine")
    elif rel_n == "策划/tasks.json":
        parsed = _try_json_value(content)
        if isinstance(parsed, list):
            existing = proj.get("tasks") if isinstance(proj.get("tasks"), list) else []
            chapters = proj.get("chapters") if isinstance(proj.get("chapters"), list) else []
            proj["tasks"] = merge_tasks_preserving_progress(existing, parsed, chapters)
            changed = True
    elif rel_n == "关系/graph.json":
        assign_json("graph")
    elif rel_n == "记忆/digests.json":
        assign_json("memoryRoll")
    elif rel_n == "记忆/canon.json":
        assign_json("detailCanon")
    elif rel_n == "记忆/storyline.json":
        assign_json("storyline")
    elif rel_n == "记忆/appearances.json":
        assign_json("appearanceLog")
    elif rel_n == "记忆/plot-loops.json":
        assign_json("plotLoops")
    elif rel_n == "记忆/continuity-issues.json":
        assign_json("continuityIssues")
    elif rel_n == "记忆/entity-states.json":
        assign_json("entityStates")
    elif rel_n == "记忆/timeline-events.json":
        assign_json("timelineEvents")
    elif rel_n == "记忆/continuity-reviews.json":
        assign_json("continuityReviews")
    elif rel_n == "记忆/context-manifests.json":
        assign_json("contextManifests")
    elif rel_n == "策划/style-bible.json":
        assign_json("styleBible")
    elif rel_n == "锁定/locks.json":
        assign_json("locks")
    elif rel_n == "策划/pitch.md":
        pitch, idea_note = parse_pitch_md(content)
        if pitch:
            proj["pitch"] = pitch
            changed = True
        if idea_note:
            existing = str(proj.get("ideaInput") or "")
            if not existing:
                proj["ideaInput"] = idea_note
                changed = True
            elif idea_note.strip() not in existing and len(idea_note) > 8:
                proj["pitchNote"] = idea_note[:500]
                changed = True

    if changed:
        proj["slug"] = slug
        proj["updatedAt"] = now_ms()
        write_json(bj, proj)
        touch_library_entry(slug, proj)


def _sync_chapter_md_into_book(slug: str, rel: str, content: str) -> None:
    rel_n = rel.replace("\\", "/")
    if not rel_n.startswith("章节/") or not rel_n.endswith(".md"):
        return
    meta, body = parse_chapter_md(content)
    proj = read_json(book_dir(slug) / "book.json")
    if not proj:
        return
    chapters = list(proj.get("chapters") or [])
    cid = str(meta.get("id") or "").strip()
    updated = False
    for ch in chapters:
        match_id = bool(cid) and ch.get("id") == cid
        match_file = str(ch.get("_file") or "").replace("\\", "/") == rel_n
        if match_id or match_file:
            ch["body"] = body
            if meta.get("title"):
                ch["title"] = meta["title"]
            if cid:
                ch["id"] = cid
            order = try_int(meta.get("order"))
            if order is not None:
                ch["order"] = order
            ch["updatedAt"] = now_ms()
            updated = True
            break
    if not updated:
        order = coerce_int(meta.get("order"), len(chapters) + 1)
        chapters.append(
            {
                "id": cid or str(uuid.uuid4()),
                "taskId": meta.get("taskId") or "",
                "title": meta.get("title") or Path(rel_n).stem,
                "order": order,
                "body": body,
                "updatedAt": now_ms(),
                "_file": rel_n,
            }
        )
        updated = True
    if updated:
        proj["chapters"] = chapters
        proj["updatedAt"] = now_ms()
        write_json(book_dir(slug) / "book.json", proj)
        touch_library_entry(slug, proj)


@book_io_locked
def tree_mtimes(slug: str) -> dict:
    """扁平 path→mtime，供前端廉价轮询。"""
    bdir = book_dir(slug)
    out: dict[str, int] = {}
    if not bdir.is_dir():
        return {"slug": slug, "files": out}
    for p in bdir.rglob("*"):
        if not p.is_file():
            continue
        rel_parts = p.relative_to(bdir).parts
        if any(part in SKIP_DIR_NAMES or part.startswith(".") for part in rel_parts):
            continue
        rel = "/".join(rel_parts)
        try:
            out[rel] = int(p.stat().st_mtime * 1000)
        except OSError:
            pass
    return {"slug": slug, "files": out, "scannedAt": now_ms()}


def reveal_path(path: str) -> None:
    """在系统文件管理器中打开路径，并尽量聚焦到前台。

    Windows 上单纯 `explorer folder` 常复用已有窗口且不抢焦点；
    改为 `explorer /select,<文件>` 选中书夹内 book.json，通常会前置并高亮。
    """
    p = Path(path).resolve()
    if not p.exists():
        ensure_vault()
        p = VAULT.resolve()

    if sys.platform.startswith("win"):
        select_target = p
        if p.is_dir():
            for name in ("book.json", "README.md"):
                cand = p / name
                if cand.is_file():
                    select_target = cand
                    break
            else:
                try:
                    kids = sorted(p.iterdir(), key=lambda x: x.name)
                    if kids:
                        select_target = kids[0]
                except OSError:
                    pass

        try:
            if select_target.is_file():
                # 官方推荐形式：两个参数 "/select," 与绝对路径
                subprocess.Popen(
                    ["explorer", "/select,", str(select_target.resolve())],
                    close_fds=True,
                )
            else:
                # SW_RESTORE = 9，尽量恢复并显示
                ctypes = __import__("ctypes")
                ctypes.windll.shell32.ShellExecuteW(
                    None, "open", str(p), None, None, 9
                )
        except Exception:
            subprocess.Popen(f'explorer "{p}"', shell=True)
        _win_focus_explorer()
        return

    if sys.platform == "darwin":
        if p.is_file():
            subprocess.Popen(["open", "-R", str(p)])
        else:
            subprocess.Popen(["open", str(p)])
        return

    subprocess.Popen(["xdg-open", str(p if p.is_dir() else p.parent)])


# ─── HTTP ─────────────────────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", WEB_CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        origin = self.headers.get("Origin")
        if origin and is_trusted_browser_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[mogao] " + (fmt % args) + "\n")

    def _read_body(self) -> bytes:
        try:
            length = parse_content_length(self.headers.get("Content-Length"))
        except RequestBodyTooLarge:
            self.close_connection = True
            raise
        return self.rfile.read(length) if length else b""

    def _read_json(self) -> Any:
        raw = self._read_body() or b"{}"
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid JSON: {e}") from e

    def _send(self, status: int, data: Any = None, plain: bytes | None = None) -> None:
        if plain is not None:
            body = plain
            ctype = "text/plain; charset=utf-8"
        else:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": {"message": message, "status": status}})

    def _allow_local_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if is_trusted_browser_origin(origin):
            return True
        self._error(403, "cross-origin access to the local debug service is forbidden")
        return False

    def do_OPTIONS(self):
        if not self._allow_local_origin():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, x-api-key, OpenAI-Beta",
        )
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/v1/") and UPSTREAM:
            if not self._allow_local_origin():
                return
            return self._proxy()
        if path.startswith("/api/"):
            if not self._allow_local_origin():
                return
            return self._api_get(path, parse_qs(parsed.query))
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/v1/") and UPSTREAM:
            if not self._allow_local_origin():
                return
            return self._proxy()
        if path.startswith("/api/"):
            if not self._allow_local_origin():
                return
            return self._api_post(path)
        self._error(405, "Method Not Allowed")

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/"):
            if not self._allow_local_origin():
                return
            return self._api_put(path)
        self._error(405, "Method Not Allowed")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/"):
            if not self._allow_local_origin():
                return
            return self._api_delete(path, parse_qs(parsed.query))
        self._error(405, "Method Not Allowed")

    # ── API routers ──

    def _api_get(self, path: str, qs: dict) -> None:
        try:
            ensure_vault()
            if path == "/api/health":
                return self._send(
                    200,
                    {
                        "ok": True,
                        "app": "mogao",
                        "version": VERSION,
                        "vault": str(VAULT),
                        "books": str(BOOKS),
                        "port": PORT,
                        "historyKeep": HISTORY_KEEP,
                    },
                )
            if path == "/api/settings":
                return self._send(200, settings_payload())
            if path == "/api/library":
                return self._send(200, rescan_library())
            if path == "/api/search":
                query = (qs.get("q") or [""])[0]
                raw_limit = (qs.get("limit") or ["50"])[0]
                try:
                    limit = int(raw_limit)
                except (TypeError, ValueError):
                    return self._error(400, "invalid search limit")
                return self._send(200, search_vault(query, limit))
            m = re.fullmatch(r"/api/books/([^/]+)/meta", path)
            if m:
                return self._send(200, book_meta(m.group(1)))
            m = re.fullmatch(r"/api/books/([^/]+)/snapshots", path)
            if m:
                return self._send(200, {"slug": m.group(1), "snapshots": list_snapshots(m.group(1))})
            m = re.fullmatch(r"/api/books/([^/]+)/tree", path)
            if m:
                return self._send(200, build_file_tree(m.group(1)))
            m = re.fullmatch(r"/api/books/([^/]+)/watch", path)
            if m:
                return self._send(200, tree_mtimes(m.group(1)))
            m = re.fullmatch(r"/api/books/([^/]+)/file", path)
            if m:
                rel = (qs.get("path") or [None])[0]
                if not rel:
                    return self._error(400, "missing path query")
                return self._send(200, read_book_file(m.group(1), unquote(rel)))
            m = re.fullmatch(r"/api/books/([^/]+)", path)
            if m:
                return self._send(200, load_book_from_disk(m.group(1)))
            self._error(404, f"unknown GET {path}")
        except FileNotFoundError as e:
            self._error(404, f"book not found: {e}")
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._error(500, str(e))

    def _api_post(self, path: str) -> None:
        try:
            ensure_vault()
            body = self._read_json() or {}
            if path == "/api/books":
                title = (body.get("title") or "新书").strip()
                idea = (body.get("idea") or "").strip()
                return self._send(201, create_book(title, idea))
            if path == "/api/migrate":
                projects = body.get("projects") or []
                result = migrate_projects(projects)
                return self._send(200, {"migrated": result, "library": rescan_library()})
            if path == "/api/library/rescan":
                return self._send(200, rescan_library())
            if path == "/api/reveal":
                target = body.get("path") or str(VAULT)
                reveal_path(target)
                return self._send(200, {"ok": True, "path": target})
            m = re.fullmatch(r"/api/books/([^/]+)/reload", path)
            if m:
                return self._send(200, load_book_from_disk(m.group(1)))
            m = re.fullmatch(r"/api/books/([^/]+)/reveal", path)
            if m:
                p = str(book_dir(m.group(1)))
                reveal_path(p)
                return self._send(200, {"ok": True, "path": p})
            m = re.fullmatch(r"/api/books/([^/]+)/snapshot", path)
            if m:
                slug = m.group(1)
                with book_io_lock(slug):
                    hid = create_snapshot(slug, reason=body.get("reason") or "manual")
                    snapshots = list_snapshots(slug)
                return self._send(200, {"ok": True, "id": hid, "snapshots": snapshots})
            m = re.fullmatch(r"/api/books/([^/]+)/restore", path)
            if m:
                snap_id = body.get("id") or body.get("snapId")
                if not snap_id:
                    return self._error(400, "missing snapshot id")
                book = restore_snapshot(m.group(1), snap_id)
                book["_path"] = str(book_dir(m.group(1)))
                return self._send(200, book)
            m = re.fullmatch(r"/api/books/([^/]+)/rename", path)
            if m:
                # 仅改显示书名，不改文件夹 slug（避免破坏外部链接）
                slug = m.group(1)
                title = (body.get("title") or "").strip()
                if not title:
                    return self._error(400, "title required")
                with book_io_lock(slug):
                    book = load_book_from_disk(slug)
                    book["title"] = title
                    saved = save_book_to_disk(slug, book)
                return self._send(200, saved)
            self._error(404, f"unknown POST {path}")
        except RequestBodyTooLarge as e:
            self._error(413, str(e))
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._error(500, str(e))

    def _api_put(self, path: str) -> None:
        try:
            ensure_vault()
            if path == "/api/settings":
                body = self._read_json() or {}
                settings = update_settings(body)
                return self._send(200, {"ok": True, **settings_payload(settings)})
            m = re.fullmatch(r"/api/books/([^/]+)/file", path)
            if m:
                body = self._read_json() or {}
                rel = body.get("path")
                if not rel:
                    return self._error(400, "path required")
                content = body.get("content")
                if content is None:
                    return self._error(400, "content required")
                return self._send(200, write_book_file(m.group(1), rel, str(content)))
            m = re.fullmatch(r"/api/books/([^/]+)", path)
            if not m:
                return self._error(404, f"unknown PUT {path}")
            slug = m.group(1)
            body = self._read_json() or {}
            if not isinstance(body, dict):
                return self._error(400, "body must be object")
            # 允许改名 title，但 slug 以路径为准
            with book_io_lock(slug):
                saved = save_book_to_disk(slug, body)
                meta = book_meta(slug)
            return self._send(
                200,
                {
                    "ok": True,
                    "slug": slug,
                    "updatedAt": saved.get("updatedAt"),
                    "path": meta["path"],
                    "mtime": meta["mtime"],
                    "version": VERSION,
                    "saveWarnings": saved.get("_saveWarnings") or [],
                    "chapterBaselines": chapter_baselines(saved),
                },
            )
        except RequestBodyTooLarge as e:
            self._error(413, str(e))
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._error(500, str(e))

    def _api_delete(self, path: str, qs: dict) -> None:
        try:
            m = re.fullmatch(r"/api/books/([^/]+)/fs", path)
            if m:
                rel = (qs.get("path") or [None])[0]
                if not rel:
                    return self._error(400, "missing path query")
                return self._send(200, delete_book_path(m.group(1), unquote(rel)))
            m = re.fullmatch(r"/api/books/([^/]+)", path)
            if not m:
                return self._error(404, f"unknown DELETE {path}")
            delete_book(m.group(1))
            return self._send(200, {"ok": True})
        except FileNotFoundError as e:
            self._error(404, f"not found: {e}")
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._error(500, str(e))

    def _proxy(self) -> None:
        try:
            body = self._read_body() or None
        except RequestBodyTooLarge as e:
            return self._error(413, str(e))
        except ValueError as e:
            return self._error(400, str(e))
        target = f"{UPSTREAM}{self.path}"
        headers = {}
        for name in ("Authorization", "Content-Type", "x-api-key", "OpenAI-Beta", "Accept"):
            v = self.headers.get(name)
            if v:
                headers[name] = v
        req = Request(target, data=body, headers=headers, method=self.command)
        try:
            with urlopen(req, timeout=600) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ct = resp.headers.get("Content-Type")
                if ct:
                    self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read() if e.fp else b""
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)
        except URLError as e:
            msg = json.dumps({"error": {"message": f"proxy upstream error: {e}"}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def create_httpd() -> ThreadingHTTPServer:
    ensure_vault()
    rescan_library()
    os.chdir(ROOT)
    return ThreadingHTTPServer(("127.0.0.1", PORT), Handler)


def serve_forever(httpd: ThreadingHTTPServer | None = None) -> ThreadingHTTPServer:
    httpd = httpd or create_httpd()
    httpd.serve_forever()
    return httpd


def main() -> None:
    httpd = create_httpd()
    print()
    print(f"  墨稿 · 本地书库工坊  v{VERSION}")
    print(f"  UI     http://127.0.0.1:{PORT}/")
    print(f"  Vault  {VAULT}")
    print(f"  Books  {BOOKS}")
    if UPSTREAM:
        print(f"  Proxy  /v1/* → {UPSTREAM}")
    print("  Ctrl+C 停止")
    print()
    log(f"listening :{PORT} vault={VAULT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
