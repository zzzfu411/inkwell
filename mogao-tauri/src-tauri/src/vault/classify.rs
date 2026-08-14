//! 路径类型探测：vault 根 / 单书 / 空 / 未知
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 目录类型：开库前探测，避免把单书目录当 vault
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    /// 已有 `books/` 或 `library.json`
    VaultRoot,
    /// 有 `book.json` 或 `章节/`，且不是 VaultRoot
    BookDir,
    /// 不存在或空目录
    EmptyOrMissing,
    /// 其它非空目录
    Unknown,
}

/// 探测路径属于 vault 根 / 单书目录 / 空 / 未知
pub fn classify_path(path: &Path) -> PathKind {
    if !path.exists() {
        return PathKind::EmptyOrMissing;
    }
    if !path.is_dir() {
        return PathKind::Unknown;
    }
    // VaultRoot 优先：有 books/ 目录或 library.json
    if path.join("books").is_dir() || path.join("library.json").is_file() {
        return PathKind::VaultRoot;
    }
    // BookDir：单书结构
    if path.join("book.json").is_file() || path.join("章节").is_dir() {
        return PathKind::BookDir;
    }
    // 空目录
    match fs::read_dir(path) {
        Ok(mut rd) => {
            if rd.next().is_none() {
                return PathKind::EmptyOrMissing;
            }
        }
        Err(_) => return PathKind::EmptyOrMissing,
    }
    PathKind::Unknown
}

impl PathKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PathKind::VaultRoot => "vaultRoot",
            PathKind::BookDir => "bookDir",
            PathKind::EmptyOrMissing => "emptyOrMissing",
            PathKind::Unknown => "unknown",
        }
    }
}

/// BookDir 开库时的结构化拒绝信息
pub fn book_dir_reject_value(path: &Path) -> Value {
    let parent = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "ok": false,
        "kind": "bookDir",
        "message": "所选目录是单书目录（含 book.json 或 章节/），不是书库根目录",
        "suggestion": "可导入为书或选择上级 vault",
        "path": path.to_string_lossy(),
        "parent": parent,
        "canImport": true,
    })
}

/// Unknown 非空目录开库时的结构化拒绝（需 force 确认）
pub fn unknown_reject_value(path: &Path) -> Value {
    json!({
        "ok": false,
        "kind": "unknown",
        "message": "该目录不是标准书库（无 books/ 或 library.json），强制打开将在此创建 books/ 结构",
        "requireConfirm": true,
        "path": path.to_string_lossy(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-classify-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn classify_empty_or_missing() {
        let missing = std::env::temp_dir().join(format!(
            "mogao-missing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        assert_eq!(classify_path(&missing), PathKind::EmptyOrMissing);

        let empty = tmp_dir("empty");
        assert_eq!(classify_path(&empty), PathKind::EmptyOrMissing);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn classify_vault_root() {
        let root = tmp_dir("vault");
        fs::create_dir_all(root.join("books")).unwrap();
        assert_eq!(classify_path(&root), PathKind::VaultRoot);
        let _ = fs::remove_dir_all(&root);

        let root2 = tmp_dir("vault2");
        fs::write(root2.join("library.json"), "{}").unwrap();
        assert_eq!(classify_path(&root2), PathKind::VaultRoot);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn classify_book_dir() {
        let d = tmp_dir("book");
        fs::write(d.join("book.json"), r#"{"title":"t"}"#).unwrap();
        assert_eq!(classify_path(&d), PathKind::BookDir);
        let _ = fs::remove_dir_all(&d);

        let d2 = tmp_dir("book2");
        fs::create_dir_all(d2.join("章节")).unwrap();
        assert_eq!(classify_path(&d2), PathKind::BookDir);
        let _ = fs::remove_dir_all(&d2);
    }

    #[test]
    fn classify_unknown() {
        let d = tmp_dir("unk");
        fs::write(d.join("readme.txt"), "hi").unwrap();
        assert_eq!(classify_path(&d), PathKind::Unknown);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_reject_has_require_confirm() {
        let d = tmp_dir("rej");
        fs::write(d.join("x"), "1").unwrap();
        let v = unknown_reject_value(&d);
        assert_eq!(v["ok"], false);
        assert_eq!(v["kind"], "unknown");
        assert_eq!(v["requireConfirm"], true);
        assert!(v.get("path").is_some());
        let _ = fs::remove_dir_all(&d);
    }
}
