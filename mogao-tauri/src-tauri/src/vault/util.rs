//! 共享工具：时间、JSON、文件名、章节 md、目录复制
#[cfg(not(test))]
use anyhow::anyhow;
use anyhow::Result;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn system_time_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub(crate) fn mtime_ms(p: &Path) -> Option<u64> {
    p.metadata().ok()?.modified().ok().and_then(system_time_ms)
}

pub(crate) fn write_text_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("f"),
        std::process::id()
    ));
    let mut file = fs::File::create(&tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = install_temp_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_temp_file(tmp: &Path, path: &Path) -> Result<()> {
    fs::rename(tmp, path)?;
    Ok(())
}

/// Windows 的 `std::fs::rename` 不能可靠覆盖既有目标。使用 ReplaceFileW
/// 在同卷内原子替换，避免退化为会截断目标文件的 `fs::copy`。
#[cfg(windows)]
fn install_temp_file(tmp: &Path, path: &Path) -> Result<()> {
    if !path.exists() {
        fs::rename(tmp, path)?;
        return Ok(());
    }

    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut c_void,
            reserved: *mut c_void,
        ) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let replaced = wide(path);
    let replacement = wide(tmp);
    let ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(crate) fn write_json(path: &Path, v: &Value) -> Result<()> {
    let s = serde_json::to_string_pretty(v)?;
    write_text_atomic(path, &(s + "\n"))
}

pub(crate) fn read_json(path: &Path) -> Result<Value> {
    let s = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&s)?)
}

pub(crate) fn slugify(title: &str) -> String {
    let re = Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap();
    let s = re.replace_all(title.trim(), "_");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.is_empty() {
        "未命名".into()
    } else {
        s.chars().take(80).collect()
    }
}

/// 递归复制目录
pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest_path)?;
        } else if ty.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// 从 pitch.md 启发式提取卖点与意向正文
pub(crate) fn parse_pitch_md(content: &str) -> (String, String) {
    let text = content.replace("\r\n", "\n");
    let mut pitch = String::new();
    if let Some(idx) = text.find("**卖点**") {
        let after = &text[idx + "**卖点**".len()..];
        let line_rest = after.lines().next().unwrap_or("").trim();
        let line_rest = line_rest.trim_start_matches([':', '：', ' ', '\t']);
        if !line_rest.is_empty() {
            pitch = line_rest.chars().take(200).collect();
        } else {
            for line in after.lines().skip(1) {
                let t = line.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                pitch = t
                    .trim_start_matches(['*', '-', ' '])
                    .chars()
                    .take(200)
                    .collect();
                break;
            }
        }
    }
    let mut idea = String::new();
    if let Some(idx) = text.find("## 意向") {
        let after = &text[idx + "## 意向".len()..];
        let end = after.find("\n## ").unwrap_or(after.len());
        idea = after[..end].trim().to_string();
    }
    if pitch.is_empty() {
        for line in text.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') || t.starts_with("**卖点**") {
                continue;
            }
            pitch = t.chars().take(200).collect();
            break;
        }
        if pitch.is_empty() {
            let body: String = text
                .lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#')
                })
                .collect::<Vec<_>>()
                .join(" ");
            pitch = body.chars().take(200).collect();
        }
    }
    (pitch, idea)
}

pub(crate) fn unique_slug(books: &Path, title: &str) -> Result<String> {
    let base = slugify(title);
    if !books.join(&base).exists() {
        return Ok(base);
    }
    for i in 2..1000 {
        let c = format!("{}-{}", base, i);
        if !books.join(&c).exists() {
            return Ok(c);
        }
    }
    Ok(format!("{}-{}", base, &Uuid::new_v4().to_string()[..6]))
}

pub(crate) fn safe_filename(title: &str, order: u64) -> String {
    let re = Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap();
    let base = re.replace_all(title.trim(), "_");
    let base = base.split_whitespace().collect::<Vec<_>>().join("-");
    let base: String = base.chars().take(60).collect();
    let base = if base.is_empty() {
        format!("第{}章", order)
    } else {
        base
    };
    format!("{:03}-{}.md", order, base)
}

pub(crate) fn default_book(title: &str, idea: &str) -> Value {
    json!({
        "id": Uuid::new_v4().to_string(),
        "slug": "",
        "title": if title.is_empty() { "新书" } else { title },
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "stage": "idea",
        "ideaInput": if idea.is_empty() { title } else { idea },
        "authorNote": "",
        "targetChapters": 20,
        "title_candidates": [],
        "pitch": "",
        "genre": "",
        "sub_genre": "",
        "hooks": [],
        "tone": "",
        "audience": "",
        "risks": [],
        "world": null,
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
            "timeline": ""
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
            "chapterLogs": []
        },
        "appearanceLog": [],
        "chapters": [],
        "activeChapterId": null,
        "activeTaskId": null,
        "pipelineLog": [],
        "autoWrite": false,
    })
}

