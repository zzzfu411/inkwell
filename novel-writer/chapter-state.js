/**
 * 章节业务状态的唯一转换边界。
 *
 * 这里同时维护 task / production / handoff 三个持久化投影；调用方可以更新
 * 场面、报告等领域数据，但不应各自拼装终态。模块保持无 DOM、无网络、无存储。
 */
window.NOVEL_CHAPTER_STATE = (() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const BLOCKED_STATUSES = Object.freeze(["needs_revision", "quality-blocked"]);
  const VALIDATED_STATUSES = Object.freeze(["accepted", "accepted_pending_handoff", "done"]);
  const PRODUCTION_STATUSES = Object.freeze([
    "pending",
    "needs_revision",
    "revising",
    "accepted",
    "accepted_pending_handoff",
    "done",
    "failed",
  ]);
  const BLOCKED_SET = new Set(BLOCKED_STATUSES);
  const VALIDATED_SET = new Set(VALIDATED_STATUSES);
  const PRODUCTION_SET = new Set(PRODUCTION_STATUSES);
  const PRODUCTION_TRANSITIONS = Object.freeze({
    pending: Object.freeze(["pending", "needs_revision", "revising", "accepted", "accepted_pending_handoff", "failed"]),
    needs_revision: Object.freeze(["needs_revision", "pending", "revising", "accepted", "accepted_pending_handoff", "failed"]),
    revising: Object.freeze(["revising", "pending", "needs_revision", "accepted", "accepted_pending_handoff", "failed"]),
    accepted: Object.freeze(["accepted", "accepted_pending_handoff", "needs_revision", "done", "failed"]),
    accepted_pending_handoff: Object.freeze(["accepted_pending_handoff", "accepted", "needs_revision", "done", "failed"]),
    done: Object.freeze(["done", "pending", "needs_revision", "accepted_pending_handoff"]),
    failed: Object.freeze(["failed", "pending", "needs_revision", "revising"]),
    // v1 早期曾把 stage 写进 status；读取修复只允许回到正式阻断态。
    "quality-blocked": Object.freeze(["needs_revision"]),
  });

  function at(options = {}) {
    return Number.isFinite(Number(options.at)) ? Number(options.at) : Date.now();
  }

  function productionOf(chapter) {
    const production = chapter?.production;
    return production && typeof production === "object" && !Array.isArray(production)
      ? production
      : null;
  }

  function statusOf(chapter) {
    const production = productionOf(chapter);
    return String(production?.status || production?.stage || "");
  }

  function isQualityBlocked(chapter) {
    return BLOCKED_SET.has(statusOf(chapter));
  }

  function isValidated(chapter) {
    return VALIDATED_SET.has(statusOf(chapter));
  }

  function touch(production, options = {}) {
    if (production && options.touch !== false) production.updatedAt = at(options);
  }

  function canTransition(from, to) {
    const source = String(from || "pending");
    const target = String(to || "");
    return Boolean(PRODUCTION_TRANSITIONS[source]?.includes(target));
  }

  function transitionProduction(chapter, nextStatus, options = {}) {
    const production = productionOf(chapter);
    if (!production) return null;
    const previousStatus = String(production.status || "pending");
    if (options.force !== true && !canTransition(previousStatus, nextStatus)) {
      const error = new Error(`非法章节生产状态转换：${previousStatus} → ${nextStatus}`);
      error.code = "ILLEGAL_CHAPTER_TRANSITION";
      error.from = previousStatus;
      error.to = nextStatus;
      throw error;
    }
    production.status = nextStatus;
    return production;
  }

  function clearRuntime(production) {
    if (!production) return;
    delete production.runtimeState;
    delete production.runtimeError;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function captureProjection(chapter, task) {
    return {
      hasProduction: Object.prototype.hasOwnProperty.call(chapter || {}, "production"),
      production: clone(chapter?.production),
      hasQualityReview: Object.prototype.hasOwnProperty.call(chapter || {}, "qualityReview"),
      qualityReview: clone(chapter?.qualityReview),
      handoffStatus: chapter?.handoffStatus,
      handoffError: chapter?.handoffError,
      handoffAt: chapter?.handoffAt,
      taskStatus: task?.status,
      taskLastError: task?.lastError,
      taskLastErrorStage: task?.lastErrorStage,
    };
  }

  /** 撤销一次尚未交接的生成时，原子恢复正文关联的全部持久化投影。 */
  function restoreProjection(chapter, task, snapshot) {
    if (!chapter || typeof chapter !== "object" || !snapshot || typeof snapshot !== "object") {
      return { changed: false, status: "missing-snapshot" };
    }
    if (snapshot.hasProduction) chapter.production = clone(snapshot.production);
    else delete chapter.production;
    if (snapshot.hasQualityReview) chapter.qualityReview = clone(snapshot.qualityReview);
    else delete chapter.qualityReview;
    for (const [key, value] of [
      ["handoffStatus", snapshot.handoffStatus],
      ["handoffError", snapshot.handoffError],
      ["handoffAt", snapshot.handoffAt],
    ]) {
      if (value === undefined) delete chapter[key];
      else chapter[key] = value;
    }
    if (task && typeof task === "object") {
      for (const [key, value] of [
        ["status", snapshot.taskStatus],
        ["lastError", snapshot.taskLastError],
        ["lastErrorStage", snapshot.taskLastErrorStage],
      ]) {
        if (value === undefined) delete task[key];
        else task[key] = value;
      }
    }
    return { changed: true, status: statusOf(chapter) || task?.status || "legacy" };
  }

  function requestRevision(chapter, task, options = {}) {
    const production = productionOf(chapter);
    const reason = String(options.reason || "正文等待重新通过叙事质量闸门");
    if (production) {
      transitionProduction(chapter, "needs_revision", options);
      clearRuntime(production);
      production.stage = String(options.stage || "quality-review");
      touch(production, options);
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = reason;
    }
    if (task && typeof task === "object") {
      task.status = production ? "needs_revision" : "written";
      task.lastError = reason;
      task.lastErrorStage = String(options.errorStage || "quality-gate");
    }
    return { changed: Boolean(production), status: production?.status || "legacy", reason };
  }

  function markGenerating(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (!production) return { changed: false, status: "legacy" };
    transitionProduction(chapter, "pending", options);
    clearRuntime(production);
    production.stage = String(options.stage || production.stage || "generating");
    touch(production, options);
    if (task && typeof task === "object") {
      task.status = "writing";
      task.lastError = "";
      task.lastErrorStage = "";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.handoffReason || "正文生产中，等待重新交接");
    }
    return { changed: true, status: production.status };
  }

  /** 旧写章链没有 production；仍必须通过同一边界维护 task/handoff 投影。 */
  function markWriting(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (production) return markGenerating(chapter, task, options);
    if (task && typeof task === "object") {
      task.status = "writing";
      task.lastError = "";
      task.lastErrorStage = "";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.reason || "正文写作中，等待章后交接");
    }
    return { changed: Boolean(chapter || task), status: "writing" };
  }

  function markWritten(chapter, task, options = {}) {
    if (task && typeof task === "object") {
      task.status = "written";
      task.lastError = "";
      task.lastErrorStage = "";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.reason || "正文已写完，等待章后交接");
    }
    touch(productionOf(chapter), options);
    return { changed: Boolean(chapter || task), status: "written" };
  }

  function markRevising(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (!production) return { changed: false, status: "legacy" };
    transitionProduction(chapter, "revising", options);
    clearRuntime(production);
    production.stage = String(options.stage || "revising");
    touch(production, options);
    if (task && typeof task === "object") task.status = "writing";
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.reason || "正文修订中，等待重新交接");
    }
    return { changed: true, status: production.status };
  }

  function markAccepted(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (!production) return { changed: false, status: "legacy" };
    transitionProduction(
      chapter,
      options.pendingHandoff === true ? "accepted_pending_handoff" : "accepted",
      options
    );
    clearRuntime(production);
    production.stage = "accepted";
    touch(production, options);
    if (task && typeof task === "object") {
      task.status = "written";
      task.lastError = "";
      task.lastErrorStage = "";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.reason || "正文已验收，等待章后交接");
    }
    return { changed: true, status: production.status };
  }

  function startHandoff(chapter, task, options = {}) {
    clearRuntime(productionOf(chapter));
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "running";
      chapter.handoffError = "";
    }
    if (
      task &&
      typeof task === "object" &&
      !["written", "digested", "done"].includes(String(task.status || ""))
    ) {
      task.status = "written";
    }
    touch(productionOf(chapter), options);
    return { changed: Boolean(chapter), status: "running" };
  }

  function markDigestComplete(chapter, task, options = {}) {
    if (task && typeof task === "object") task.status = "digested";
    touch(productionOf(chapter), options);
    return { changed: Boolean(task), status: "digested" };
  }

  function completeHandoff(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (production) {
      transitionProduction(chapter, "done", options);
      clearRuntime(production);
      production.stage = "done";
      touch(production, options);
    }
    if (task && typeof task === "object") {
      task.status = "done";
      task.lastError = "";
      task.lastErrorStage = "";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "done";
      // 读取旧书进行投影修复时不制造一个虚假的“当前时间”。
      if (options.touch !== false || Number(options.at) > 0) chapter.handoffAt = at(options);
      chapter.handoffError = "";
    }
    return { changed: Boolean(chapter || task), status: "done" };
  }

  function markHandoffStale(chapter, task, options = {}) {
    const reason = String(options.reason || "章后交接未完成，等待安全重试");
    const production = productionOf(chapter);
    // 已完成章需要重做交接时，回退到“正文已验收、等待交接”，不能留下
    // production.done + handoff.stale 这种互相矛盾的持久化组合。
    if (production?.status === "done") {
      transitionProduction(chapter, "accepted_pending_handoff", options);
      production.stage = "accepted";
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = reason;
    }
    if (task && typeof task === "object" && task.status === "done") task.status = "written";
    touch(production, options);
    return { changed: Boolean(chapter), status: "stale", reason };
  }

  function markPaused(chapter, task, options = {}) {
    const production = productionOf(chapter);
    if (production) {
      const previousStatus = String(production.status || "pending");
      production.lastStableState = {
        status: previousStatus,
        stage: String(production.stage || ""),
        at: at(options),
      };
      production.runtimeState = "paused";
      if (["accepted", "accepted_pending_handoff"].includes(previousStatus)) {
        transitionProduction(chapter, "accepted_pending_handoff", options);
        production.stage = "accepted";
      } else if (!BLOCKED_SET.has(previousStatus) && previousStatus !== "done") {
        transitionProduction(chapter, "pending", options);
        production.stage = "paused";
      }
      touch(production, options);
    }
    if (task && typeof task === "object") {
      if (["accepted", "accepted_pending_handoff"].includes(String(production?.status || ""))) {
        task.status = "written";
      } else if (production?.status === "done") {
        task.status = "done";
      } else if (BLOCKED_SET.has(String(production?.status || ""))) {
        task.status = "needs_revision";
      } else {
        task.status = "pending";
      }
    }
    if (chapter && typeof chapter === "object" && chapter.handoffStatus === "running") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = String(options.reason || "生产已暂停，等待继续");
    }
    return { changed: Boolean(production || task), status: "pending" };
  }

  function markFailed(chapter, task, options = {}) {
    const production = productionOf(chapter);
    const reason = String(options.reason || "章节生产失败");
    if (production) {
      const previousStatus = String(production.status || "pending");
      production.lastStableState = {
        status: previousStatus,
        stage: String(production.stage || ""),
        at: at(options),
      };
      production.runtimeState = "failed";
      production.runtimeError = reason;
      if (VALIDATED_SET.has(previousStatus)) {
        if (previousStatus !== "done") transitionProduction(chapter, "accepted_pending_handoff", options);
        production.stage = previousStatus === "done" ? "done" : "accepted";
      } else {
        transitionProduction(chapter, "failed", options);
        production.stage = String(options.stage || production.stage || "failed");
      }
      touch(production, options);
    }
    if (task && typeof task === "object") {
      task.status =
        production?.status === "done"
          ? "done"
          : VALIDATED_SET.has(String(production?.status || ""))
            ? "written"
            : String(options.taskStatus || "pending");
      task.lastError = reason;
      task.lastErrorStage = String(options.errorStage || production?.stage || "production");
    }
    if (chapter && typeof chapter === "object") {
      chapter.handoffStatus = "stale";
      chapter.handoffError = reason;
    }
    return { changed: Boolean(production || task), status: "failed", reason };
  }

  /** 读取旧书时只修复可确定推导的投影，不制造新的运行时间。 */
  function repair(chapter, task) {
    const production = productionOf(chapter);
    if (!production) return { changed: false, reason: "legacy-chapter" };
    const before = JSON.stringify({
      production: production.status,
      stage: production.stage,
      task: task?.status,
      handoff: chapter?.handoffStatus,
    });
    const status = statusOf(chapter);
    if (BLOCKED_SET.has(status)) {
      requestRevision(chapter, task, {
        reason: chapter.handoffError || task?.lastError || "正文等待重新验收",
        stage: production.stage || "quality-review",
        touch: false,
      });
    } else if (status === "done" || chapter?.handoffStatus === "done") {
      const completedAt = Number(chapter?.handoffAt) || Number(production.updatedAt) || 0;
      completeHandoff(
        chapter,
        task,
        completedAt > 0
          ? { at: completedAt, touch: false, force: true }
          : { touch: false, force: true }
      );
    } else if (status === "accepted" || status === "accepted_pending_handoff") {
      if (task && task.status === "done") task.status = "written";
      if (chapter && chapter.handoffStatus !== "running") chapter.handoffStatus = "stale";
    }
    const after = JSON.stringify({
      production: production.status,
      stage: production.stage,
      task: task?.status,
      handoff: chapter?.handoffStatus,
    });
    return { changed: before !== after, reason: before === after ? "consistent" : "repaired" };
  }

  function validate(chapter, task) {
    const errors = [];
    const production = productionOf(chapter);
    if (!production) return { ok: true, errors };
    const status = String(production.status || "");
    if (status && !PRODUCTION_SET.has(status)) errors.push(`unknown production status: ${status}`);
    if (BLOCKED_SET.has(status)) {
      if (task && task.status !== "needs_revision") errors.push("blocked production requires task.needs_revision");
      if (chapter?.handoffStatus === "done" || chapter?.handoffStatus === "running") {
        errors.push("blocked production cannot be handed off");
      }
    }
    if (status === "done") {
      if (task && task.status !== "done") errors.push("production.done requires task.done");
      if (chapter?.handoffStatus !== "done") errors.push("production.done requires handoff.done");
    }
    if (
      ["accepted", "accepted_pending_handoff"].includes(status) &&
      chapter?.handoffStatus !== "running" &&
      task?.status === "done"
    ) {
      errors.push("accepted production cannot expose task.done before handoff");
    }
    return { ok: errors.length === 0, errors };
  }

  function repairProject(project) {
    const tasks = Array.isArray(project?.tasks) ? project.tasks : [];
    const taskById = new Map(tasks.map((task) => [task?.id, task]));
    let repaired = 0;
    const errors = [];
    for (const chapter of Array.isArray(project?.chapters) ? project.chapters : []) {
      const task = taskById.get(chapter?.taskId);
      if (repair(chapter, task).changed) repaired += 1;
      const validation = validate(chapter, task);
      for (const error of validation.errors) errors.push({ chapterId: chapter?.id || "", error });
    }
    return { repaired, errors };
  }

  return {
    SCHEMA_VERSION,
    BLOCKED_STATUSES,
    VALIDATED_STATUSES,
    PRODUCTION_STATUSES,
    PRODUCTION_TRANSITIONS,
    productionOf,
    statusOf,
    isQualityBlocked,
    isValidated,
    canTransition,
    captureProjection,
    restoreProjection,
    requestRevision,
    markGenerating,
    markWriting,
    markWritten,
    markRevising,
    markAccepted,
    startHandoff,
    markDigestComplete,
    completeHandoff,
    markHandoffStale,
    markPaused,
    markFailed,
    repair,
    validate,
    repairProject,
  };
})();
