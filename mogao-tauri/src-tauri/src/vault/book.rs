//! 书生命周期：创建 / 加载 / 保存 / 删除 / 重命名 / 导入 / 快照 / 树
use super::classify::{classify_path, PathKind};
use super::util::{
    copy_dir_all, default_book, dump_chapter_md, mtime_ms, now_ms, parse_chapter_md, read_json,
    safe_filename, slugify, system_time_ms, unique_slug, write_json, write_text_atomic,
};
use super::{
    bump_content_epoch, content_epoch, Vault, AUTO_SNAPSHOT_MIN_INTERVAL_MS, HISTORY_KEEP, IO_LOCK,
    VERSION,
};
use anyhow::{bail, Result};
use chrono::Local;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use uuid::Uuid;
use walkdir::WalkDir;

/// 保存后回传每章的落盘基线（文件名 + mtime）。
///
/// 客户端必须拿它刷新乐观并发的比对点：保存本身会重写章节文件、把 mtime 推新，
/// 基线不跟着走的话，同一次会话里第二次改同一章就会被判成「外部修改」。
pub fn chapter_baselines(project: &Value) -> Value {
    let rows: Vec<Value> = project
        .get("chapters")
        .and_then(|v| v.as_array())
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|ch| {
            let file = ch.get("_file").and_then(|v| v.as_str())?;
            let mtime = ch.get("_fileMtime").and_then(|v| v.as_u64())?;
            if file.is_empty() || mtime == 0 {
                return None;
            }
            Some(json!({
                "id": ch.get("id").cloned().unwrap_or(Value::Null),
                "order": ch.get("order").cloned().unwrap_or(Value::Null),
                "file": file,
                "mtime": mtime,
            }))
        })
        .collect();
    json!(rows)
}

impl Vault {
    pub fn create_book(&self, title: &str, idea: &str) -> Result<Value> {
        self.ensure()?;
        // slug 选择和目录占位必须在同一写锁内，否则并发同名请求会
        // 计算出相同 slug，随后把两个项目写进同一目录。
        let slug = {
            let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let slug = unique_slug(&self.books, title)?;
            fs::create_dir(&self.books.join(&slug))?;
            slug
        };
        let mut proj = default_book(title, idea);
        proj["slug"] = json!(slug);
        proj["pipelineLog"] = json!([{
            "t": now_ms(),
            "msg": format!("创建本地书夹 vault/books/{} (Tauri)", slug)
        }]);
        if let Err(error) = self.save_book(&slug, proj.clone(), false) {
            let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let _ = fs::remove_dir_all(self.books.join(&slug));
            return Err(error);
        }
        Ok(proj)
    }

