//! tasks.json 安全合并：保留本地进度状态
use serde_json::{json, Value};

const PROGRESSED: &[&str] = &["done", "written", "digested", "writing"];

fn status_of(t: &Value) -> &str {
    t.get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("pending")
}

fn is_progressed(t: &Value, chapters: Option<&[Value]>) -> bool {
    let st = status_of(t);
    if PROGRESSED.iter().any(|s| *s == st) {
        return true;
    }
    // 有关联章节正文也视为有进度
    let tid = t.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if tid.is_empty() {
        return false;
    }
    if let Some(chs) = chapters {
        for c in chs {
            if c.get("taskId").and_then(|v| v.as_str()) == Some(tid) {
                let body = c.get("body").and_then(|v| v.as_str()).unwrap_or("");
                if !body.trim().is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

fn order_of(t: &Value) -> u64 {
    t.get("order")
        .and_then(|v| v.as_u64())
        .or_else(|| t.get("order").and_then(|v| v.as_i64()).map(|i| i as u64))
        .unwrap_or(0)
}

fn task_id(t: &Value) -> Option<&str> {
    t.get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// 合并任务板（资料区草稿 / 客户端重跑策划）：
/// 本地 done/written/digested/writing 保留进度字段；
/// pending 可用 incoming 更新 chapter_title/goal；
/// 本地有进度但不在 incoming 的任务追加保留。
///
/// 整本 PUT 不走这里：客户端任务板是权威列表，用户删除不得被磁盘进度复活。
pub fn merge_tasks_preserving_progress(
    existing: &[Value],
    incoming: &[Value],
    chapters: Option<&[Value]>,
) -> Vec<Value> {
    let mut old_by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut old_by_order: std::collections::HashMap<u64, Value> = std::collections::HashMap::new();
    for t in existing {
        if let Some(id) = task_id(t) {
            old_by_id.insert(id.to_string(), t.clone());
        }
        old_by_order.insert(order_of(t), t.clone());
    }
    let mut used_old: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result = Vec::new();

    for neu in incoming {
        let old = task_id(neu)
            .and_then(|id| old_by_id.get(id))
            .or_else(|| old_by_order.get(&order_of(neu)));

        if let Some(old) = old {
            if let Some(oid) = task_id(old) {
                used_old.insert(oid.to_string());
            }
            if is_progressed(old, chapters) {
                // 有进度：保留 old 进度字段，仅补空文案
                let mut merged = neu.clone();
                // 先铺 neu，再覆盖 old 的进度关键字段
                if let (Some(mo), Some(oo)) = (merged.as_object_mut(), old.as_object()) {
                    for (k, v) in oo {
                        // 始终保留进度相关
                        if matches!(
                            k.as_str(),
                            "status"
                                | "lastError"
                                | "lastErrorStage"
                                | "id"
                                | "order"
                                | "chapterId"
                                | "writtenAt"
                                | "digestedAt"
                        ) {
                            mo.insert(k.clone(), v.clone());
                            continue;
                        }
                        // must_* / beats / hook：old 非空则保留
                        if matches!(
                            k.as_str(),
                            "must_include" | "must_not" | "beats" | "hook_end" | "conflict"
                        ) {
                            let keep = match v {
                                Value::Array(a) if !a.is_empty() => true,
                                Value::String(s) if !s.is_empty() => true,
                                Value::Null | Value::Array(_) | Value::String(_) => false,
                                _ => true,
                            };
                            if keep {
                                mo.insert(k.clone(), v.clone());
                            }
                            continue;
                        }
                        if k == "chapter_title" || k == "goal" {
                            let old_s = v.as_str().unwrap_or("");
                            if !old_s.is_empty() {
                                mo.insert(k.clone(), v.clone());
                            }
                            continue;
                        }
                        // 其它字段：old 有则覆盖
                        if !matches!(v, Value::Null) {
                            mo.insert(k.clone(), v.clone());
                        }
                    }
                    // 强制 id/status/order 来自 old
                    if let Some(id) = oo.get("id") {
                        mo.insert("id".into(), id.clone());
                    }
                    if let Some(st) = oo.get("status") {
                        mo.insert("status".into(), st.clone());
                    }
                    let ord = oo
                        .get("order")
                        .cloned()
                        .unwrap_or_else(|| neu.get("order").cloned().unwrap_or(json!(0)));
                    mo.insert("order".into(), ord);
                }
                result.push(merged);
            } else {
                // pending：允许 incoming 更新 title/goal 等，状态重置 pending
                let mut m = neu.clone();
                if let Some(mo) = m.as_object_mut() {
                    mo.insert("status".into(), json!("pending"));
                    // 保留 old id 若 neu 无 id
                    if task_id(neu).is_none() {
                        if let Some(id) = old.get("id") {
                            mo.insert("id".into(), id.clone());
                        }
                    }
                }
                result.push(m);
            }
        } else {
            let mut m = neu.clone();
            if let Some(mo) = m.as_object_mut() {
                if !mo.contains_key("status") {
                    mo.insert("status".into(), json!("pending"));
                }
            }
            result.push(m);
        }
    }

    // 本地有进度但不在新规划里：追加保留
    for old in existing {
        if let Some(oid) = task_id(old) {
            if used_old.contains(oid) {
                continue;
            }
        } else {
            continue;
        }
        if is_progressed(old, chapters) {
            result.push(old.clone());
        }
    }

    result.sort_by(|a, b| order_of(a).cmp(&order_of(b)));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_done_status() {
        let existing = vec![json!({
            "id": "t001", "order": 1, "status": "done",
            "chapter_title": "旧章一", "goal": "已完成目标"
        })];
        let incoming = vec![json!({
            "id": "t001", "order": 1, "status": "pending",
            "chapter_title": "新章一", "goal": "新目标"
        })];
        let merged = merge_tasks_preserving_progress(&existing, &incoming, None);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["status"], "done");
        assert_eq!(merged[0]["chapter_title"], "旧章一");
        assert_eq!(merged[0]["goal"], "已完成目标");
    }

    #[test]
    fn pending_allows_title_goal_update() {
        let existing = vec![json!({
            "id": "t002", "order": 2, "status": "pending",
            "chapter_title": "旧", "goal": "旧目标"
        })];
        let incoming = vec![json!({
            "id": "t002", "order": 2, "status": "pending",
            "chapter_title": "新标题", "goal": "新目标"
        })];
        let merged = merge_tasks_preserving_progress(&existing, &incoming, None);
        assert_eq!(merged[0]["status"], "pending");
        assert_eq!(merged[0]["chapter_title"], "新标题");
        assert_eq!(merged[0]["goal"], "新目标");
    }

    #[test]
    fn overlay_appends_progressed_not_in_incoming() {
        // 仅约束资料区/重跑策划的 overlay merge。
        // 整本保存不得套这条：见 save_book_does_not_resurrect_user_deleted_progressed_task。
        let existing = vec![
            json!({"id": "t1", "order": 1, "status": "done", "chapter_title": "A"}),
            json!({"id": "t2", "order": 2, "status": "written", "chapter_title": "B"}),
        ];
        let incoming = vec![json!({
            "id": "t3", "order": 3, "status": "pending", "chapter_title": "C"
        })];
        let merged = merge_tasks_preserving_progress(&existing, &incoming, None);
        let ids: Vec<_> = merged
            .iter()
            .filter_map(|t| t.get("id").and_then(|v| v.as_str()))
            .collect();
        assert!(ids.contains(&"t1"));
        assert!(ids.contains(&"t2"));
        assert!(ids.contains(&"t3"));
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn order_fallback_match() {
        let existing = vec![json!({
            "id": "old-id", "order": 5, "status": "digested",
            "chapter_title": "消化章", "goal": "g"
        })];
        // incoming 无相同 id，但 order 相同
        let incoming = vec![json!({
            "id": "new-id", "order": 5, "status": "pending",
            "chapter_title": "新", "goal": "ng"
        })];
        let merged = merge_tasks_preserving_progress(&existing, &incoming, None);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["status"], "digested");
        assert_eq!(merged[0]["id"], "old-id");
    }

    #[test]
    fn writing_is_progressed() {
        let existing = vec![json!({
            "id": "w1", "order": 1, "status": "writing", "chapter_title": "写中"
        })];
        let incoming = vec![json!({
            "id": "w1", "order": 1, "status": "pending", "chapter_title": "覆盖"
        })];
        let merged = merge_tasks_preserving_progress(&existing, &incoming, None);
        assert_eq!(merged[0]["status"], "writing");
        assert_eq!(merged[0]["chapter_title"], "写中");
    }
}
