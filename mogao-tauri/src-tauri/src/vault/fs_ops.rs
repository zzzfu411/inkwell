//! 书内文件系统操作与镜像回写
use super::tasks::merge_tasks_preserving_progress;
use super::util::{
    default_book, now_ms, parse_chapter_md, parse_pitch_md, read_json, system_time_ms, write_json,
    write_text_atomic,
};
use super::{bump_content_epoch, Vault, EDITABLE, IO_LOCK};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

impl Vault {
    /// 将书内相对路径解析为绝对路径；拒绝 `..` / 绝对前缀 / 越界。
    /// **不** create_dir_all（读路径不应建目录；写方自行建父目录）。
    pub fn safe_rel(&self, slug: &str, rel: &str) -> Result<PathBuf> {
        let bdir = self.book_dir(slug)?;
        let rel = rel.replace('\\', "/").trim_start_matches('/').to_string();
        if rel.is_empty() || rel.contains("..") {
            bail!("invalid path");
        }
        // 按 Path components 拒绝 ParentDir / RootDir / Prefix（含 Windows 盘符）
        let mut normals: Vec<std::ffi::OsString> = Vec::new();
        for c in Path::new(&rel).components() {
            match c {
                Component::Normal(s) => {
                    let s_str = s.to_string_lossy();
                    if s_str.is_empty() || s_str == ".." {
                        bail!("invalid path");
                    }
                    normals.push(s.to_os_string());
                }
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    bail!("invalid path");
                }
            }
        }
        if normals.is_empty() {
            bail!("invalid path");
        }
        // 仅用 Normal 段 join，保证不存在的路径也不会逃出 bdir
        let mut target = bdir.clone();
        for seg in &normals {
            target.push(seg);
        }
        // Validate every existing ancestor, not only the final target. A new
        // file below an existing symlink/junction could otherwise escape the
        // book even though its lexical path starts with bdir.
        let base = bdir.canonicalize().unwrap_or(bdir.clone());
        let mut cursor = bdir.clone();
        for seg in &normals {
            cursor.push(seg);
            if cursor.exists() {
                let canonical = cursor.canonicalize()?;
                if !canonical.starts_with(&base) {
                    bail!("path outside book");
                }
                cursor = canonical;
            }
        }
        // 存在时再 canonicalize 二次校验
        if target.exists() {
            let can = target.canonicalize().unwrap_or(target.clone());
            if !can.starts_with(&base) {
                bail!("path outside book");
            }
        } else if let Ok(stripped) = target.strip_prefix(&bdir) {
            // join 结果必须仍以 bdir 为前缀（component 级已保证；此处防平台怪异）
            for c in stripped.components() {
                if matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                ) {
                    bail!("path outside book");
                }
            }
        } else {
            bail!("path outside book");
        }
        Ok(target)
    }

    pub fn read_file(&self, slug: &str, rel: &str) -> Result<Value> {
        let target = self.safe_rel(slug, rel)?;
        if !target.is_file() {
            bail!("file not found");
        }
        let ext = target
            .extension()
            .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let text = fs::read_to_string(&target)?;
        let meta = target.metadata()?;
        Ok(json!({
            "slug": slug,
            "path": rel.replace('\\', "/"),
            "name": target.file_name().and_then(|s| s.to_str()).unwrap_or(""),
            "ext": ext,
            "content": text,
            "mtime": meta.modified().ok().and_then(system_time_ms).unwrap_or(0),
            "size": meta.len(),
        }))
    }

    pub fn write_file(&self, slug: &str, rel: &str, content: &str) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let target = self.safe_rel(slug, rel)?;
        let ext = target
            .extension()
            .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if !EDITABLE.iter().any(|e| *e == ext) {
            bail!("not editable: {}", ext);
        }
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        write_text_atomic(&target, content)?;
        bump_content_epoch();
        let rel_n = rel.replace('\\', "/");
        if rel_n.starts_with("章节/") && rel_n.ends_with(".md") {
            self.sync_chapter_md(slug, &rel_n, content)?;
        } else {
            self.sync_mirror_file(slug, &rel_n, content)?;
        }
        let meta = target.metadata()?;
        Ok(json!({
            "ok": true,
            "slug": slug,
            "path": rel_n,
            "mtime": meta.modified().ok().and_then(system_time_ms).unwrap_or(0),
            "size": meta.len(),
        }))
    }

    /// 工作区改镜像文件后回写 book.json 对应字段（不经 save_book，避免覆盖其它 md）
    pub(crate) fn sync_mirror_file(&self, slug: &str, rel: &str, content: &str) -> Result<()> {
        let rel = rel.replace('\\', "/");
        let bdir = self.book_dir(slug)?;
        let bj = bdir.join("book.json");
        let mut proj = read_json(&bj).unwrap_or_else(|_| default_book(slug, ""));
        let mut changed = false;

        match rel.as_str() {
            "策划/world.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["world"] = v;
                    changed = true;
                }
            }
            "策划/spine.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["spine"] = v;
                    changed = true;
                }
            }
            "策划/tasks.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    if v.is_array() {
                        let incoming = v.as_array().cloned().unwrap_or_default();
                        let existing = proj
                            .get("tasks")
                            .and_then(|t| t.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let chapters = proj.get("chapters").and_then(|c| c.as_array()).cloned();
                        let merged = merge_tasks_preserving_progress(
                            &existing,
                            &incoming,
                            chapters.as_deref(),
                        );
                        proj["tasks"] = json!(merged);
                        changed = true;
                    }
                    // 非 array → 忽略不覆盖
                }
            }
            "关系/graph.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["graph"] = v;
                    changed = true;
                }
            }
            "记忆/digests.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["memoryRoll"] = v;
                    changed = true;
                }
            }
            "记忆/canon.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["detailCanon"] = v;
                    changed = true;
                }
            }
            "记忆/storyline.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["storyline"] = v;
                    changed = true;
                }
            }
            "记忆/appearances.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["appearanceLog"] = v;
                    changed = true;
                }
            }
            "记忆/plot-loops.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["plotLoops"] = v;
                    changed = true;
                }
            }
            "记忆/continuity-issues.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["continuityIssues"] = v;
                    changed = true;
                }
            }
            "记忆/entity-states.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["entityStates"] = v;
                    changed = true;
                }
            }
            "记忆/timeline-events.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["timelineEvents"] = v;
                    changed = true;
                }
            }
            "记忆/continuity-reviews.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["continuityReviews"] = v;
                    changed = true;
                }
            }
            "记忆/context-manifests.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["contextManifests"] = v;
                    changed = true;
                }
            }
            "策划/style-bible.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["styleBible"] = v;
                    changed = true;
                }
            }
            "锁定/locks.json" => {
                if let Ok(v) = serde_json::from_str::<Value>(content) {
                    proj["locks"] = v;
                    changed = true;
                }
            }
            "策划/pitch.md" => {
                let (pitch, idea_note) = parse_pitch_md(content);
                if !pitch.is_empty() {
                    proj["pitch"] = json!(pitch);
                    changed = true;
                }
                if !idea_note.is_empty() {
                    let existing = proj
                        .get("ideaInput")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if existing.is_empty() {
                        proj["ideaInput"] = json!(idea_note);
                        changed = true;
                    } else if !existing.contains(idea_note.trim()) && idea_note.len() > 8 {
                        proj["pitchNote"] = json!(idea_note.chars().take(500).collect::<String>());
                        changed = true;
                    }
                }
            }
            _ => {}
        }

        if changed {
            proj["slug"] = json!(slug);
            proj["updatedAt"] = json!(now_ms());
            write_json(&bj, &proj)?;
            bump_content_epoch();
        }
        Ok(())
    }

    pub fn fs_mkdir(&self, slug: &str, rel: &str) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let target = self.safe_rel(slug, rel)?;
        if target.exists() && !target.is_dir() {
            bail!("path exists as file");
        }
        fs::create_dir_all(&target)?;
        bump_content_epoch();
        let rel_n = rel.replace('\\', "/").trim_start_matches('/').to_string();
        Ok(json!({
            "ok": true,
            "slug": slug,
            "path": rel_n,
            "type": "dir",
        }))
    }

    pub fn fs_create(&self, slug: &str, rel: &str, content: &str) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let target = self.safe_rel(slug, rel)?;
        if target.exists() {
            bail!("already exists: {}", rel);
        }
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        write_text_atomic(&target, content)?;
        bump_content_epoch();
        let rel_n = rel.replace('\\', "/").trim_start_matches('/').to_string();
        if rel_n.starts_with("章节/") && rel_n.ends_with(".md") {
            self.sync_chapter_md(slug, &rel_n, content)?;
        }
        let meta = target.metadata()?;
        Ok(json!({
            "ok": true,
            "slug": slug,
            "path": rel_n,
            "type": "file",
            "mtime": meta.modified().ok().and_then(system_time_ms).unwrap_or(0),
            "size": meta.len(),
        }))
    }

    pub fn fs_rename(&self, slug: &str, from: &str, to: &str) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let src = self.safe_rel(slug, from)?;
        let dst = self.safe_rel(slug, to)?;
        if !src.exists() {
            bail!("not found: {}", from);
        }
        let from_n = from.replace('\\', "/").trim_start_matches('/').to_string();
        let to_n = to.replace('\\', "/").trim_start_matches('/').to_string();
        // 目标已存在且与源不是同一路径 → 明确拒绝，避免覆盖
        if dst.exists() {
            let same = match (src.canonicalize(), dst.canonicalize()) {
                (Ok(a), Ok(b)) => a == b,
                _ => src == dst,
            };
            if !same {
                bail!("目标已存在: {}", to);
            }
            // 同路径重命名视为成功 no-op
            return Ok(json!({
                "ok": true,
                "slug": slug,
                "from": from_n,
                "to": to_n,
            }));
        }
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p)?;
        }
        fs::rename(&src, &dst)?;
        bump_content_epoch();
        if from_n.starts_with("章节/") && to_n.starts_with("章节/") {
            self.rewrite_chapter_file_ref(slug, &from_n, &to_n)?;
        }
        Ok(json!({
            "ok": true,
            "slug": slug,
            "from": from_n,
            "to": to_n,
        }))
    }

    pub fn fs_delete(&self, slug: &str, rel: &str) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let target = self.safe_rel(slug, rel)?;
        let bdir = self.book_dir(slug)?;
        let base = bdir.canonicalize().unwrap_or(bdir.clone());
        let can = target.canonicalize().unwrap_or(target.clone());
        if !can.starts_with(&base) {
            bail!("path outside book");
        }
        if can == base {
            bail!("cannot delete book root");
        }
        if !target.exists() {
            bail!("not found: {}", rel);
        }
        if target.is_dir() {
            fs::remove_dir_all(&target)?;
        } else {
            fs::remove_file(&target)?;
        }
        bump_content_epoch();
        let rel_n = rel.replace('\\', "/").trim_start_matches('/').to_string();
        if rel_n.starts_with("章节/") && rel_n.ends_with(".md") {
            self.remove_chapter_file_ref(slug, &rel_n)?;
        }
        Ok(json!({
            "ok": true,
            "slug": slug,
            "path": rel_n,
            "deleted": true,
        }))
    }

    fn rewrite_chapter_file_ref(&self, slug: &str, from: &str, to: &str) -> Result<()> {
        let bdir = self.book_dir(slug)?;
        let bj = bdir.join("book.json");
        if !bj.is_file() {
            return Ok(());
        }
        let mut proj = read_json(&bj)?;
        let mut changed = false;
        if let Some(arr) = proj.get_mut("chapters").and_then(|v| v.as_array_mut()) {
            for ch in arr.iter_mut() {
                if ch.get("_file").and_then(|v| v.as_str()) == Some(from) {
                    ch["_file"] = json!(to);
                    changed = true;
                }
            }
        }
        if changed {
            proj["updatedAt"] = json!(now_ms());
            write_json(&bj, &proj)?;
            bump_content_epoch();
        }
        Ok(())
    }

    fn remove_chapter_file_ref(&self, slug: &str, rel: &str) -> Result<()> {
        let bdir = self.book_dir(slug)?;
        let bj = bdir.join("book.json");
        if !bj.is_file() {
            return Ok(());
        }
        let mut proj = read_json(&bj)?;
        let before = proj
            .get("chapters")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        if let Some(arr) = proj.get_mut("chapters").and_then(|v| v.as_array_mut()) {
            arr.retain(|ch| ch.get("_file").and_then(|v| v.as_str()) != Some(rel));
        }
        let after = proj
            .get("chapters")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        if after != before {
            proj["updatedAt"] = json!(now_ms());
            write_json(&bj, &proj)?;
            bump_content_epoch();
        }
        Ok(())
    }

    pub(crate) fn sync_chapter_md(&self, slug: &str, rel: &str, content: &str) -> Result<()> {
        let (meta, body) = parse_chapter_md(content);
        let bdir = self.book_dir(slug)?;
        let mut proj =
            read_json(&bdir.join("book.json")).unwrap_or_else(|_| default_book(slug, ""));
        let mut chapters = proj
            .get("chapters")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let cid = meta.get("id").cloned().unwrap_or_default();
        let mut updated = false;
        for ch in chapters.iter_mut() {
            let match_id =
                !cid.is_empty() && ch.get("id").and_then(|v| v.as_str()) == Some(cid.as_str());
            let match_file = ch.get("_file").and_then(|v| v.as_str()) == Some(rel);
            if match_id || match_file {
                ch["body"] = json!(body);
                if let Some(t) = meta.get("title") {
                    ch["title"] = json!(t);
                }
                ch["updatedAt"] = json!(now_ms());
                updated = true;
                break;
            }
        }
        if !updated {
            chapters.push(json!({
                "id": if cid.is_empty() { Uuid::new_v4().to_string() } else { cid },
                "taskId": meta.get("taskId").cloned().unwrap_or_default(),
                "title": meta.get("title").cloned().unwrap_or_else(|| rel.to_string()),
                "order": meta.get("order").and_then(|s| s.parse::<u64>().ok()).unwrap_or((chapters.len()+1) as u64),
                "body": body,
                "updatedAt": now_ms(),
                "_file": rel,
            }));
        }
        proj["chapters"] = json!(chapters);
        proj["updatedAt"] = json!(now_ms());
        write_json(&bdir.join("book.json"), &proj)?;
        bump_content_epoch();
        Ok(())
    }
}