    pub fn delete_book(&self, slug: &str) -> Result<()> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = self.book_dir(slug)?;
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        bump_content_epoch();
        let _ = self.rescan_library();
        Ok(())
    }

    pub fn load_book(&self, slug: &str) -> Result<Value> {
        let bdir = self.book_dir(slug)?;
        if !bdir.is_dir() {
            bail!("book not found: {}", slug);
        }
        let mut proj =
            read_json(&bdir.join("book.json")).unwrap_or_else(|_| default_book(slug, ""));
        proj["slug"] = json!(slug);
        let stored = proj
            .get("chapters")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let chap_dir = bdir.join("章节");
        let loaded = Self::load_chapters_from_disk(&chap_dir, &stored)?;
        if !loaded.is_empty() {
            proj["chapters"] = json!(loaded);
        }
        // 记忆侧车文件可补缺 / 覆盖空字段
        if proj
            .get("memoryRoll")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true)
        {
            if let Ok(v) = read_json(&bdir.join("记忆").join("digests.json")) {
                proj["memoryRoll"] = v;
            }
        }
        if proj.get("detailCanon").is_none()
            || proj
                .get("detailCanon")
                .and_then(|v| v.get("facts"))
                .and_then(|v| v.as_array())
                .map(|a| a.is_empty())
                .unwrap_or(true)
        {
            if let Ok(v) = read_json(&bdir.join("记忆").join("canon.json")) {
                proj["detailCanon"] = v;
            }
        }
        if proj.get("storyline").is_none()
            || proj
                .get("storyline")
                .and_then(|v| v.get("positionSummary"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
        {
            if let Ok(v) = read_json(&bdir.join("记忆").join("storyline.json")) {
                if !v.is_null() {
                    proj["storyline"] = v;
                }
            }
        }
        if proj
            .get("appearanceLog")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true)
        {
            if let Ok(v) = read_json(&bdir.join("记忆").join("appearances.json")) {
                proj["appearanceLog"] = v;
            }
        }
        for (field, file, object_value) in [
            ("plotLoops", "plot-loops.json", false),
            ("continuityIssues", "continuity-issues.json", false),
            ("entityStates", "entity-states.json", true),
            ("timelineEvents", "timeline-events.json", false),
            ("continuityReviews", "continuity-reviews.json", false),
            ("contextManifests", "context-manifests.json", false),
        ] {
            let missing = if object_value {
                proj.get(field)
                    .and_then(|v| v.as_object())
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
            } else {
                proj.get(field)
                    .and_then(|v| v.as_array())
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
            };
            if missing {
                if let Ok(v) = read_json(&bdir.join("记忆").join(file)) {
                    proj[field] = v;
                }
            }
        }
        if proj
            .get("styleBible")
            .and_then(|v| v.as_object())
            .map(|v| v.is_empty())
            .unwrap_or(true)
        {
            if let Ok(v) = read_json(&bdir.join("策划").join("style-bible.json")) {
                proj["styleBible"] = v;
            }
        }
        // RAG runtime data is kept in a sidecar. The browser rebuilds the
        // inverted index from these compact documents after loading.
        if let Ok(v) = read_json(&bdir.join("记忆").join("rag-index.json")) {
            if v.get("docs").and_then(|docs| docs.as_array()).is_some() {
                proj["ragIndex"] = v;
            }
        }
        proj["_path"] = json!(bdir.to_string_lossy());
        proj["_mtime"] = json!(mtime_ms(&bdir.join("book.json")).unwrap_or(0));
        Ok(proj)
    }

    pub fn save_book(&self, slug: &str, mut project: Value, do_snapshot: bool) -> Result<Value> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let bdir = self.book_dir(slug)?;
        fs::create_dir_all(&bdir)?;
        for sub in ["章节", "策划", "关系", "记忆", "锁定"] {
            fs::create_dir_all(bdir.join(sub))?;
        }
        if do_snapshot {
            let _ = self.maybe_snapshot(slug, "auto");
        }
        if project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            project["id"] = json!(Uuid::new_v4().to_string());
        }
        project["slug"] = json!(slug);
        project["updatedAt"] = json!(now_ms());
        let rag_index = project.get("ragIndex").cloned();

        // clearChapters 仅控制是否允许删光章节 md
        let clear_chapters = project
            .get("clearChapters")
            .or_else(|| project.get("_clearChapters"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let force_chapter_overwrite = project
            .get("_forceChapterOverwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let has_chapters_key = project
            .as_object()
            .map(|o| o.contains_key("chapters"))
            .unwrap_or(false);

        project.as_object_mut().map(|o| {
            o.remove("_path");
            o.remove("_dirty");
            o.remove("_mtime");
            o.remove("_stub");
            o.remove("clearChapters");
            o.remove("_clearChapters");
            o.remove("_forceChapterOverwrite");
        });

        let chap_dir = bdir.join("章节");
        let disk_stored = read_json(&bdir.join("book.json"))
            .ok()
            .and_then(|v| v.get("chapters").and_then(|c| c.as_array()).cloned())
            .unwrap_or_default();
        let (stored_by_id, stored_by_file) = Self::index_stored_chapters(&disk_stored);
        let mut new_chapters = vec![];
        let mut save_warnings: Vec<Value> = vec![];

        if !has_chapters_key {
            // 无 chapters 键：不写/不删章节目录，从磁盘 load 合并进 book.json
            new_chapters = Self::load_chapters_from_disk(&chap_dir, &disk_stored)?;
            project["chapters"] = json!(new_chapters.clone());
        } else {
            let chapters = project
                .get("chapters")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if chapters.is_empty() && !clear_chapters {
                // 空数组且未 clearChapters：不删现有 md；chapters 从磁盘保留
                eprintln!(
                    "[mogao] save_book({slug}): empty chapters without clearChapters — keep disk md"
                );
                new_chapters = Self::load_chapters_from_disk(&chap_dir, &disk_stored)?;
                project["chapters"] = json!(new_chapters.clone());
            } else {
                // 正常写章。未知/外部新增章节默认保留；只有 clearChapters 才允许删光。
                let mut keep = HashSet::new();
                for (i, ch) in chapters.iter().enumerate() {
                    let mut ch = ch.clone();
                    let order = ch
                        .get("order")
                        .and_then(|v| v.as_u64())
                        .unwrap_or((i + 1) as u64);
                    ch["order"] = json!(order);
                    let title = ch
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("第{}章", order))
                        .to_string();
                    let mut name = safe_filename(&title, order);
                    if keep.contains(&name) {
                        let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("x");
                        name = format!(
                            "{}-{}.md",
                            name.trim_end_matches(".md"),
                            &id[..id.len().min(6)]
                        );
                    }
                    let old_name = ch
                        .get("_file")
                        .and_then(|v| v.as_str())
                        .map(|s| s.replace('\\', "/"))
                        .and_then(|s| s.strip_prefix("章节/").map(str::to_string))
                        .filter(|s| !s.is_empty() && !s.contains('/') && !s.contains(".."));
                    let target_path = chap_dir.join(&name);
                    let source_path = old_name
                        .as_ref()
                        .map(|old| chap_dir.join(old))
                        .filter(|p| p.is_file())
                        .unwrap_or_else(|| target_path.clone());

                    // 乐观并发：自加载以来磁盘文件变新且内容/标题不同，则保留磁盘版本。
                    if source_path.is_file() && !force_chapter_overwrite {
                        let disk_mtime = mtime_ms(&source_path).unwrap_or(0);
                        let baseline = ch.get("_fileMtime").and_then(|v| v.as_u64()).unwrap_or(0);
                        let incoming_updated =
                            ch.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
                        let raw = fs::read_to_string(&source_path)?;
                        let (disk_meta, disk_body) = parse_chapter_md(&raw);
                        let incoming_body = ch.get("body").and_then(|v| v.as_str()).unwrap_or("");
                        // slim 缓存会把已落盘章的 body 置成空串；禁止用空串原子盖掉磁盘正文。
                        if incoming_body.trim().is_empty() && !disk_body.trim().is_empty() {
                            let disk_name = source_path
                                .file_name()
                                .and_then(|s| s.to_str())
                                .unwrap_or(&name)
                                .to_string();
                            keep.insert(disk_name.clone());
                            let disk_ch = Self::merge_loaded_chapter(
                                Self::load_chapter_path(&source_path, order)?,
                                Some(&ch),
                            );
                            save_warnings.push(json!({
                                "kind": "preservedExternal",
                                "path": format!("章节/{disk_name}"),
                                "chapterId": disk_ch.get("id").cloned().unwrap_or(Value::Null),
                                "message": "incoming 正文为空，已保留磁盘章节",
                            }));
                            new_chapters.push(disk_ch);
                            continue;
                        }
                        let disk_title = disk_meta.get("title").map(String::as_str).unwrap_or("");
                        let content_diff = disk_body != incoming_body
                            || (!disk_title.is_empty() && disk_title != title);
                        let disk_changed = if baseline > 0 {
                            disk_mtime > baseline.saturating_add(1)
                        } else {
                            disk_mtime > incoming_updated.saturating_add(500)
                        };
                        if content_diff && disk_changed {
                            let disk_name = source_path
                                .file_name()
                                .and_then(|s| s.to_str())
                                .unwrap_or(&name)
                                .to_string();
                            keep.insert(disk_name.clone());
                            let disk_ch = Self::merge_loaded_chapter(
                                Self::load_chapter_path(&source_path, order)?,
                                Some(&ch),
                            );
                            save_warnings.push(json!({
                                "kind": "externalConflict",
                                "path": format!("章节/{disk_name}"),
                                "chapterId": disk_ch.get("id").cloned().unwrap_or(Value::Null),
                                "message": "检测到较新的外部修改，已保留磁盘版本",
                            }));
                            new_chapters.push(disk_ch);
                            continue;
                        }
                    }

                    keep.insert(name.clone());
                    ch["_file"] = json!(format!("章节/{}", name));
                    let md = dump_chapter_md(&ch);
                    let chap_path = target_path;
                    let same = chap_path
                        .is_file()
                        .then(|| fs::read_to_string(&chap_path).ok())
                        .flatten()
                        .map(|existing| existing == md)
                        .unwrap_or(false);
                    if !same {
                        write_text_atomic(&chap_path, &md)?;
                    }
                    // 标题改名：稳定 _file 指向旧文件时，在新文件成功写入后清理旧名。
                    if let Some(old) = old_name.as_ref().filter(|old| *old != &name) {
                        let old_path = chap_dir.join(old);
                        if old_path.is_file() {
                            fs::remove_file(old_path)?;
                        }
                    }
                    ch["_fileMtime"] = json!(mtime_ms(&chap_path).unwrap_or(now_ms()));
                    new_chapters.push(ch);
                }
                if chap_dir.is_dir() {
                    for e in fs::read_dir(&chap_dir)? {
                        let e = e?;
                        let n = e.file_name().to_string_lossy().to_string();
                        if n.ends_with(".md") && !keep.contains(&n) {
                            if clear_chapters {
                                fs::remove_file(e.path())?;
                            } else {
                                let loaded = Self::load_chapter_path(
                                    &e.path(),
                                    (new_chapters.len() + 1) as u64,
                                )?;
                                let md_id = loaded
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .filter(|id| !id.is_empty());
                                let stored = md_id
                                    .and_then(|id| stored_by_id.get(id))
                                    .or_else(|| stored_by_file.get(&n));
                                let disk_ch = Self::merge_loaded_chapter(loaded, stored);
                                let disk_id = disk_ch.get("id").and_then(|v| v.as_str());
                                let already_present = disk_id.is_some_and(|id| {
                                    new_chapters
                                        .iter()
                                        .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                                });
                                if !already_present {
                                    save_warnings.push(json!({
                                        "kind": "preservedExternal",
                                        "path": format!("章节/{n}"),
                                        "chapterId": disk_ch.get("id").cloned().unwrap_or(Value::Null),
                                        "message": "发现工程列表外的章节文件，已保留并合并",
                                    }));
                                    new_chapters.push(disk_ch);
                                }
                            }
                        }
                    }
                }
                new_chapters.sort_by(|a, b| {
                    a.get("order")
                        .and_then(|v| v.as_u64())
                        .cmp(&b.get("order").and_then(|v| v.as_u64()))
                });
                project["chapters"] = json!(new_chapters.clone());
            }
        }

        // 整本 PUT：payload 里出现 tasks 数组即为权威列表（含用户删除）。
        // 重跑主线的进度保留由客户端 mergeTasksPreservingProgress、
        // 以及资料区「策划/tasks.json」写入路径上的 merge 负责，这里不再二次追加。
        if !project.get("tasks").map(Value::is_array).unwrap_or(false) {
            let existing_tasks = {
                let from_book = read_json(&bdir.join("book.json"))
                    .ok()
                    .and_then(|v| v.get("tasks").and_then(|t| t.as_array()).cloned());
                let from_tasks_json = read_json(&bdir.join("策划").join("tasks.json"))
                    .ok()
                    .and_then(|v| v.as_array().cloned());
                from_book.or(from_tasks_json).unwrap_or_default()
            };
            project["tasks"] = json!(existing_tasks);
        }

        let pitch = project
            .get("pitch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = project
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(slug)
            .to_string();
        let pitch_md = format!(
            "# {}\n\n**卖点** {}\n\n## 意向\n\n{}\n",
            title,
            pitch,
            project
                .get("ideaInput")
                .and_then(|v| v.as_str())
                .unwrap_or("")
        );
        write_text_atomic(&bdir.join("策划").join("pitch.md"), &pitch_md)?;
        write_json(
            &bdir.join("策划").join("world.json"),
            project.get("world").unwrap_or(&Value::Null),
        )?;
        write_json(
            &bdir.join("策划").join("spine.json"),
            project.get("spine").unwrap_or(&json!({})),
        )?;
        write_json(
            &bdir.join("策划").join("tasks.json"),
            project.get("tasks").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("关系").join("graph.json"),
            project
                .get("graph")
                .unwrap_or(&json!({"nodes":[],"edges":[]})),
        )?;
        write_json(
            &bdir.join("记忆").join("digests.json"),
            project.get("memoryRoll").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("canon.json"),
            project
                .get("detailCanon")
                .unwrap_or(&json!({"facts":[],"conflicts":[]})),
        )?;
        write_json(
            &bdir.join("记忆").join("storyline.json"),
            project.get("storyline").unwrap_or(&json!({})),
        )?;
        write_json(
            &bdir.join("记忆").join("appearances.json"),
            project.get("appearanceLog").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("plot-loops.json"),
            project.get("plotLoops").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("continuity-issues.json"),
            project.get("continuityIssues").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("entity-states.json"),
            project.get("entityStates").unwrap_or(&json!({})),
        )?;
        write_json(
            &bdir.join("记忆").join("timeline-events.json"),
            project.get("timelineEvents").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("continuity-reviews.json"),
            project.get("continuityReviews").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("记忆").join("context-manifests.json"),
            project.get("contextManifests").unwrap_or(&json!([])),
        )?;
        write_json(
            &bdir.join("策划").join("style-bible.json"),
            project.get("styleBible").unwrap_or(&json!({})),
        )?;
        // RAG 索引（仅 docs，加载时重建 inverted）
        if let Some(ri) = rag_index.as_ref() {
            // 精简：只存 docs 列表
            if let Some(docs) = ri.get("docs") {
                let slim = json!({
                    "version": ri.get("version").cloned().unwrap_or(json!(2)),
                    "builtAt": ri.get("builtAt").cloned().unwrap_or(json!(0)),
                    "_sig": ri.get("_sig").cloned().unwrap_or(Value::Null),
                    "docs": docs,
                });
                write_json(&bdir.join("记忆").join("rag-index.json"), &slim)?;
            }
        }
        // 人可读细节设定（工作区可直接打开）
        if let Some(md) = project.get("detailCanonMarkdown").and_then(|v| v.as_str()) {
            if !md.is_empty() {
                write_text_atomic(&bdir.join("记忆").join("细节设定.md"), md)?;
            }
        }
        write_json(
            &bdir.join("锁定").join("locks.json"),
            project.get("locks").unwrap_or(&json!({})),
        )?;
        // Large/runtime-only fields must not inflate book.json. RAG documents
        // are already written to the sidecar above; retrieval hits are ephemeral.
        if let Some(obj) = project.as_object_mut() {
            obj.remove("ragIndex");
            obj.remove("_lastRag");
            obj.remove("_lastContextManifest");
            obj.remove("_saveWarnings");
        }
        write_json(&bdir.join("book.json"), &project)?;
        let readme = format!(
            "# {}\n\n> {}\n\n- 引擎: Tauri/Rust {}\n- 章节: {}\n",
            title,
            pitch,
            VERSION,
            new_chapters.len()
        );
        write_text_atomic(&bdir.join("README.md"), &readme)?;
        bump_content_epoch();
        let _ = self.rescan_library();
        if !save_warnings.is_empty() {
            project["_saveWarnings"] = json!(save_warnings);
        }
        Ok(project)
    }

    fn chapter_file_name(ch: &Value) -> Option<String> {
        ch.get("_file")
            .and_then(|v| v.as_str())
            .map(|s| s.replace('\\', "/"))
            .and_then(|s| {
                s.strip_prefix("章节/").map(str::to_string).filter(|name| {
                    !name.is_empty() && !name.contains('/') && name != ".." && name != "."
                })
            })
    }

    fn index_stored_chapters(
        chapters: &[Value],
    ) -> (HashMap<String, Value>, HashMap<String, Value>) {
        let mut by_id = HashMap::new();
        let mut by_file = HashMap::new();
        for ch in chapters {
            if let Some(id) = ch
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                by_id.insert(id.to_string(), ch.clone());
            }
            if let Some(name) = Self::chapter_file_name(ch) {
                by_file.insert(name, ch.clone());
            }
        }
        (by_id, by_file)
    }

    fn merge_loaded_chapter(loaded: Value, stored: Option<&Value>) -> Value {
        let mut merged = match stored {
            Some(value) if value.is_object() => value.clone(),
            _ => json!({}),
        };
        let Some(obj) = merged.as_object_mut() else {
            return loaded;
        };
        for key in [
            "taskId",
            "title",
            "order",
            "body",
            "updatedAt",
            "_file",
            "_fileMtime",
        ] {
            if let Some(value) = loaded.get(key) {
                let skip_empty = matches!(key, "taskId" | "title")
                    && value.as_str().map(|s| s.is_empty()).unwrap_or(false)
                    && obj
                        .get(key)
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);
                if !skip_empty {
                    obj.insert(key.to_string(), value.clone());
                }
            }
        }
        let md_id = loaded
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        if let Some(id) = md_id {
            obj.insert("id".into(), json!(id));
        } else if obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(true)
        {
            obj.insert("id".into(), json!(Uuid::new_v4().to_string()));
        }
        merged
    }

    fn load_chapter_path(path: &Path, fallback_order: u64) -> Result<Value> {
        let raw = fs::read_to_string(path)?;
        let (meta, body) = parse_chapter_md(&raw);
        let id = meta.get("id").cloned().unwrap_or_default();
        let order = meta
            .get("order")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(fallback_order);
        let title = meta.get("title").cloned().unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        Ok(json!({
            "id": id,
            "taskId": meta.get("taskId").cloned().unwrap_or_default(),
            "title": title,
            "order": order,
            "body": body,
            "updatedAt": meta.get("updatedAt").and_then(|s| s.parse::<u64>().ok()).unwrap_or_else(now_ms),
            "_file": format!("章节/{name}"),
            "_fileMtime": mtime_ms(path).unwrap_or(0),
        }))
    }

    /// 从 章节/ 目录加载章列表（与 load_book 同逻辑，供 save 合并用）
    fn load_chapters_from_disk(chap_dir: &Path, stored: &[Value]) -> Result<Vec<Value>> {
        let mut loaded = vec![];
        if !chap_dir.is_dir() {
            return Ok(loaded);
        }
        let (by_id, by_file) = Self::index_stored_chapters(stored);
        let mut files: Vec<_> = fs::read_dir(chap_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        files.sort_by_key(|e| e.file_name());
        for f in files {
            let parsed = Self::load_chapter_path(&f.path(), (loaded.len() + 1) as u64)?;
            let name = f.file_name().to_string_lossy().to_string();
            let md_id = parsed
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty());
            let stored_ch = if let Some(id) = md_id {
                by_id.get(id)
            } else {
                by_file.get(&name)
            };
            loaded.push(Self::merge_loaded_chapter(parsed, stored_ch));
        }
        loaded.sort_by(|a, b| {
            a.get("order")
                .and_then(|v| v.as_u64())
                .cmp(&b.get("order").and_then(|v| v.as_u64()))
        });
        Ok(loaded)
    }

    pub fn book_meta(&self, slug: &str) -> Result<Value> {
        let bdir = self.book_dir(slug)?;
        if !bdir.is_dir() {
            bail!("not found");
        }
        let bj = bdir.join("book.json");
        let proj = read_json(&bj).unwrap_or(json!({}));
        Ok(json!({
            "slug": slug,
            "title": proj.get("title").and_then(|v| v.as_str()).unwrap_or(slug),
            "path": bdir.to_string_lossy(),
            "mtime": mtime_ms(&bj).unwrap_or(0),
            "updatedAt": proj.get("updatedAt"),
            "chapters": proj.get("chapters").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            "stage": proj.get("stage"),
            "id": proj.get("id"),
        }))
    }

    pub fn maybe_snapshot(&self, slug: &str, reason: &str) -> Result<Option<String>> {
        let book_dir = self.book_dir(slug)?;
        let src = book_dir.join("book.json");
        if !src.exists() {
            return Ok(None);
        }
        if reason == "auto" {
            let history = book_dir.join(".history");
            let latest_auto = history
                .is_dir()
                .then(|| fs::read_dir(&history).ok())
                .flatten()
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| read_json(&entry.path().join("meta.json")).ok())
                .filter(|meta| meta.get("reason").and_then(|value| value.as_str()) == Some("auto"))
                .filter_map(|meta| meta.get("createdAt").and_then(|value| value.as_u64()))
                .max()
                .unwrap_or(0);
            if latest_auto > 0
                && now_ms().saturating_sub(latest_auto) < AUTO_SNAPSHOT_MIN_INTERVAL_MS
            {
                return Ok(None);
            }
        }
        // 调用方多为 save_book（已持 IO_LOCK），走 inner 避免死锁
        Ok(Some(self.create_snapshot_inner(slug, reason)?))
    }

    /// 公开入口：持 IO_LOCK。HTTP / 外部调用走此路径。
    pub fn create_snapshot(&self, slug: &str, reason: &str) -> Result<String> {
        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.create_snapshot_inner(slug, reason)
    }

    /// 已持 IO_LOCK 时使用（save_book / maybe_snapshot / restore）。
    fn create_snapshot_inner(&self, slug: &str, reason: &str) -> Result<String> {
        let bdir = self.book_dir(slug)?;
        let src = bdir.join("book.json");
        if !src.exists() {
            bail!("no book.json");
        }
        let hid = format!(
            "{}-{}",
            Local::now().format("%Y%m%d-%H%M%S"),
            &Uuid::new_v4().to_string()[..6]
        );
        let dest = bdir.join(".history").join(&hid);
        fs::create_dir_all(&dest)?;
        fs::copy(&src, dest.join("book.json"))?;
        let proj = read_json(&src).unwrap_or(json!({}));
        write_json(
            &dest.join("meta.json"),
            &json!({
                "id": hid,
                "reason": reason,
                "createdAt": now_ms(),
                "title": proj.get("title"),
                "chapters": proj.get("chapters").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            }),
        )?;
        let mut entries: Vec<_> = fs::read_dir(bdir.join(".history"))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        entries.reverse();
        for old in entries.into_iter().skip(HISTORY_KEEP) {
            let _ = fs::remove_dir_all(old.path());
        }
        Ok(hid)
    }

    pub fn list_snapshots(&self, slug: &str) -> Result<Value> {
        let h = self.book_dir(slug)?.join(".history");
        let mut out = vec![];
        if h.is_dir() {
            let mut entries: Vec<_> = fs::read_dir(&h)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect();
            entries.sort_by_key(|e| e.file_name());
            entries.reverse();
            for e in entries {
                let meta = read_json(&e.path().join("meta.json")).unwrap_or(json!({
                    "id": e.file_name().to_string_lossy()
                }));
                out.push(meta);
            }
        }
        Ok(json!({"slug": slug, "snapshots": out}))
    }

    pub fn build_file_tree(&self, slug: &str) -> Result<Value> {
        let bdir = self.book_dir(slug)?;
        if !bdir.is_dir() {
            bail!("not found");
        }
        fn walk(
            dir: &Path,
            prefix: &str,
            base: &Path,
            depth: usize,
            visited: &mut HashSet<std::path::PathBuf>,
        ) -> Result<Vec<Value>> {
            const MAX_DEPTH: usize = 8;
            if depth >= MAX_DEPTH {
                return Ok(vec![]);
            }
            let mut nodes = vec![];
            let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
            entries.sort_by_key(|e| {
                (
                    e.path().is_file(),
                    e.file_name().to_string_lossy().to_lowercase(),
                )
            });
            for e in entries {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "__pycache__" {
                    continue;
                }
                let rel = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                };
                let p = e.path();
                let file_type = e.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let canonical = p.canonicalize().unwrap_or_else(|_| p.clone());
                if !canonical.starts_with(base) {
                    continue;
                }
                if file_type.is_dir() {
                    if !visited.insert(canonical.clone()) {
                        continue;
                    }
                    let children = walk(&p, &rel, base, depth + 1, visited)?;
                    nodes.push(json!({
                        "type": "dir",
                        "name": name,
                        "path": rel,
                        "children": children,
                    }));
                } else if file_type.is_file() {
                    let ext = p
                        .extension()
                        .map(|x| format!(".{}", x.to_string_lossy()))
                        .unwrap_or_default()
                        .to_lowercase();
                    let st = p.metadata().ok();
                    nodes.push(json!({
                        "type": "file",
                        "name": name,
                        "path": rel,
                        "ext": ext,
                        "editable": super::EDITABLE.iter().any(|e| *e == ext),
                        "mtime": st.as_ref().and_then(|m| m.modified().ok()).and_then(system_time_ms).unwrap_or(0),
                        "size": st.map(|m| m.len()).unwrap_or(0),
                    }));
                }
            }
            Ok(nodes)
        }
        let base = bdir.canonicalize().unwrap_or_else(|_| bdir.clone());
        let mut visited = HashSet::new();
        visited.insert(base.clone());
        Ok(json!({
            "slug": slug,
            "root": bdir.to_string_lossy(),
            "tree": walk(&bdir, "", &base, 0, &mut visited)?,
            "scannedAt": now_ms(),
        }))
    }

    /// 快速扫描书根下文件 mtime 映射（用于前端轮询 watch）。
    pub fn tree_mtimes(&self, slug: &str) -> Result<Value> {
        const POLL_HINT_MS: u64 = 800;
        const MAX_DEPTH: usize = 8;

        let bdir = self.book_dir(slug)?;
        let mut files = serde_json::Map::new();
        if bdir.is_dir() {
            let walker = WalkDir::new(&bdir)
                .max_depth(MAX_DEPTH)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| {
                    if e.depth() == 0 {
                        return true;
                    }
                    let name = e.file_name().to_string_lossy();
                    !(name.starts_with('.') || name == "__pycache__")
                });
            for e in walker.filter_map(|e| e.ok()) {
                if !e.file_type().is_file() {
                    continue;
                }
                let Ok(rel_path) = e.path().strip_prefix(&bdir) else {
                    continue;
                };
                let rel = rel_path.to_string_lossy().replace('\\', "/");
                if let Ok(m) = e.metadata() {
                    if let Ok(t) = m.modified() {
                        if let Some(ms) = system_time_ms(t) {
                            files.insert(rel, json!(ms));
                        }
                    }
                }
            }
        }
        Ok(json!({
            "slug": slug,
            "files": files,
            "scannedAt": now_ms(),
            "pollHintMs": POLL_HINT_MS,
            "epoch": content_epoch(),
        }))
    }

    pub fn restore_snapshot(&self, slug: &str, id: &str) -> Result<Value> {
        if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
            bail!("invalid snapshot id");
        }
        let bdir = self.book_dir(slug)?;
        let snap = bdir.join(".history").join(id).join("book.json");
        if !snap.is_file() {
            bail!("snapshot not found: {}", id);
        }
        // 读盘在锁外；写盘：先 before-restore 快照（持锁），drop 后再 save_book（自持锁）
        // 避免 create_snapshot 与 save_book 嵌套死锁
        let mut proj = read_json(&snap)?;
        proj["_forceChapterOverwrite"] = json!(true);
        {
            let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let _ = self.create_snapshot_inner(slug, "before-restore");
        }
        let saved = self.save_book(slug, proj, false)?;
        Ok(json!({
            "ok": true,
            "slug": slug,
            "restoredFrom": id,
            "updatedAt": saved.get("updatedAt"),
            "book": saved,
        }))
    }

    /// 将单书目录复制进当前 vault 的 books/<slug>/
    pub fn import_book_dir(&self, path: &Path) -> Result<Value> {
        self.ensure()?;
        if !matches!(classify_path(path), PathKind::BookDir) {
            bail!(
                "path is not a book directory (need book.json or 章节/): {}",
                path.display()
            );
        }
        let folder_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("imported")
            .to_string();
        let bj = path.join("book.json");
        let src_proj = read_json(&bj).ok();
        let title = src_proj
            .as_ref()
            .and_then(|j| j.get("title").and_then(|v| v.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or(&folder_name)
            .to_string();

        let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = slugify(&folder_name);
        let slug = {
            if !self.books.join(&base).exists() {
                base
            } else {
                unique_slug(&self.books, &folder_name)?
            }
        };
        let dest = self.books.join(&slug);
        if dest.exists() {
            bail!("destination already exists: {}", slug);
        }
        copy_dir_all(path, &dest)?;
        let dest_bj = dest.join("book.json");
        let mut proj = if dest_bj.is_file() {
            read_json(&dest_bj).unwrap_or_else(|_| default_book(&title, ""))
        } else {
            default_book(&title, "")
        };
        proj["slug"] = json!(slug);
        if proj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            proj["title"] = json!(title.clone());
        }
        if proj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            proj["id"] = json!(Uuid::new_v4().to_string());
        }
        proj["updatedAt"] = json!(now_ms());
        for sub in ["章节", "策划", "关系", "记忆", "锁定"] {
            let _ = fs::create_dir_all(dest.join(sub));
        }
        write_json(&dest_bj, &proj)?;
        bump_content_epoch();
        let library = self.rescan_library()?;
        let final_title = proj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&title)
            .to_string();
        Ok(json!({
            "ok": true,
            "slug": slug,
            "title": final_title,
            "path": dest.to_string_lossy(),
            "vaultPath": self.root.to_string_lossy(),
            "booksPath": self.books.to_string_lossy(),
            "library": library,
        }))
    }

    pub fn rename_book_title(&self, slug: &str, title: &str) -> Result<Value> {
        let mut book = self.load_book(slug)?;
        book["title"] = json!(title);
        // save_book 自持 IO_LOCK
        self.save_book(slug, book, true)
    }

    /// 重命名书：可选同时改文件夹 slug。
    /// 仅改标题：委托 save_book 持锁；改文件夹：本入口持锁写盘，不嵌套 save。
    pub fn rename_book(&self, slug: &str, title: &str, rename_folder: bool) -> Result<Value> {
        let title = title.trim();
        if title.is_empty() {
            bail!("title required");
        }
        if !rename_folder {
            // 不在此持锁：rename_book_title → save_book 已持锁
            let book = self.rename_book_title(slug, title)?;
            return Ok(json!({
                "ok": true,
                "slug": slug,
                "title": title,
                "renamedFolder": false,
                "book": book,
            }));
        }

        let old_dir = self.book_dir(slug)?;
        if !old_dir.is_dir() {
            bail!("book not found: {}", slug);
        }
        let new_slug = slugify(title);
        if new_slug.is_empty() {
            bail!("invalid title for folder name");
        }
        if new_slug != slug {
            let _g = IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let new_dir = self.books.join(&new_slug);
            if new_dir.exists() {
                bail!("CONFLICT: folder already exists: {}", new_slug);
            }
            fs::rename(&old_dir, &new_dir)?;
            let bj = new_dir.join("book.json");
            let mut proj = if bj.is_file() {
                read_json(&bj).unwrap_or_else(|_| default_book(title, ""))
            } else {
                default_book(title, "")
            };
            proj["slug"] = json!(new_slug);
            proj["title"] = json!(title);
            proj["updatedAt"] = json!(now_ms());
            write_json(&bj, &proj)?;
            bump_content_epoch();
            let _ = self.rescan_library()?;
            // drop 锁后再 load（只读）；proj 作 fallback
            drop(_g);
            let book = self.load_book(&new_slug).unwrap_or(proj);
            return Ok(json!({
                "ok": true,
                "slug": new_slug,
                "oldSlug": slug,
                "title": title,
                "renamedFolder": true,
                "book": book,
            }));
        }
        // slug 不变：只改标题，走 save_book 持锁
        let book = self.rename_book_title(slug, title)?;
        Ok(json!({
            "ok": true,
            "slug": slug,
            "title": title,
            "renamedFolder": false,
            "book": book,
        }))
    }
}

