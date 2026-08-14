//! 墨稿书库：与 Python server.py 兼容的目录约定与核心读写。
mod book;
mod classify;
mod fs_ops;
mod tasks;
mod util;

pub use book::chapter_baselines;
pub use classify::{book_dir_reject_value, classify_path, unknown_reject_value, PathKind};
#[allow(unused_imports)]
pub use tasks::merge_tasks_preserving_progress;

use anyhow::{bail, Result};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use util::{mtime_ms, now_ms, read_json, write_json};

pub const VERSION: &str = "0.19.0";
pub(crate) const HISTORY_KEEP: usize = 20;
pub(crate) const AUTO_SNAPSHOT_MIN_INTERVAL_MS: u64 = 5 * 60 * 1000;
pub(crate) const EDITABLE: &[&str] = &[".md", ".json", ".txt", ".markdown"];

/// 全局内容世代：任意写操作递增；watch 响应携带，前端可跳过无变化的全量 mtime 拉取
pub static CONTENT_EPOCH: AtomicU64 = AtomicU64::new(0);

pub fn bump_content_epoch() {
    CONTENT_EPOCH.fetch_add(1, Ordering::Relaxed);
}

pub fn content_epoch() -> u64 {
    CONTENT_EPOCH.load(Ordering::Relaxed)
}

fn search_group_for_path(relative_path: &str) -> &'static str {
    let normalized = relative_path.replace('\\', "/").to_lowercase();
    if normalized.starts_with("章节/") {
        "chapter"
    } else if normalized.starts_with("关系/")
        || normalized.contains("entity-states")
        || normalized.contains("timeline-events")
        || normalized.contains("人物")
    {
        "character"
    } else if normalized.contains("canon")
        || normalized.contains("细节设定")
        || normalized.contains("设定")
        || normalized.contains("锁定")
    {
        "canon"
    } else if normalized.contains("plot-loops")
        || normalized.contains("foreshadow")
        || normalized.contains("伏笔")
        || normalized.contains("钩子")
    {
        "loop"
    } else {
        "other"
    }
}

/// 持有 notify watcher；drop 即停止。
struct WatcherHold {
    _watcher: RecommendedWatcher,
}

static VAULT_WATCHER: Mutex<Option<WatcherHold>> = Mutex::new(None);

/// 停止当前 vault 文件系统监视
pub fn stop_vault_watcher() {
    if let Ok(mut g) = VAULT_WATCHER.lock() {
        *g = None;
    }
}

/// 对 vault root 启 Recursive watcher；外部变更 debounced bump epoch。
/// 失败仅 eprintln，不崩。切换 vault 时先 stop 再 start。
pub fn start_vault_watcher(root: &Path) {
    stop_vault_watcher();
    let root = root.to_path_buf();
    if !root.exists() {
        eprintln!(
            "[mogao] vault watcher skip: root missing {}",
            root.display()
        );
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    );
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[mogao] vault watcher init failed: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!(
            "[mogao] vault watcher watch({}) failed: {e}",
            root.display()
        );
        return;
    }
    // 防抖线程：事件后等 ~200ms 再 bump，channel 关闭则退出
    std::thread::Builder::new()
        .name("mogao-vault-watch".into())
        .spawn(move || loop {
            match rx.recv() {
                Ok(Ok(_ev)) => {}
                Ok(Err(e)) => {
                    eprintln!("[mogao] vault watch event error: {e}");
                    continue;
                }
                Err(_) => break,
            }
            std::thread::sleep(Duration::from_millis(200));
            while rx.try_recv().is_ok() {}
            bump_content_epoch();
        })
        .ok();
    if let Ok(mut g) = VAULT_WATCHER.lock() {
        *g = Some(WatcherHold { _watcher: watcher });
    }
    eprintln!("[mogao] vault watcher on {}", root.display());
}

