//! Content revisions are opaque CAS tokens. Timestamps are only display/watch hints.
use anyhow::{bail, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub fn content_revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

pub fn metadata_revision(dir: &Path) -> Result<String> {
    let book = dir.join("book.json");
    if !book.is_file() {
        return Ok("missing".into());
    }
    let mut value: Value = serde_json::from_str(&fs::read_to_string(book)?)?;
    if let Some(obj) = value.as_object_mut() {
        obj.retain(|key, _| !key.starts_with('_') && key != "chapters" && key != "updatedAt");
    }
    Ok(content_revision(&serde_json::to_string(&value)?))
}

pub fn check_revision(
    expected: Option<&str>,
    actual: &str,
    required: bool,
    kind: &str,
) -> Result<()> {
    match expected {
        Some(token) if token != actual => {
            bail!("{kind}_CONFLICT: 磁盘版本已变化，当前草稿已保留，请比较版本后重试")
        }
        None if required => bail!("REVISION_REQUIRED: 缺少保存基线，请重新读取后保存"),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use serde_json::json;

    struct Fixture(Vault, String);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("inkwell-revision-{}", uuid::Uuid::new_v4()));
            let vault = Vault::open_at(dir).unwrap();
            let mut book = vault.create_book("保存协议", "").unwrap();
            let slug = book["slug"].as_str().unwrap().to_string();
            book["chapters"] = json!([{"id":"c1", "title":"第一章", "order":1, "body":"Original"}]);
            vault.save_book_checked(&slug, book).unwrap();
            Self(vault, slug)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.root);
        }
    }

    #[test]
    fn stale_metadata_and_missing_revision_fail_before_any_write() {
        let Fixture(ref vault, ref slug) = Fixture::new();
        let mut a = vault.load_book(slug).unwrap();
        let mut b = a.clone();
        b["locks"]["logline"] = json!("External setting");
        vault.save_book_checked(slug, b).unwrap();
        a["chapters"][0]["body"] = json!("Stale author draft");
        assert!(vault
            .save_book_checked(slug, a)
            .unwrap_err()
            .to_string()
            .starts_with("BOOK_CONFLICT"));
        let disk = vault.load_book(slug).unwrap();
        assert_eq!(disk["locks"]["logline"], "External setting");
        assert!(disk["chapters"][0]["body"]
            .as_str()
            .unwrap()
            .contains("Original"));
        let mut legacy = disk.clone();
        legacy.as_object_mut().unwrap().remove("_bookRevision");
        assert!(vault
            .save_book_checked(slug, legacy)
            .unwrap_err()
            .to_string()
            .starts_with("REVISION_REQUIRED"));
    }

    #[test]
    fn authoritative_clear_survives_reload_and_slim_does_not_clear() {
        let Fixture(ref vault, ref slug) = Fixture::new();
        let mut slim = vault.load_book(slug).unwrap();
        slim["chapters"][0]["body"] = json!("");
        slim["chapters"][0]["_bodyLoaded"] = json!(false);
        let kept = vault.save_book_checked(slug, slim).unwrap();
        assert_eq!(kept["_saveWarnings"][0]["kind"], "preservedExternal");
        let mut complete = vault.load_book(slug).unwrap();
        complete["chapters"][0]["body"] = json!("");
        vault.save_book_checked(slug, complete).unwrap();
        assert_eq!(vault.load_book(slug).unwrap()["chapters"][0]["body"], "");
    }

    #[test]
    fn file_and_chapter_hashes_protect_equal_timestamp_edits() {
        let Fixture(ref vault, ref slug) = Fixture::new();
        let mut stale = vault.load_book(slug).unwrap();
        let rel = stale["chapters"][0]["_file"].as_str().unwrap().to_string();
        let file = vault.read_file(slug, &rel).unwrap();
        let path = vault.safe_rel(slug, &rel).unwrap();
        let old_time = fs::metadata(&path).unwrap().modified().unwrap();
        let external = file["content"]
            .as_str()
            .unwrap()
            .replace("Original", "External");
        fs::write(&path, &external).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old_time)
            .unwrap();
        assert!(vault
            .write_file_checked(slug, &rel, "Stale", file["revision"].as_str())
            .unwrap_err()
            .to_string()
            .starts_with("FILE_CONFLICT"));
        stale["chapters"][0]["body"] = json!("Stale");
        let protected = vault.save_book_checked(slug, stale).unwrap();
        assert_eq!(protected["_saveWarnings"][0]["kind"], "externalConflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), external);
        let fresh = vault.read_file(slug, &rel).unwrap();
        let saved = vault
            .write_file_checked(slug, &rel, &external, fresh["revision"].as_str())
            .unwrap();
        assert_eq!(saved["revision"], fresh["revision"]);
    }

    #[test]
    fn timestamp_only_change_does_not_block_a_valid_edit() {
        let Fixture(ref vault, ref slug) = Fixture::new();
        let mut draft = vault.load_book(slug).unwrap();
        let path = vault
            .safe_rel(slug, draft["chapters"][0]["_file"].as_str().unwrap())
            .unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH)
            .unwrap();
        draft["chapters"][0]["body"] = json!("Saved after timestamp reset");
        let saved = vault.save_book_checked(slug, draft).unwrap();
        assert!(saved.get("_saveWarnings").is_none());
        assert!(vault.load_book(slug).unwrap()["chapters"][0]["body"]
            .as_str()
            .unwrap()
            .contains("Saved after timestamp reset"));
    }
}