#[cfg(test)]
mod safe_rel_tests {
    use super::*;
    use crate::vault::Vault;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_vault(tag: &str) -> (PathBuf, Vault, String) {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-saferel-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        let v = Vault::open_at(p.clone()).unwrap();
        let book = v.create_book("测路径", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();
        (p, v, slug)
    }

    #[test]
    fn safe_rel_rejects_parent_dir() {
        let (root, v, slug) = tmp_vault("parent");
        assert!(v.safe_rel(&slug, "../x").is_err());
        assert!(v.safe_rel(&slug, "foo/../../etc").is_err());
        assert!(v.safe_rel(&slug, r"..\x").is_err());
        // 合法相对路径应成功
        let ok = v.safe_rel(&slug, "章节/hello.md");
        assert!(ok.is_ok(), "{:?}", ok.err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn safe_rel_rejects_nonexistent_file_below_external_link() {
        let (root, v, slug) = tmp_vault("link-parent");
        let outside = root.with_extension("outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        let link = v.book_dir(&slug).unwrap().join("external-link");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, &link) {
            eprintln!(
                "symlink test skipped because this Windows account cannot create links: {error}"
            );
            let _ = fs::remove_dir_all(&outside);
            let _ = fs::remove_dir_all(&root);
            return;
        }

        let result = v.safe_rel(&slug, "external-link/new-file.json");
        assert!(result.is_err(), "an external link parent must be rejected");
        assert!(!outside.join("new-file.json").exists());

        if link.exists() {
            let _ = fs::remove_dir(&link);
        }
        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fs_rename_rejects_existing_target() {
        let (root, v, slug) = tmp_vault("rename");
        v.fs_create(&slug, "章节/a.md", "# a\n").unwrap();
        v.fs_create(&slug, "章节/b.md", "# b\n").unwrap();
        let err = v.fs_rename(&slug, "章节/a.md", "章节/b.md");
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("目标已存在") || msg.contains("target exists"),
            "msg={msg}"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