#[cfg(test)]
mod save_book_tests {
    use super::*;
    use crate::vault::Vault;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let p = std::env::temp_dir().join(format!("mogao-save-{}-{}", tag, ms));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn concurrent_same_title_creates_distinct_book_directories() {
        let root = tmp("concurrent-create");
        let vault = Arc::new(Vault::open_at(root.clone()).unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let vault = Arc::clone(&vault);
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                vault.create_book("同名作品", "").unwrap()
            }));
        }
        let books: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let first = books[0]["slug"].as_str().unwrap();
        let second = books[1]["slug"].as_str().unwrap();
        assert_ne!(first, second);
        assert!(vault.books.join(first).join("book.json").is_file());
        assert!(vault.books.join(second).join("book.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_chapters_without_clear_keeps_md() {
        let d = tmp("empty-ch");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("空章测试", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        // 写 1 章
        let mut proj = v.load_book(&slug).unwrap();
        proj["chapters"] = json!([{
            "id": "ch1",
            "title": "第一章",
            "order": 1,
            "body": "正文保留",
        }]);
        v.save_book(&slug, proj, false).unwrap();

        let chap_dir = v.book_dir(&slug).unwrap().join("章节");
        let md_before: Vec<_> = fs::read_dir(&chap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        assert_eq!(md_before.len(), 1, "should have 1 chapter md");

        // 再 save chapters:[] 且无 clearChapters → md 仍在
        let mut proj2 = v.load_book(&slug).unwrap();
        proj2["chapters"] = json!([]);
        proj2["title"] = json!("空章测试-改名");
        v.save_book(&slug, proj2, false).unwrap();

        let md_after: Vec<_> = fs::read_dir(&chap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        assert_eq!(
            md_after.len(),
            1,
            "empty chapters without clearChapters must keep md"
        );
        let content = fs::read_to_string(md_after[0].path()).unwrap();
        assert!(content.contains("正文保留"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn slim_empty_body_does_not_wipe_disk_md() {
        let d = tmp("slim-empty-body");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("空串保护", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut proj = v.load_book(&slug).unwrap();
        proj["chapters"] = json!([{
            "id": "ch1",
            "title": "第一章",
            "order": 1,
            "body": "磁盘正文必须留下",
        }]);
        v.save_book(&slug, proj, false).unwrap();

        let mut slim = v.load_book(&slug).unwrap();
        slim["chapters"][0]["body"] = json!("");
        let saved = v.save_book(&slug, slim, false).unwrap();

        let chap_dir = v.book_dir(&slug).unwrap().join("章节");
        let md_after: Vec<_> = fs::read_dir(&chap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        assert_eq!(md_after.len(), 1);
        let content = fs::read_to_string(md_after[0].path()).unwrap();
        assert!(
            content.contains("磁盘正文必须留下"),
            "empty incoming body must not wipe disk md"
        );
        let warnings = saved
            .get("_saveWarnings")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(
            warnings
                .iter()
                .any(|w| w.get("kind").and_then(|k| k.as_str()) == Some("preservedExternal")),
            "empty incoming body should report preservedExternal"
        );
        assert!(saved["chapters"][0]["body"]
            .as_str()
            .unwrap_or("")
            .contains("磁盘正文必须留下"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn clear_chapters_true_deletes_md() {
        let d = tmp("clear-ch");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("清章测试", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut proj = v.load_book(&slug).unwrap();
        proj["chapters"] = json!([{
            "id": "ch1",
            "title": "将被删",
            "order": 1,
            "body": "gone",
        }]);
        v.save_book(&slug, proj, false).unwrap();

        let mut proj2 = v.load_book(&slug).unwrap();
        proj2["chapters"] = json!([]);
        proj2["clearChapters"] = json!(true);
        v.save_book(&slug, proj2, false).unwrap();

        let chap_dir = v.book_dir(&slug).unwrap().join("章节");
        let md_after: Vec<_> = fs::read_dir(&chap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        assert!(md_after.is_empty(), "clearChapters must wipe md");

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_chapters_key_keeps_md() {
        let d = tmp("no-ch-key");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("无键测试", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut proj = v.load_book(&slug).unwrap();
        proj["chapters"] = json!([{
            "id": "ch1",
            "title": "保留章",
            "order": 1,
            "body": "keep me",
        }]);
        v.save_book(&slug, proj, false).unwrap();

        // 构造无 chapters 键的 project
        let mut proj2 = v.load_book(&slug).unwrap();
        proj2.as_object_mut().unwrap().remove("chapters");
        proj2["pitch"] = json!("只改卖点");
        v.save_book(&slug, proj2, false).unwrap();

        let chap_dir = v.book_dir(&slug).unwrap().join("章节");
        let md_after: Vec<_> = fs::read_dir(&chap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        assert_eq!(md_after.len(), 1);
        let content = fs::read_to_string(md_after[0].path()).unwrap();
        assert!(content.contains("keep me"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn preserves_chapter_added_outside_the_project_payload() {
        let d = tmp("external-added");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("external-added", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "known",
            "title": "Known",
            "order": 1,
            "body": "known body",
        }]);
        v.save_book(&slug, project, false).unwrap();

        let chapter_dir = v.book_dir(&slug).unwrap().join("章节");
        let external_path = chapter_dir.join("0002-external.md");
        fs::write(
            &external_path,
            "---\nid: external\ntitle: External\norder: 2\n---\n\nexternal body\n",
        )
        .unwrap();

        let mut stale_project = v.load_book(&slug).unwrap();
        stale_project["chapters"] = json!([stale_project["chapters"][0].clone()]);
        let saved = v.save_book(&slug, stale_project, false).unwrap();

        assert!(external_path.is_file());
        assert!(fs::read_to_string(&external_path)
            .unwrap()
            .contains("external body"));
        assert!(saved["chapters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chapter| chapter["id"] == "external"));
        assert!(saved["_saveWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning["kind"] == "preservedExternal"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn preserves_newer_external_edit_instead_of_overwriting_it() {
        let d = tmp("external-edited");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("external-edited", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "chapter-1",
            "title": "Chapter One",
            "order": 1,
            "body": "editor body",
        }]);
        v.save_book(&slug, project, false).unwrap();

        let mut stale_project = v.load_book(&slug).unwrap();
        let file = stale_project["chapters"][0]["_file"]
            .as_str()
            .unwrap()
            .trim_start_matches("章节/")
            .to_string();
        stale_project["chapters"][0]["_fileMtime"] = json!(1);
        stale_project["chapters"][0]["updatedAt"] = json!(1);
        let chapter_path = v.book_dir(&slug).unwrap().join("章节").join(file);
        fs::write(
            &chapter_path,
            "---\nid: chapter-1\ntitle: Chapter One\norder: 1\n---\n\nexternal body\n",
        )
        .unwrap();

        let saved = v.save_book(&slug, stale_project, false).unwrap();

        assert!(fs::read_to_string(&chapter_path)
            .unwrap()
            .contains("external body"));
        assert_eq!(saved["chapters"][0]["body"], "external body\n");
        assert!(saved["_saveWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning["kind"] == "externalConflict"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn save_returns_fresh_chapter_baselines_for_the_next_save() {
        let d = tmp("chapter-baselines");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("chapter-baselines", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "chapter-1",
            "title": "Chapter One",
            "order": 1,
            "body": "first pass",
        }]);
        let saved = v.save_book(&slug, project, false).unwrap();

        let baselines = chapter_baselines(&saved);
        let rows = baselines.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "chapter-1");
        assert_eq!(rows[0]["file"], saved["chapters"][0]["_file"]);
        assert_eq!(rows[0]["mtime"], saved["chapters"][0]["_fileMtime"]);
        assert!(rows[0]["mtime"].as_u64().unwrap() > 0);

        // 没落盘的章不该出现在基线里，客户端拿它当比对点会误判
        let unsaved = json!({ "chapters": [{ "id": "ghost", "title": "Ghost", "order": 9 }] });
        assert!(chapter_baselines(&unsaved).as_array().unwrap().is_empty());

        let chapter_path = v.book_dir(&slug).unwrap().join("章节").join(
            saved["chapters"][0]["_file"]
                .as_str()
                .unwrap()
                .trim_start_matches("章节/"),
        );
        let future = SystemTime::now() + Duration::from_secs(5);
        let file = fs::File::options().write(true).open(&chapter_path).unwrap();
        file.set_modified(future).unwrap();
        drop(file);

        let mut stale = saved.clone();
        stale["chapters"][0]["body"] = json!("second pass stale");
        let stale_saved = v.save_book(&slug, stale, false).unwrap();
        assert!(
            stale_saved["_saveWarnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning["kind"] == "externalConflict"),
            "old baseline must still conflict"
        );
        assert!(fs::read_to_string(&chapter_path)
            .unwrap()
            .contains("first pass"));

        let mut fresh = saved.clone();
        fresh["chapters"][0]["body"] = json!("second pass");
        fresh["chapters"][0]["_fileMtime"] = json!(mtime_ms(&chapter_path).unwrap());
        let fresh_saved = v.save_book(&slug, fresh, false).unwrap();
        let fresh_warnings = fresh_saved
            .get("_saveWarnings")
            .cloned()
            .unwrap_or(json!([]));
        assert!(
            fresh_warnings
                .as_array()
                .map(|a| a.is_empty())
                .unwrap_or(true),
            "adopted baseline must allow the next save, got {fresh_warnings}"
        );
        assert!(fs::read_to_string(&chapter_path)
            .unwrap()
            .contains("second pass"));
        assert!(
            chapter_baselines(&fresh_saved)[0]["mtime"]
                .as_u64()
                .unwrap()
                > 0
        );

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn chapter_title_rename_removes_the_old_file_after_writing_the_new_one() {
        let d = tmp("rename-chapter");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("rename-chapter", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "chapter-1",
            "title": "Old Title",
            "order": 1,
            "body": "body",
        }]);
        v.save_book(&slug, project, false).unwrap();

        let mut renamed = v.load_book(&slug).unwrap();
        let old_file = renamed["chapters"][0]["_file"]
            .as_str()
            .unwrap()
            .trim_start_matches("章节/")
            .to_string();
        renamed["chapters"][0]["title"] = json!("New Title");
        let saved = v.save_book(&slug, renamed, false).unwrap();
        let new_file = saved["chapters"][0]["_file"]
            .as_str()
            .unwrap()
            .trim_start_matches("章节/");
        let chapter_dir = v.book_dir(&slug).unwrap().join("章节");

        assert_ne!(old_file, new_file);
        assert!(!chapter_dir.join(old_file).exists());
        assert!(chapter_dir.join(new_file).is_file());

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rag_documents_live_in_sidecar_and_are_loaded_back() {
        let d = tmp("rag-sidecar");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("rag-sidecar", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["ragIndex"] = json!({
            "version": 3,
            "builtAt": 123,
            "_sig": "v3:1:abc",
            "docs": [{"id": "d1", "text": "searchable", "meta": {"type": "canon"}}],
            "inverted": {"searchable": [0]},
            "docLen": [1],
            "N": 1,
        });
        project["_lastRag"] = json!({"hits": ["runtime-only"]});
        v.save_book(&slug, project, false).unwrap();

        let book_dir = v.book_dir(&slug).unwrap();
        let stored = read_json(&book_dir.join("book.json")).unwrap();
        assert!(stored.get("ragIndex").is_none());
        assert!(stored.get("_lastRag").is_none());

        let sidecar = read_json(&book_dir.join("记忆").join("rag-index.json")).unwrap();
        assert_eq!(sidecar["_sig"], "v3:1:abc");
        assert_eq!(sidecar["docs"][0]["text"], "searchable");
        assert!(sidecar.get("inverted").is_none());

        let loaded = v.load_book(&slug).unwrap();
        assert_eq!(loaded["ragIndex"]["_sig"], "v3:1:abc");
        assert_eq!(loaded["ragIndex"]["docs"][0]["id"], "d1");

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn continuity_memory_sidecars_roundtrip() {
        let d = tmp("continuity-sidecars");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("continuity-sidecars", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["plotLoops"] = json!([{"id":"loop1","summary":"账册","status":"open"}]);
        project["continuityIssues"] = json!([{"id":"issue1","summary":"人物位置","status":"open"}]);
        project["entityStates"] = json!({"苏清月":{"entity":"苏清月","location":"市一院"}});
        project["timelineEvents"] = json!([{"id":"event1","event":"进入医院","order":1}]);
        project["styleBible"] = json!({"pov":"第三人称限知"});
        v.save_book(&slug, project, false).unwrap();

        let book_dir = v.book_dir(&slug).unwrap();
        assert!(book_dir.join("记忆").join("plot-loops.json").is_file());
        assert!(book_dir.join("记忆").join("entity-states.json").is_file());
        let loaded = v.load_book(&slug).unwrap();
        assert_eq!(loaded["plotLoops"][0]["id"], "loop1");
        assert_eq!(loaded["entityStates"]["苏清月"]["location"], "市一院");
        assert_eq!(loaded["styleBible"]["pov"], "第三人称限知");

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn automatic_snapshots_are_throttled_but_manual_snapshots_are_not() {
        let d = tmp("snapshot-throttle");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("snapshot-throttle", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        assert!(v.maybe_snapshot(&slug, "auto").unwrap().is_some());
        assert!(v.maybe_snapshot(&slug, "auto").unwrap().is_none());
        assert!(!v.create_snapshot(&slug, "manual").unwrap().is_empty());
        let snapshots = v.list_snapshots(&slug).unwrap();
        assert_eq!(snapshots["snapshots"].as_array().unwrap().len(), 2);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn explicit_snapshot_restore_overrides_newer_chapter_files() {
        let d = tmp("snapshot-restore-chapter");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("snapshot-restore-chapter", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "chapter-1",
            "title": "Chapter One",
            "order": 1,
            "body": "VERSION_A",
        }]);
        v.save_book(&slug, project, false).unwrap();
        let snapshot_id = v.create_snapshot(&slug, "test").unwrap();

        let mut changed = v.load_book(&slug).unwrap();
        changed["chapters"][0]["body"] = json!("VERSION_B");
        changed["chapters"][0]["updatedAt"] = json!(now_ms());
        v.save_book(&slug, changed, false).unwrap();

        v.restore_snapshot(&slug, &snapshot_id).unwrap();
        let restored = v.load_book(&slug).unwrap();
        assert!(restored["chapters"][0]["body"]
            .as_str()
            .unwrap()
            .contains("VERSION_A"));

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn load_book_keeps_chapter_runtime_state() {
        let d = tmp("chapter-state");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("chapter-state", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "c-state",
            "title": "第一章",
            "order": 1,
            "body": "正文",
            "handoffStatus": "done",
            "beatPlan": {"scenes": [{"goal": "开场"}]},
            "beatPlanLocked": true,
        }]);
        v.save_book(&slug, project, false).unwrap();

        let loaded = v.load_book(&slug).unwrap();
        assert_eq!(loaded["chapters"][0]["id"], "c-state");
        assert_eq!(loaded["chapters"][0]["handoffStatus"], "done");
        assert_eq!(
            loaded["chapters"][0]["beatPlan"]["scenes"][0]["goal"],
            "开场"
        );
        assert_eq!(loaded["chapters"][0]["beatPlanLocked"], true);
        assert!(loaded["_mtime"].as_u64().unwrap() > 0);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn chapter_order_zero_is_kept() {
        let d = tmp("order-zero");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("order-zero", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([
            {"id": "prologue", "title": "序章", "order": 0, "body": "从前"},
            {"id": "c1", "title": "第一章", "order": 1, "body": "后来"}
        ]);
        let saved = v.save_book(&slug, project, false).unwrap();
        assert_eq!(saved["chapters"][0]["order"], 0);
        assert_eq!(saved["chapters"][0]["id"], "prologue");
        let names: Vec<String> = fs::read_dir(v.book_dir(&slug).unwrap().join("章节"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().any(|name| name.starts_with("000-")),
            "names={names:?}"
        );
        let loaded = v.load_book(&slug).unwrap();
        let prologue = loaded["chapters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ch| ch["id"] == "prologue")
            .unwrap();
        assert_eq!(prologue["order"], 0);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn idless_note_does_not_steal_chapter_id() {
        let d = tmp("idless-note");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("idless-note", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "c1",
            "title": "第一章",
            "order": 1,
            "body": "第一章正文必须留下",
            "handoffStatus": "done",
        }]);
        v.save_book(&slug, project, false).unwrap();
        v.write_file(
            &slug,
            "章节/001-随手记.md",
            "---\ntitle: 随手记\ncreated: 2026-08-13 19:00:00\n---\n\n# 随手记\n\n笔记正文\n",
        )
        .unwrap();

        let loaded = v.load_book(&slug).unwrap();
        let chapters = loaded["chapters"].as_array().unwrap();
        let ids: Vec<String> = chapters
            .iter()
            .map(|ch| ch["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            ids.len(),
            ids.iter().collect::<std::collections::HashSet<_>>().len()
        );
        assert!(ids.iter().any(|id| id == "c1"));
        let c1 = chapters.iter().find(|ch| ch["id"] == "c1").unwrap();
        assert!(c1["body"].as_str().unwrap().contains("第一章正文必须留下"));
        assert!(!c1["body"].as_str().unwrap().contains("笔记正文"));
        assert_eq!(c1["handoffStatus"], "done");
        let note = chapters.iter().find(|ch| ch["id"] != "c1").unwrap();
        let note_id = note["id"].as_str().unwrap().to_string();
        assert!(!note_id.is_empty());
        assert_ne!(note_id, "c1");

        let loaded2 = v.load_book(&slug).unwrap();
        let note2 = loaded2["chapters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ch| ch["id"] != "c1")
            .unwrap();
        assert_eq!(note2["id"], note_id);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn non_chapter_workspace_file_syncs_mirror_not_chapters() {
        let d = tmp("mirror-sync");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("mirror-sync", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["chapters"] = json!([{
            "id": "c1",
            "title": "第一章",
            "order": 1,
            "body": "正文",
        }]);
        v.save_book(&slug, project, false).unwrap();
        v.write_file(
            &slug,
            "关系/graph.json",
            r#"{"nodes":[{"id":"n-keep"}],"edges":[]}"#,
        )
        .unwrap();
        let loaded = v.load_book(&slug).unwrap();
        assert_eq!(loaded["graph"]["nodes"][0]["id"], "n-keep");
        let disk = read_json(&v.book_dir(&slug).unwrap().join("book.json")).unwrap();
        assert_eq!(disk["graph"]["nodes"][0]["id"], "n-keep");

        let before = loaded["chapters"].as_array().unwrap().len();
        v.write_file(&slug, "资料/采访.md", "这是采访笔记，不是章节。")
            .unwrap();
        let loaded2 = v.load_book(&slug).unwrap();
        assert_eq!(loaded2["chapters"].as_array().unwrap().len(), before);
        assert_eq!(loaded2["chapters"][0]["id"], "c1");
        assert!(!format!("{}", loaded2["chapters"]).contains("采访笔记"));

        let _ = fs::remove_dir_all(&d);
    }

    fn task_ids(project: &Value) -> Vec<String> {
        project
            .get("tasks")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.get("id").and_then(|v| v.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn save_book_does_not_resurrect_user_deleted_progressed_task() {
        let d = tmp("delete-done-task");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("删任务", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["tasks"] = json!([
            {"id": "t-done", "order": 1, "status": "done", "chapter_title": "已完成"},
            {"id": "t-keep", "order": 2, "status": "pending", "chapter_title": "留下"}
        ]);
        v.save_book(&slug, project, false).unwrap();

        let mut after_delete = v.load_book(&slug).unwrap();
        after_delete["tasks"] = json!([
            {"id": "t-keep", "order": 2, "status": "pending", "chapter_title": "留下"}
        ]);
        v.save_book(&slug, after_delete, false).unwrap();

        let reloaded = v.load_book(&slug).unwrap();
        let ids = task_ids(&reloaded);
        assert_eq!(ids, vec!["t-keep".to_string()], "ids={ids:?}");
        let disk_tasks =
            read_json(&v.book_dir(&slug).unwrap().join("策划").join("tasks.json")).unwrap();
        let disk_ids: Vec<_> = disk_tasks
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("id").and_then(|v| v.as_str()))
            .collect();
        assert_eq!(disk_ids, vec!["t-keep"]);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn save_book_omitted_tasks_keeps_disk_board() {
        let d = tmp("omit-tasks");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("省略任务", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["tasks"] = json!([
            {"id": "t-done", "order": 1, "status": "done", "chapter_title": "已完成"}
        ]);
        v.save_book(&slug, project, false).unwrap();

        let mut slim = v.load_book(&slug).unwrap();
        slim.as_object_mut().unwrap().remove("tasks");
        v.save_book(&slug, slim, false).unwrap();

        let reloaded = v.load_book(&slug).unwrap();
        assert_eq!(task_ids(&reloaded), vec!["t-done".to_string()]);

        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn workspace_tasks_overlay_keeps_progressed_not_in_draft() {
        let d = tmp("workspace-tasks-merge");
        let v = Vault::open_at(d.clone()).unwrap();
        let book = v.create_book("资料区任务", "").unwrap();
        let slug = book["slug"].as_str().unwrap().to_string();

        let mut project = v.load_book(&slug).unwrap();
        project["tasks"] = json!([
            {"id": "t1", "order": 1, "status": "done", "chapter_title": "A"},
            {"id": "t2", "order": 2, "status": "written", "chapter_title": "B"}
        ]);
        v.save_book(&slug, project, false).unwrap();

        v.write_file(
            &slug,
            "策划/tasks.json",
            r#"[{"id":"t3","order":3,"status":"pending","chapter_title":"C"}]"#,
        )
        .unwrap();

        let loaded = v.load_book(&slug).unwrap();
        let ids = task_ids(&loaded);
        assert!(ids.contains(&"t1".to_string()), "ids={ids:?}");
        assert!(ids.contains(&"t2".to_string()), "ids={ids:?}");
        assert!(ids.contains(&"t3".to_string()), "ids={ids:?}");
        assert_eq!(ids.len(), 3);

        let _ = fs::remove_dir_all(&d);
    }
}