/// 全局写串行：save_book / write_file / fs_* / delete_book /
/// rename_book(folder) / import_book_dir / create_snapshot 入口持有。
/// 已持锁调用方须走 *_inner，禁止嵌套 lock（std Mutex 不可重入）。
pub(crate) static IO_LOCK: Mutex<()> = Mutex::new(());

/// slug 白名单校验（P0-2）
pub fn is_valid_slug(slug: &str) -> bool {
    if slug.is_empty() || slug == "." || slug == ".." {
        return false;
    }
    let trimmed = slug.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return false;
    }
    if slug.starts_with('.') || trimmed.starts_with('.') {
        return false;
    }
    if slug.contains('/') || slug.contains('\\') {
        return false;
    }
    // Windows 保留名（可选）
    let upper = trimmed.to_uppercase();
    if matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return false;
    }
    true
}

#[derive(Clone)]
pub struct Vault {
    pub root: PathBuf,
    pub books: PathBuf,
    pub library_file: PathBuf,
    /// 启动回退等警告；不写入 settings 覆盖
    pub vault_warning: Option<String>,
}

impl Vault {
    pub fn new(root: PathBuf) -> Self {
        let books = root.join("books");
        let library_file = root.join("library.json");
        Self {
            root,
            books,
            library_file,
            vault_warning: None,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.books)?;
        if !self.library_file.exists() {
            write_json(
                &self.library_file,
                &json!({"version": 1, "books": [], "updatedAt": now_ms()}),
            )?;
        }
        Ok(())
    }

    pub fn book_dir(&self, slug: &str) -> Result<PathBuf> {
        if !is_valid_slug(slug) {
            bail!("invalid slug");
        }
        let p = self
            .books
            .join(slug)
            .canonicalize()
            .unwrap_or_else(|_| self.books.join(slug));
        let base = self
            .books
            .canonicalize()
            .unwrap_or_else(|_| self.books.clone());
        if let Ok(can) = p.canonicalize() {
            if !can.starts_with(&base) {
                bail!("invalid slug path");
            }
            return Ok(can);
        }
        Ok(self.books.join(slug))
    }

    pub fn health(&self) -> Value {
        // books 目录不存在或不可用 → ok:false
        // 注：/api/health 免 token。vault/books 绝对路径为兼容前端 boot 保留；
        // 权威路径以需 token 的 GET /api/settings（vaultPath）为准。
        let books_ok = self.books.is_dir();
        let mut h = json!({
            "ok": books_ok,
            "app": "mogao",
            "version": VERSION,
            "vault": self.root.to_string_lossy(),
            "books": self.books.to_string_lossy(),
            "engine": "tauri-rust",
            "epoch": content_epoch(),
            "auth": "token",
        });
        if !books_ok {
            h["error"] = json!("books directory missing or unavailable");
        }
        if let Some(w) = self.vault_warning.as_ref() {
            h["vaultWarning"] = json!(w);
        }
        h
    }

