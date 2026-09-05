/** DOM-free chapter review, digest and handoff application service. */
window.NOVEL_HANDOFF_SERVICE = (() => {
  function create({
    getPrompts,
    getContext,
    getApi,
    getChapterState,
    getProductionState,
    getCraft = () => null,
    getProductionEngine = () => null,
    getRag = () => null,
    getObservability = () => null,
    getApplyCraftSignals,
    textSignature,
    log,
  } = {}) {
    for (const [name, dependency] of Object.entries({
      getPrompts,
      getContext,
      getApi,
      getChapterState,
      getProductionState,
      getApplyCraftSignals,
      textSignature,
      log,
    })) {
      if (typeof dependency !== "function") throw new TypeError(`handoff service requires ${name}`);
    }
    const P = getPrompts;
    const C = getContext;
    const API = getApi;
    const ChapterState = getChapterState;
    const ProductionState = getProductionState;
    const Craft = getCraft;
    const ProductionEngine = getProductionEngine;
    const Rag = getRag;
    const Observability = getObservability;
    function applyCraftSignals(...args) {
      const apply = getApplyCraftSignals();
      if (typeof apply !== "function") throw new TypeError("handoff service requires applyCraftSignals");
      return apply(...args);
    }

    const STALE_HANDOFF_LIMIT = 3;

    function isQualityBlocked(chapter) {
      return (
        ProductionState()?.isQualityBlocked?.(chapter) ??
        ["needs_revision", "quality-blocked"].includes(
          String(chapter?.production?.status || chapter?.production?.stage || "")
        )
      );
    }

    async function digestChapter(project, cfg, chapter, task, { signal } = {}) {
      const pr = P().chapterDigest;
      const pack = C().packForDigest(project, chapter, task);
      const json = await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "handoff-digest",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          {
            role: "user",
            content: pr.user(chapter.title, chapter.body, task, {
              prevTitle: pack.prevTitle,
              prevTail: pack.prevTail,
              openLoops: pack.openLoops,
              activeWarnings: pack.activeWarnings,
              storyState: pack.storyState,
              storyline: pack.storyline,
              existingCanon: pack.existingCanon,
            }),
          },
        ],
      });
      // 规范化字段，避免模型漏字段导致后续装配空
      const normalized = {
        chapter: json.chapter || chapter.title || "",
        happened: Array.isArray(json.happened) ? json.happened : [],
        relation_changes: Array.isArray(json.relation_changes) ? json.relation_changes : [],
        new_info: Array.isArray(json.new_info) ? json.new_info : [],
        must_carry: Array.isArray(json.must_carry) ? json.must_carry : [],
        open_loops: Array.isArray(json.open_loops) ? json.open_loops : [],
        opened_loops: Array.isArray(json.opened_loops) ? json.opened_loops : [],
        advanced_loops: Array.isArray(json.advanced_loops) ? json.advanced_loops : [],
        resolved_loops: Array.isArray(json.resolved_loops) ? json.resolved_loops : [],
        deferred_loops: Array.isArray(json.deferred_loops) ? json.deferred_loops : [],
        abandoned_loops: Array.isArray(json.abandoned_loops) ? json.abandoned_loops : [],
        state: typeof json.state === "string" ? json.state : json.state ? JSON.stringify(json.state) : "",
        power_or_system: json.power_or_system || json.system_state || "",
        location: json.location || "",
        timeline: json.timeline || "",
        entity_states: Array.isArray(json.entity_states) ? json.entity_states : [],
        timeline_events: Array.isArray(json.timeline_events) ? json.timeline_events : [],
        ending_hook_status: json.ending_hook_status || json.hook_left || "",
        continuity_warnings: Array.isArray(json.continuity_warnings) ? json.continuity_warnings : [],
        handled_warnings: Array.isArray(json.handled_warnings) ? json.handled_warnings : [],
        ignored_warnings: Array.isArray(json.ignored_warnings) ? json.ignored_warnings : [],
        summary: json.summary || (Array.isArray(json.happened) ? json.happened.slice(0, 3).join("；") : ""),
        storyline_position: json.storyline_position || json.position || "",
        next_direction: json.next_direction || json.nextDirection || "",
        canon_facts: Array.isArray(json.canon_facts) ? json.canon_facts : [],
        appeared: json.appeared && typeof json.appeared === "object" ? json.appeared : {},
        taskId: task?.id || chapter.taskId || "",
        order: chapter.order || task?.order || 0,
      };
      if (Craft()?.validateDigest) {
        const gated = Craft().validateDigest(project, normalized, chapter.body, C());
        const dropped = gated.dropped?.length || 0;
        normalized.canon_facts = gated.canon_facts;
        normalized.abandoned_loops = gated.abandoned_loops;
        if (dropped) log(project, `交接闸丢掉 ${dropped} 条不可入库设定`);
      }
      project.memoryRoll = project.memoryRoll || [];
      // 同章重跑摘要：替换同 taskId/chapter 旧条，避免重复污染
      const sameIdx = project.memoryRoll.findIndex(
        (m) =>
          (normalized.taskId && m.taskId === normalized.taskId) ||
          (m.chapter && normalized.chapter && m.chapter === normalized.chapter)
      );
      if (sameIdx >= 0) project.memoryRoll[sameIdx] = normalized;
      else project.memoryRoll.push(normalized);
      // keep last 40（富摘要稍占空间，仍可控）
      if (project.memoryRoll.length > 40) project.memoryRoll = project.memoryRoll.slice(-40);
  
      // 滚动故事状态
      if (typeof C().mergeStoryState === "function") {
        C().mergeStoryState(project, normalized);
      }
      if (typeof C().mergeEntityStates === "function") {
        C().mergeEntityStates(project, normalized, {
          chapter: normalized.chapter,
          taskId: normalized.taskId,
          order: normalized.order,
        });
      }
  
      // 细节设定文档交接（粉丝数等锁定）
      let canonStat = { added: 0, conflicts: 0, total: 0 };
      if (typeof C().mergeCanonFacts === "function") {
        // 也把 must_carry / new_info 弱化为兜底事实（无 key 时用原文作 value）
        const extraFacts = [];
        for (const s of [...normalized.must_carry, ...normalized.new_info]) {
          if (!s || String(s).length < 4) continue;
          // 仅当像「A是B/A为B/A：B」时尝试
          const m = String(s).match(/^(.{2,16})(?:是|为|：|:|=)(.{1,24})$/);
          if (m) extraFacts.push({ key: m[1].trim(), value: m[2].trim(), category: "other", evidence: s });
        }
        let extras = [];
        if (Craft()?.validateDigest && extraFacts.length) {
          const gatedExtras = Craft().validateDigest(
            project,
            { canon_facts: extraFacts },
            chapter.body,
            C()
          );
          extras = gatedExtras.canon_facts || [];
          if (gatedExtras.dropped?.length) {
            log(project, `交接闸丢掉 ${gatedExtras.dropped.length} 条无证据兜底事实`);
          }
        }
        canonStat = C().mergeCanonFacts(
          project,
          [...normalized.canon_facts, ...extras],
          { chapter: normalized.chapter, taskId: normalized.taskId }
        );
        // 供 vault 写出的可读文档
        if (typeof C().formatCanonMarkdown === "function") {
          project.detailCanonMarkdown = C().formatCanonMarkdown(project);
        }
      }
  
      // 故事线位置 + 下一推进方向
      if (typeof C().updateStorylineTrack === "function") {
        C().updateStorylineTrack(project, task, normalized, chapter);
      }
  
      // 出场记录
      if (typeof C().mergeAppearanceLog === "function" && normalized.appeared) {
        C().mergeAppearanceLog(project, normalized.appeared, {
          chapter: normalized.chapter,
          taskId: normalized.taskId,
          order: normalized.order,
        });
      }
  
      ChapterState().markDigestComplete(chapter, task);
      log(
        project,
        `章后交接 ${chapter.title}｜摘要✓ 设定+${canonStat.added}/冲突${canonStat.conflicts}/共${canonStat.total}｜线:${String(
          normalized.storyline_position || normalized.summary
        ).slice(0, 28)}｜向:${String(normalized.next_direction).slice(0, 20)}`
      );
      return normalized;
    }
  
    async function extractGraphDelta(project, cfg, chapter, { signal } = {}) {
      const pr = P().chapterGraphDelta;
      try {
        const json = await API().chatJson({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          signal,
          diagnosticStage: "handoff-graph",
          messages: [
            { role: "system", content: P().commonGuard + "\n" + pr.system },
            { role: "user", content: pr.user(chapter.title, chapter.body) },
          ],
        });
        project.graph = C().mergeGraph(project.graph, json);
        log(project, `关系增量合并 nodes=${(json.nodes || []).length} edges=${(json.edges || []).length}`);
        return json;
      } catch (e) {
        log(project, `关系抽取失败（已跳过）: ${e.message}`);
        return null;
      }
    }
  
    function normalizeReviewIssue(raw) {
      if (!raw || typeof raw !== "object") return null;
      const summary = String(raw.summary || raw.message || "").trim();
      if (!summary) return null;
      const severity = ["blocker", "major", "minor", "info"].includes(raw.severity) ? raw.severity : "major";
      return {
        type: raw.type || "other",
        severity,
        summary: summary.slice(0, 120),
        entity: String(raw.entity || "").slice(0, 80),
        evidence: String(raw.evidence || "").slice(0, 240),
        expected: String(raw.expected || "").slice(0, 240),
        suggestion: String(raw.suggestion || "").slice(0, 240),
      };
    }
  
    function coverageItems(list) {
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") {
            return String(item.summary || item.goal || item.beat || item.id || "").trim();
          }
          return "";
        })
        .filter(Boolean);
    }
  
    function promoteMissingTaskCoverage(issues, taskCoverage, task) {
      const next = Array.isArray(issues) ? issues.slice() : [];
      for (const miss of coverageItems(taskCoverage?.missing)) {
        const already = next.some(
          (issue) =>
            issue.type === "task" &&
            (issue.summary.includes(miss) || issue.expected.includes(miss) || miss.includes(issue.expected))
        );
        if (already) continue;
        const synthesized = normalizeReviewIssue({
          type: "task",
          severity: "major",
          summary: `任务未覆盖：${miss}`,
          entity: String(task?.id || ""),
          expected: miss,
          suggestion: `补写任务要求：${miss}`,
        });
        if (synthesized) next.push(synthesized);
      }
      return next;
    }
  
    /**
     * 局部修复靠唯一命中的 search/replace，没有正文证据就没有落点。
     * 合成的「任务未覆盖」缺席于正文，只该记进风险账，不该送去补丁引擎空跑。
     */
    function repairableIssues(review) {
      return (review?.issues || []).filter(
        (x) => ["blocker", "major"].includes(x.severity) && String(x.evidence || "").trim()
      );
    }
  
    function isAbortError(e) {
      return e?.name === "AbortError";
    }
  
    function shouldAutoHandoff(cfg, hooks = {}) {
      if (hooks.handoff === false) return false;
      if (cfg.manualAutoHandoff === false && hooks.handoff !== true) return false;
      return true;
    }
  
    async function maybeHandoffAfterRevision(project, cfg, task, chapter, hooks = {}) {
      if (!shouldAutoHandoff(cfg, hooks)) return chapter;
      try {
        await handoffChapter(project, cfg, chapter, task, hooks);
      } catch (e) {
        // 作者点停止不是失败：原样抛出，让上层显示「已停止」而不是「交接失败」
        if (isAbortError(e)) throw e;
        log(project, `修订后交接失败（正文已保留）: ${e.message || e}`);
      }
      return chapter;
    }
  
    /** 只补自己标过 stale 的章：handoffStatus 缺失代表旧书从未交接，不在这里替作者烧额度 */
    function pendingHandoffChapters(project, task, limit = STALE_HANDOFF_LIMIT) {
      const order = Number(task?.order) || 0;
      return (project.chapters || [])
        .filter((ch) => String(ch?.body || "").trim())
        .filter((ch) => String(ch.handoffStatus || "") === "stale")
        // 质量闸门阻断的正文必须先回到生产引擎复检，不能由“补交接”绕过。
        .filter((ch) => !isQualityBlocked(ch))
        .filter((ch) => !task?.id || ch.taskId !== task.id)
        .filter((ch) => !order || (Number(ch.order) || 0) < order)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .slice(-limit);
    }
  
    function taskForChapter(project, chapter) {
      return (
        (project.tasks || []).find((item) => item.id && item.id === chapter.taskId) || {
          id: chapter.taskId || `manual_${chapter.id}`,
          order: chapter.order || 0,
          chapter_title: chapter.title || "",
          goal: "补交上章记忆",
        }
      );
    }
  
    /**
     * 写下一章之前，把前文所有 stale 的章补成 done，按故事顺序补。
     * 补交接不改正文：作者盯着第 N 章时，第 N-1 章不该被后台改写。
     */
    async function recoverStaleHandoffs(project, cfg, task, hooks = {}) {
      if (hooks.recoverPrevHandoff === false) return;
      const pending = pendingHandoffChapters(project, task);
      if (!pending.length) return;
      const readOnlyCfg = { ...cfg, continuityAutoRepair: false };
      for (const chapter of pending) {
        log(project, `前文《${chapter.title || chapter.id}》交接未完成，先补交接（不改正文）`);
        hooks.onStatus?.("prev-handoff");
        try {
          await handoffChapter(project, readOnlyCfg, chapter, taskForChapter(project, chapter), {
            ...hooks,
            onDelta: undefined,
          });
        } catch (e) {
          if (isAbortError(e)) throw e;
          log(project, `前文补交接失败: ${e.message || e}`);
          if (cfg.continuityReviewPolicy === "strict") {
            const err = new Error(`前文尚未交接成功：${e.message || e}`);
            err.code = "PREV_HANDOFF_FAILED";
            throw err;
          }
        }
      }
    }
  
    async function reviewChapterContinuity(project, cfg, chapter, task = {}, hooks = {}) {
      const sig = textSignature(chapter?.body || "");
      const pr = P().continuityReview;
      if (!pr) return { status: "skipped", bodySig: sig, issues: [] };
      const pack = C().packForContinuityReview(project, chapter, task, {
        prevChapterTailChars: cfg.prevChapterTailChars,
        budget: Math.min(18000, cfg.contextBudgetChars || 16000),
        tokenBudget: Math.min(13000, cfg.contextBudgetTokens || 12000),
      });
      const inputSig = textSignature(JSON.stringify([sig, pack.user, P().commonGuard, pr.system, pr.user(pack.user), cfg.model, cfg.temperature, cfg.seed]));
      const cached = chapter.continuityReview;
      if (!hooks.force && cached?.bodySig === sig && cached.inputSig === inputSig && ["pass", "warn", "fail"].includes(cached.status)) {
        return cached;
      }
      chapter.continuityReview = { status: "running", bodySig: sig, inputSig, issues: [] };
      hooks.onStatus?.("reviewing");
      try {
        const json = await API().chatJson({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          signal: hooks.signal,
          diagnosticStage: "continuity-review",
          messages: [
            { role: "system", content: P().commonGuard + "\n" + pr.system },
            { role: "user", content: pr.user(pack.user) },
          ],
        });
        if (!json || !Array.isArray(json.issues)) throw new Error("连续性审查响应缺少 issues 数组，无法确认审查完成");
        const taskCoverage = json.task_coverage || { completed: [], missing: [] };
        const issues = promoteMissingTaskCoverage(
          (Array.isArray(json.issues) ? json.issues : []).map(normalizeReviewIssue).filter(Boolean),
          taskCoverage,
          task
        );
        const hasBlocker = issues.some((x) => x.severity === "blocker");
        const hasMajor = issues.some((x) => x.severity === "major");
        const status = hasBlocker ? "fail" : hasMajor || issues.length ? "warn" : "pass";
        const review = {
          status,
          verdict: json.verdict || status,
          summary: String(json.summary || "").slice(0, 160),
          issues,
          taskCoverage,
          bodySig: sig,
          inputSig,
          at: Date.now(),
          model: cfg.model || "",
        };
        chapter.continuityReview = review;
        project.continuityReviews = Array.isArray(project.continuityReviews) ? project.continuityReviews : [];
        const old = project.continuityReviews.findIndex((x) => x.chapterId === chapter.id && x.bodySig === sig);
        const row = { ...review, chapterId: chapter.id, chapter: chapter.title, taskId: task?.id || chapter.taskId || "" };
        if (old >= 0) project.continuityReviews[old] = row;
        else project.continuityReviews.push(row);
        if (project.continuityReviews.length > 80) project.continuityReviews = project.continuityReviews.slice(-80);
        if (issues.length && typeof C().mergeContinuityIssues === "function") {
          C().mergeContinuityIssues(
            project,
            { continuity_warnings: issues },
            { chapter: chapter.title, taskId: task?.id || chapter.taskId || "", order: chapter.order || task?.order || 0 }
          );
        }
        log(project, `连续性审查 ${chapter.title} status=${status} issues=${issues.length}`);
        return review;
      } catch (e) {
        const review = { status: "error", bodySig: sig, issues: [], error: e.message || String(e), at: Date.now() };
        chapter.continuityReview = review;
        if (isAbortError(e)) throw e;
        log(project, `连续性审查失败: ${e.message || e}`);
        if (cfg.continuityReviewPolicy === "strict") {
          task.lastErrorStage = "review";
          throw e;
        }
        return review;
      }
    }
  
    async function repairChapterContinuity(project, cfg, chapter, task, review, hooks = {}) {
      const issues = repairableIssues(review);
      if (!issues.length) return { applied: 0, skipped: 0, patches: [] };
      const pr = P().continuityRepair;
      if (!pr) return { applied: 0, skipped: issues.length, patches: [] };
      const body = String(chapter.body || "");
      const reviewPack = C().packForContinuityReview(project, chapter, task, {
        prevChapterTailChars: cfg.prevChapterTailChars,
        bodyChars: 9000,
        budget: Math.min(18000, cfg.contextBudgetChars || 16000),
        tokenBudget: Math.min(13000, cfg.contextBudgetTokens || 12000),
      });
      const ctx = `${reviewPack.user}\n\n【必须修复的问题】\n${JSON.stringify(issues)}\n\n请只返回局部替换 patches。`;
      hooks.onStatus?.("repairing");
      const json = await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal: hooks.signal,
        diagnosticStage: "continuity-repair",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          { role: "user", content: pr.user(ctx) },
        ],
      });
      const patches = (Array.isArray(json.patches) ? json.patches : []).slice(0, 6);
      let next = body;
      let applied = 0;
      let skipped = 0;
      const accepted = [];
      for (const patch of patches) {
        const search = String(patch?.search || "");
        const replace = String(patch?.replace || "");
        if (!search || search.length > 1000 || replace.length > 1600) {
          skipped++;
          continue;
        }
        const occurrences = next.split(search).length - 1;
        if (occurrences !== 1) {
          skipped++;
          continue;
        }
        next = next.replace(search, replace);
        applied++;
        accepted.push({ search, replace, reason: String(patch?.reason || "").slice(0, 160) });
      }
      if (applied > 0 && next !== body) {
        chapter.revisionHistory = Array.isArray(chapter.revisionHistory) ? chapter.revisionHistory : [];
        chapter.revisionHistory.push({
          at: Date.now(),
          kind: "continuity-auto-repair",
          body,
          bodySig: textSignature(body),
          patches: accepted,
        });
        if (chapter.revisionHistory.length > 3) chapter.revisionHistory = chapter.revisionHistory.slice(-3);
        chapter.body = next;
        chapter.updatedAt = Date.now();
        ProductionState()?.invalidateAfterBodyEdit?.(chapter, {
          task,
          authorEdit: false,
          stage: "continuity-repair",
          reason: "连续性修订后等待复检与交接",
        });
        applyCraftSignals(project, task, chapter, next);
        log(project, `连续性局部修订 ${chapter.title} applied=${applied} skipped=${skipped}`);
      }
      return { applied, skipped, patches: accepted };
    }
  
    async function reviewAndRepairChapter(project, cfg, chapter, task = {}, hooks = {}) {
      if (cfg.continuityReviewEnabled !== true) return { status: "skipped", issues: [] };
      const first = await reviewChapterContinuity(project, cfg, chapter, task, hooks);
      let finalReview = first;
      if (cfg.continuityAutoRepair !== false && repairableIssues(first).length) {
        const repair = await repairChapterContinuity(project, cfg, chapter, task, first, hooks);
        if (repair.applied > 0) {
          finalReview = await reviewChapterContinuity(project, cfg, chapter, task, { ...hooks, force: true });
          if (finalReview.status === "pass" && typeof C().getActiveContinuityIssues === "function") {
            const summaries = new Set((first.issues || []).map((x) => x.summary));
            const handled = C()
              .getActiveContinuityIssues(project, 80)
              .filter((x) => summaries.has(x.summary))
              .map((x) => ({ issue_id: x.id, resolution: "自动局部修订后复检通过" }));
            if (handled.length) {
              C().mergeContinuityIssues(
                project,
                { handled_warnings: handled },
                { chapter: chapter.title, taskId: task?.id || "", order: chapter.order || task?.order || 0 }
              );
            }
          }
        }
      }
      if (cfg.continuityReviewPolicy === "strict" && !["pass", "warn"].includes(finalReview.status)) {
        const err = new Error(`连续性审查未通过：${finalReview.issues?.[0]?.summary || "存在 blocker"}`);
        err.code = "CONTINUITY_REVIEW_FAILED";
        task.lastErrorStage = "review";
        throw err;
      }
      return finalReview;
    }
  
    /**
     * 对已存在正文执行统一章后交接。供普通生成、手动摘要和正式 Harness 共用。
     * 正文永不在这里重写；交接失败时明确标记 stale，等待安全重试。
     */
    async function handoffChapter(project, cfg, chapter, task = {}, hooks = {}) {
      const observer = Observability();
      const startedAt = observer?.startTimer?.();
      let runtimeStage = "handoff-precondition";
      if (!chapter?.body?.trim()) {
        const error = new Error("本章无正文，不能执行章后交接");
        error.code = "HANDOFF_BODY_MISSING";
        const failure = observer?.captureFailure?.(project, error, { chapter, task, stage: runtimeStage });
        observer?.record?.(
          "handoff",
          {
            stage: runtimeStage,
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: false,
            chapterId: chapter?.id,
            taskId: task?.id,
            code: failure?.code || error.code,
            category: failure?.category || "handoff",
          },
          project
        );
        throw error;
      }
      const handoffPolicy = ProductionState()?.canHandoff?.(chapter, cfg, hooks);
      const legacyBlocked =
        !handoffPolicy &&
        cfg?.productionEngineEnabled !== false &&
        cfg?.productionQualityPolicy !== "warn" &&
        ["needs_revision", "quality-blocked"].includes(
          String(chapter.production?.status || chapter.production?.stage || "")
        ) &&
        hooks.qualityValidated !== true;
      if (handoffPolicy?.ok === false || legacyBlocked) {
        ChapterState()?.requestRevision?.(chapter, task, {
          reason: handoffPolicy?.reason || "本章尚未通过叙事质量闸门",
          stage: chapter.production?.stage || "quality-review",
        });
        const error = new Error("本章尚未通过叙事质量闸门，不能直接交接；请重新运行生产验收");
        error.code = "QUALITY_GATE_BLOCKED";
        runtimeStage = chapter.production?.stage || "quality-review";
        const failure = observer?.captureFailure?.(project, error, {
          chapter,
          task,
          stage: runtimeStage,
          category: "quality",
        });
        observer?.record?.(
          "handoff",
          {
            stage: runtimeStage,
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: false,
            chapterId: chapter.id,
            taskId: task?.id,
            code: failure?.code || error.code,
            category: failure?.category || "quality",
          },
          project
        );
        throw error;
      }
      ChapterState().startHandoff(chapter, task);
      try {
        // production-engine 已在质量闸门之前完成连续性复检；此处不得在
        // qualityValidated 之后再次改写正文。
        if (hooks.qualityValidated !== true) {
          runtimeStage = "continuity-review";
          await reviewAndRepairChapter(project, cfg, chapter, task, hooks);
        }
        runtimeStage = "digest";
        hooks.onStatus?.("digesting");
        const digest = await digestChapter(project, cfg, chapter, task, hooks);
        runtimeStage = "graph";
        hooks.onStatus?.("graphing");
        await extractGraphDelta(project, cfg, chapter, hooks);
        ChapterState().completeHandoff(chapter, task);
        // 生产引擎负责压缩场面正文并写 bodySig；状态投影已由 ChapterState 收口。
        ProductionEngine()?.markHandoffComplete?.(chapter);
        runtimeStage = "index";
        hooks.onStatus?.("index");
        try {
          Rag()?.ensureIndex(project, true);
        } catch (e) {
          log(project, `章后索引更新失败: ${e.message || e}`);
        }
        runtimeStage = "done";
        hooks.onStatus?.("done");
        observer?.record?.(
          "handoff",
          {
            stage: runtimeStage,
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: true,
            chapterId: chapter.id,
            taskId: task?.id,
            digestFacts: [
              ...(digest?.happened || []),
              ...(digest?.new_info || []),
              ...(digest?.must_carry || []),
            ],
          },
          project
        );
        return digest;
      } catch (e) {
        ChapterState().markHandoffStale(chapter, task, { reason: e.message || String(e) });
        task.lastError = e.message || String(e);
        task.lastErrorStage = task.lastErrorStage || runtimeStage || "digest";
        const failure = observer?.captureFailure?.(project, e, {
          chapter,
          task,
          stage: task.lastErrorStage,
        });
        observer?.record?.(
          "handoff",
          {
            stage: task.lastErrorStage,
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: false,
            chapterId: chapter.id,
            taskId: task?.id,
            code: failure?.code || e?.code || e?.name || "HANDOFF_FAILED",
            category: failure?.category || "handoff",
          },
          project
        );
        throw e;
      }
    }
  
    /**
     * 自动：写一章 + 摘要 + 关系。
     * 状态机：pending → writing → written → digested → done
     * 重入时：written 只补摘要/关系，digested 只补关系，避免叠正文。
     */

    return {
      digestChapter,
      extractGraphDelta,
      reviewChapterContinuity,
      repairChapterContinuity,
      reviewAndRepairChapter,
      repairableIssues,
      handoffChapter,
      recoverStaleHandoffs,
      pendingHandoffChapters,
      maybeHandoffAfterRevision,
    };
  }

  return { create };
})();