pub(crate) fn parse_chapter_md(text: &str) -> (HashMap<String, String>, String) {
    let re = Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$").unwrap();
    if let Some(c) = re.captures(text) {
        let mut meta = HashMap::new();
        for line in c.get(1).unwrap().as_str().lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || !line.contains(':') {
                continue;
            }
            let mut sp = line.splitn(2, ':');
            let k = sp.next().unwrap().trim().to_string();
            let mut v = sp.next().unwrap_or("").trim().to_string();
            if (v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\''))
            {
                v = v[1..v.len() - 1].to_string();
            }
            meta.insert(k, v);
        }
        let body = c
            .get(2)
            .unwrap()
            .as_str()
            .trim_start_matches('\n')
            .to_string();
        (meta, body)
    } else {
        (HashMap::new(), text.trim().to_string())
    }
}

pub(crate) fn dump_chapter_md(ch: &Value) -> String {
    let title = ch
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未命名章")
        .replace('"', "");
    let order = ch.get("order").and_then(|v| v.as_u64()).unwrap_or(0);
    let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let task = ch.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
    let updated = ch
        .get("updatedAt")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(now_ms);
    let body = ch.get("body").and_then(|v| v.as_str()).unwrap_or("");
    format!(
        "---\nid: \"{}\"\ntaskId: \"{}\"\ntitle: \"{}\"\norder: {}\nupdatedAt: {}\n---\n\n{}\n",
        id,
        task,
        title,
        order,
        updated,
        body.trim_end()
    )
}

pub(crate) fn reveal_path(path: &Path) -> Result<()> {
    // Unit-test builds must not spawn explorer/open: a GUI machine pops a
    // window, steals focus from Playwright, and the temp dir is already gone.
    #[cfg(test)]
    {
        let _ = path;
        Ok(())
    }
    #[cfg(not(test))]
    {
        reveal_path_in_file_manager(path)
    }
}

#[cfg(not(test))]
fn reveal_path_in_file_manager(path: &Path) -> Result<()> {
    // Windows：explorer 打开目录/选中文件更可靠；open::that 对中文路径/目录常「成功却无窗口」
    #[cfg(windows)]
    {
        use std::process::Command;
        if path.is_dir() {
            Command::new("explorer")
                .arg(path.as_os_str())
                .spawn()
                .map_err(|e| anyhow!("explorer open dir failed: {}", e))?;
            return Ok(());
        }
        if path.is_file() {
            // /select, 需要完整路径字符串
            let arg = format!("/select,{}", path.to_string_lossy());
            Command::new("explorer")
                .arg(arg)
                .spawn()
                .map_err(|e| anyhow!("explorer select file failed: {}", e))?;
            return Ok(());
        }
        // 不存在：仍尝试打开父目录
        if let Some(parent) = path.parent() {
            if parent.is_dir() {
                Command::new("explorer")
                    .arg(parent.as_os_str())
                    .spawn()
                    .map_err(|e| anyhow!("explorer open parent failed: {}", e))?;
                return Ok(());
            }
        }
        return Err(anyhow!("path not found: {}", path.display()));
    }
    #[cfg(not(windows))]
    {
        open::that(path).map_err(|e| anyhow!("reveal failed: {}", e))
    }
}

/// 路径是否在 base 之下（Windows 忽略盘符大小写与 \\?\ 前缀差异）
pub(crate) fn path_is_within(base: &Path, target: &Path) -> bool {
    let b = strip_extended_prefix(base);
    let t = strip_extended_prefix(target);
    #[cfg(windows)]
    {
        let bs = b.to_string_lossy().to_lowercase();
        let ts = t.to_string_lossy().to_lowercase();
        ts == bs || ts.starts_with(&(bs.trim_end_matches('\\').to_string() + "\\"))
    }
    #[cfg(not(windows))]
    {
        t.starts_with(&b)
    }
}

fn strip_extended_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing_file_without_leaving_temp() {
        let root = std::env::temp_dir().join(format!(
            "inkwell-atomic-write-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("book.json");
        write_text_atomic(&path, "old").unwrap();
        write_text_atomic(&path, "new content").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files must be cleaned up");
        let _ = fs::remove_dir_all(root);
    }
}