    pub fn rescan_library(&self) -> Result<Value> {
        self.ensure()?;
        let mut books = vec![];
        if self.books.is_dir() {
            let mut entries: Vec<_> = fs::read_dir(&self.books)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let bj = e.path().join("book.json");
                let proj = read_json(&bj).unwrap_or(json!({}));
                let title = proj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&name)
                    .to_string();
                let updated = proj
                    .get("updatedAt")
                    .and_then(|v| v.as_u64())
                    .unwrap_or_else(|| mtime_ms(&e.path()).unwrap_or(0));
                let chapters = proj
                    .get("chapters")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                books.push(json!({
                    "slug": name,
                    "id": proj.get("id"),
                    "title": title,
                    "updatedAt": updated,
                    "stage": proj.get("stage"),
                    "chapters": chapters,
                    "path": e.path().to_string_lossy(),
                }));
            }
        }
        books.sort_by(|a, b| {
            b.get("updatedAt")
                .and_then(|v| v.as_u64())
                .cmp(&a.get("updatedAt").and_then(|v| v.as_u64()))
        });
        let lib = json!({
            "version": 1,
            "books": books,
            "updatedAt": now_ms(),
            "vault": self.root.to_string_lossy(),
        });
        write_json(&self.library_file, &lib)?;
        Ok(lib)
    }

    /// 在指定路径打开/切换 vault。
    /// - BookDir → 拒绝
    /// - Unknown 且 force=false → 拒绝（需确认）
    /// - EmptyOrMissing / VaultRoot → 允许
    /// - Unknown 且 force=true → 允许 ensure 成 vault
    pub fn open_at(path: PathBuf) -> Result<Self> {
        Self::open_at_with_force(path, false)
    }

    pub fn open_at_with_force(path: PathBuf, force: bool) -> Result<Self> {
        if path.exists() && !path.is_dir() {
            bail!("path is not a directory: {}", path.display());
        }
        match classify_path(&path) {
            PathKind::BookDir => {
                bail!("BOOK_DIR:{}", path.display());
            }
            PathKind::Unknown if !force => {
                bail!("UNKNOWN:{}", path.display());
            }
            PathKind::VaultRoot | PathKind::EmptyOrMissing | PathKind::Unknown => {}
        }
        fs::create_dir_all(&path)?;
        let v = Self::new(path);
        v.ensure()?;
        let cfg = v.root.join(".mogao-config.json");
        if !cfg.exists() {
            let _ = write_json(
                &cfg,
                &json!({
                    "app": "mogao",
                    "version": VERSION,
                    "createdAt": now_ms(),
                }),
            );
        }
        Ok(v)
    }

    /// 新建 vault：path 为父目录，name 可选子目录名
    #[allow(dead_code)]
    pub fn create_at(parent: PathBuf, name: Option<&str>) -> Result<Self> {
        Self::create_at_with_force(parent, name, false)
    }

    pub fn create_at_with_force(parent: PathBuf, name: Option<&str>, force: bool) -> Result<Self> {
        let root = match name {
            Some(n) if !n.trim().is_empty() => {
                let n = n.trim();
                if n.contains("..") || n.contains('/') || n.contains('\\') {
                    bail!("invalid vault name");
                }
                parent.join(n)
            }
            _ => parent,
        };
        if matches!(classify_path(&root), PathKind::BookDir) {
            bail!("BOOK_DIR:{}", root.display());
        }
        Self::open_at_with_force(root, force)
    }

    /// 打开/切换后的统一响应（成功必含 ok:true）
    pub fn open_info(&self) -> Result<Value> {
        let library = self.rescan_library()?;
        Ok(json!({
            "ok": true,
            "kind": "vaultRoot",
            "health": self.health(),
            "library": library,
            "vaultPath": self.root.to_string_lossy(),
            "booksPath": self.books.to_string_lossy(),
            "version": VERSION,
            "epoch": content_epoch(),
        }))
    }

    /// 跨书轻量搜索：title/slug、章节文件名、.md 正文前 ~8KB
    /// 每书最多 8 条 hit；snippet 按 chars 裁剪
    pub fn search(&self, q: &str, limit: usize) -> Result<Value> {
        const PER_BOOK_MAX: usize = 8;
        let q = q.trim();
        let limit = limit.clamp(1, 200);
        let mut hits = Vec::new();
        if q.is_empty() {
            return Ok(json!({ "ok": true, "q": q, "hits": hits }));
        }
        let q_lower = q.to_lowercase();
        self.ensure()?;
        if !self.books.is_dir() {
            return Ok(json!({ "ok": true, "q": q, "hits": hits }));
        }
        let mut entries: Vec<_> = fs::read_dir(&self.books)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        entries.sort_by_key(|e| e.file_name());

        for e in entries {
            if hits.len() >= limit {
                break;
            }
            let slug = e.file_name().to_string_lossy().to_string();
            if slug.starts_with('.') {
                continue;
            }
            let bdir = e.path();
            let proj = read_json(&bdir.join("book.json")).unwrap_or(json!({}));
            let title = proj
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or(&slug)
                .to_string();

            let mut book_hits: usize = 0;
            let remaining_global = limit.saturating_sub(hits.len());
            let book_cap = PER_BOOK_MAX.min(remaining_global);

            // 书级：title / slug（同时输出 title 与 bookTitle 以兼容前后端）
            if title.to_lowercase().contains(&q_lower) || slug.to_lowercase().contains(&q_lower) {
                hits.push(json!({
                    "slug": slug,
                    "title": title,
                    "bookTitle": title,
                    "path": "",
                    "snippet": title,
                    "kind": "book",
                    "group": "other",
                }));
                book_hits += 1;
            }

            if book_hits < book_cap {
                Self::search_book_files(
                    &bdir,
                    &slug,
                    &title,
                    &q_lower,
                    book_cap - book_hits,
                    &mut book_hits,
                    &mut hits,
                )?;
            }
        }

        Ok(json!({
            "ok": true,
            "q": q,
            "hits": hits,
        }))
    }

    fn search_book_files(
        bdir: &Path,
        slug: &str,
        book_title: &str,
        q_lower: &str,
        book_remaining: usize,
        book_hits: &mut usize,
        hits: &mut Vec<Value>,
    ) -> Result<()> {
        const PREVIEW_BYTES: usize = 8 * 1024;
        if book_remaining == 0 {
            return Ok(());
        }
        let mut file_added = 0usize;
        let walker = walkdir::WalkDir::new(bdir)
            .max_depth(6)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                !(name.starts_with('.') || name == "__pycache__")
            });
        for entry in walker.filter_map(|e| e.ok()) {
            if file_added >= book_remaining {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(rel_path) = entry.path().strip_prefix(bdir) else {
                continue;
            };
            let rel = rel_path.to_string_lossy().replace('\\', "/");
            let name_match = name.to_lowercase().contains(q_lower);
            let mut snippet = String::new();
            let mut body_match = false;

            let is_text = name.ends_with(".md")
                || name.ends_with(".txt")
                || name.ends_with(".markdown")
                || name.ends_with(".json");
            if is_text {
                if let Ok(raw) = fs::read(entry.path()) {
                    let mut end = raw.len().min(PREVIEW_BYTES);
                    // 回退到 UTF-8 字符边界（continuation byte = 10xxxxxx）
                    while end > 0 && end < raw.len() && (raw[end] & 0xc0) == 0x80 {
                        end -= 1;
                    }
                    let text = String::from_utf8_lossy(&raw[..end]);
                    let lower = text.to_lowercase();
                    if let Some(byte_idx) = lower.find(q_lower) {
                        body_match = true;
                        // byte 偏移 → char 索引，再按 chars 裁剪 snippet
                        let char_idx = text
                            .char_indices()
                            .take_while(|(i, _)| *i < byte_idx)
                            .count();
                        let q_chars = q_lower.chars().count();
                        let start_char = char_idx.saturating_sub(40);
                        let take_chars = 40 + q_chars + 60;
                        let s: String = text.chars().skip(start_char).take(take_chars).collect();
                        snippet = s.replace('\n', " ").replace('\r', "");
                    }
                }
            }

            if name_match || body_match {
                if snippet.is_empty() {
                    snippet = name.clone();
                }
                hits.push(json!({
                    "slug": slug,
                    "title": book_title,
                    "bookTitle": book_title,
                    "path": rel,
                    "snippet": snippet,
                    "kind": "file",
                    "group": search_group_for_path(&rel),
                }));
                file_added += 1;
                *book_hits += 1;
            }
        }
        Ok(())
    }

    /// 解析「在文件管理器里打开哪里」，含相对路径、越界拒绝、缺失文件回退父目录。
    /// 真正弹窗在 [`util::reveal_path`]；测试构建里不会 spawn。
    pub(crate) fn resolve_reveal_target(&self, path: &str) -> Result<PathBuf> {
        if path.is_empty() {
            return Ok(self.root.clone());
        }
        let raw = PathBuf::from(path);
        // 相对路径一律相对 vault root（前端常传 books/slug/...）
        let p = if raw.is_absolute() {
            raw
        } else {
            self.root.join(raw)
        };
        let root_can = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let target_can = if p.exists() {
            p.canonicalize().unwrap_or_else(|_| p.clone())
        } else if let Some(parent) = p.parent() {
            // 文件可能刚删：仍允许 reveal 父目录（若在 vault 内）
            parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf())
        } else {
            p.clone()
        };
        if !util::path_is_within(&root_can, &target_can) && !util::path_is_within(&root_can, &p) {
            bail!(
                "reveal path outside vault: {} (root {})",
                p.display(),
                self.root.display()
            );
        }
        if p.exists() {
            Ok(p)
        } else if let Some(parent) = p.parent().filter(|x| x.exists()) {
            Ok(parent.to_path_buf())
        } else {
            Ok(self.root.clone())
        }
    }

    pub fn reveal(&self, path: &str) -> Result<()> {
        let target = self.resolve_reveal_target(path)?;
        util::reveal_path(&target)
    }
}

/// 判断 open_at 错误是否为 Unknown 需确认
#[allow(dead_code)]
pub fn is_unknown_open_error(e: &anyhow::Error) -> bool {
    e.to_string().starts_with("UNKNOWN:")
}

/// 判断 open_at 错误是否为 BookDir
#[allow(dead_code)]
pub fn is_book_dir_open_error(e: &anyhow::Error) -> bool {
    e.to_string().starts_with("BOOK_DIR:")
}

#[cfg(test)]
mod slug_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-slug-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn book_dir_rejects_dot_and_traversal() {
        let d = tmp("rej");
        let v = Vault::open_at(d.clone()).unwrap();
        assert!(v.book_dir("").is_err());
        assert!(v.book_dir(".").is_err());
        assert!(v.book_dir("..").is_err());
        assert!(v.book_dir(".hidden").is_err());
        assert!(v.book_dir("a/b").is_err());
        assert!(v.book_dir(r"a\b").is_err());
        assert!(v.book_dir("CON").is_err());
        assert!(v.book_dir("nul").is_err());
        assert!(v.book_dir("PRN").is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn book_dir_accepts_chinese_slug() {
        let d = tmp("ok");
        let v = Vault::open_at(d.clone()).unwrap();
        let p = v.book_dir("红莲渡鹤归").expect("chinese slug ok");
        assert!(p.ends_with("红莲渡鹤归"));
        let p2 = v.book_dir("正常书名-2").expect("normal slug ok");
        assert!(p2.ends_with("正常书名-2"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn is_valid_slug_unit() {
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("."));
        assert!(!is_valid_slug(".."));
        assert!(!is_valid_slug(".foo"));
        assert!(!is_valid_slug("a/b"));
        assert!(is_valid_slug("我的书"));
        assert!(is_valid_slug("book-1"));
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-reveal-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn same_path(a: &Path, b: &Path) -> bool {
        let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
        let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
        ca == cb
    }

    #[test]
    fn reveal_rejects_outside_vault() {
        let d = tmp("jail");
        let v = Vault::open_at(d.clone()).unwrap();
        // 系统临时目录本身通常在 vault 外
        let outside = std::env::temp_dir().join("mogao-reveal-outside-probe");
        let _ = fs::create_dir_all(&outside);
        let err = v.resolve_reveal_target(&outside.to_string_lossy());
        assert!(err.is_err(), "outside path must be rejected");
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("outside") || msg.contains("vault"),
            "msg={msg}"
        );
        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn reveal_accepts_relative_under_vault() {
        let d = tmp("rel");
        let v = Vault::open_at(d.clone()).unwrap();
        let books = d.join("books").join("demo");
        fs::create_dir_all(&books).unwrap();
        let target = v
            .resolve_reveal_target("books/demo")
            .expect("in-vault relative path");
        assert!(
            same_path(&target, &books),
            "relative path must resolve under vault: {target:?} vs {books:?}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn reveal_missing_file_falls_back_to_parent() {
        let d = tmp("missing");
        let v = Vault::open_at(d.clone()).unwrap();
        let books = d.join("books").join("demo");
        fs::create_dir_all(&books).unwrap();
        let missing = books.join("gone.md");
        assert!(!missing.exists());
        let target = v
            .resolve_reveal_target(&missing.to_string_lossy())
            .expect("missing in-vault file may reveal parent");
        assert!(
            same_path(&target, &books),
            "missing file must fall back to parent: {target:?} vs {books:?}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn reveal_empty_path_opens_vault_root() {
        let d = tmp("empty");
        let v = Vault::open_at(d.clone()).unwrap();
        let target = v.resolve_reveal_target("").unwrap();
        assert!(
            same_path(&target, &d),
            "empty path must resolve to vault root"
        );
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod open_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-open-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn unknown_rejected_without_force() {
        let d = tmp("noforce");
        fs::write(d.join("noise.txt"), "x").unwrap();
        let err = match Vault::open_at(d.clone()) {
            Ok(_) => panic!("expected UNKNOWN reject"),
            Err(e) => e,
        };
        assert!(err.to_string().starts_with("UNKNOWN:"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_allowed_with_force() {
        let d = tmp("force");
        fs::write(d.join("noise.txt"), "x").unwrap();
        let v = Vault::open_at_with_force(d.clone(), true).unwrap();
        assert!(v.books.is_dir());
        assert!(v.library_file.is_file());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_ok_without_force() {
        let d = tmp("empty");
        let v = Vault::open_at(d.clone()).unwrap();
        assert!(v.books.is_dir());
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-search-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn search_hit_has_title_and_book_title() {
        let d = tmp("title");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v
            .create_book("红莲渡鹤归", "测试意向")
            .expect("create_book");
        let slug = book.get("slug").and_then(|x| x.as_str()).unwrap();
        let res = v.search("红莲", 20).unwrap();
        assert_eq!(res["ok"], true);
        let hits = res["hits"].as_array().expect("hits array");
        assert!(!hits.is_empty(), "expected at least one hit");
        let h0 = &hits[0];
        assert_eq!(h0["title"].as_str(), Some("红莲渡鹤归"));
        assert_eq!(h0["bookTitle"].as_str(), Some("红莲渡鹤归"));
        assert_eq!(h0["slug"].as_str(), Some(slug));
        assert_eq!(h0["group"].as_str(), Some("other"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn search_paths_map_to_author_facing_groups() {
        assert_eq!(search_group_for_path("章节/001-开场.md"), "chapter");
        assert_eq!(search_group_for_path("关系/graph.json"), "character");
        assert_eq!(
            search_group_for_path("记忆/entity-states.json"),
            "character"
        );
        assert_eq!(search_group_for_path("记忆/canon.json"), "canon");
        assert_eq!(search_group_for_path("记忆/plot-loops.json"), "loop");
        assert_eq!(search_group_for_path("资料/采访.md"), "other");
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-import-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn import_book_dir_returns_ok_slug_library() {
        let vault_root = tmp("vault");
        let v = Vault::open_at(vault_root.clone()).unwrap();

        let src = tmp("srcbook");
        fs::write(
            src.join("book.json"),
            r#"{"title":"导入书甲","id":"imp-1","chapters":[]}"#,
        )
        .unwrap();
        fs::create_dir_all(src.join("章节")).unwrap();

        let res = v.import_book_dir(&src).expect("import");
        assert_eq!(res["ok"], true);
        assert!(res["slug"].as_str().is_some());
        assert!(res.get("library").is_some());
        assert_eq!(res["title"].as_str(), Some("导入书甲"));
        let _ = fs::remove_dir_all(&vault_root);
        let _ = fs::remove_dir_all(&src);
    }
}
