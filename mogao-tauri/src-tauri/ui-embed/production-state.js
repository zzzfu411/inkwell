/**
 * 叙事生产状态的共享边界。
 *
 * production-engine 负责执行模型调用；本模块只维护持久化状态的不变量，
 * 供编辑器、Vault 装载、冲突合并和旧 Harness 共同使用。保持无 DOM、无网络，
 * 这样任何“正文被替换”的入口都能用同一条规则作废旧质量报告。
 */
window.NOVEL_PRODUCTION_STATE = (() => {
  "use strict";

  function ChapterState() {
    const state = window.NOVEL_CHAPTER_STATE;
    if (!state) throw new Error("NOVEL_CHAPTER_STATE 未在 production-state.js 前加载");
    return state;
  }

  const BLOCKED_STATUSES = ChapterState().BLOCKED_STATUSES;
  const VALIDATED_STATUSES = ChapterState().VALIDATED_STATUSES;
  const VALIDATED_SET = new Set(VALIDATED_STATUSES);

  function hash(value) {
    let result = 0x811c9dc5;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      result ^= source.charCodeAt(index);
      result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  }

  function bodySignature(value) {
    return `body_${hash(value || "")}`;
  }

  function statusOf(chapter) {
    return ChapterState().statusOf(chapter);
  }

  function isQualityBlocked(chapter) {
    return ChapterState().isQualityBlocked(chapter);
  }

  function expectedBodySignature(chapter) {
    const production = chapter?.production;
    if (!production || typeof production !== "object") return "";
    return String(
      production.bodySig ||
        production.qualityReview?.bodySig ||
        chapter?.qualityReview?.bodySig ||
        ""
    );
  }

  /**
   * 正文已被作者、工作区或磁盘冲突裁决改写：旧报告只能描述旧 body。
   * legacy 章节没有 production，不会被强行迁入新版状态机。
   */
  function invalidateAfterBodyEdit(chapter, options = {}) {
    const production = chapter?.production;
    if (!production || typeof production !== "object") {
      ChapterState().requestRevision(chapter, options.task, options);
      return { changed: false, reason: "legacy-chapter" };
    }
    const at = Number(options.at) || Date.now();
    const reason = String(options.reason || "正文已变更，等待重新通过叙事质量闸门");
    const previousStatus = statusOf(chapter);
    const previousBodySig = expectedBodySignature(chapter);
    const invalidatedBodySig = bodySignature(chapter?.body || "");

    production.gate = null;
    production.qualityReview = null;
    production.localMetrics = null;
    production.revisionPasses = 0;
    production.bodyAuthoritative = false;
    production.bodySig = "";
    production.invalidatedFromBodySig = previousBodySig;
    production.invalidatedBodySig = invalidatedBodySig;
    production.reviewInvalidatedAt = at;
    if (options.authorEdit !== false) production.authorEditedAt = at;
    production.invalidationReason = reason;
    production.updatedAt = at;

    chapter.qualityReview = null;
    ChapterState().requestRevision(chapter, options.task, {
      at,
      reason,
      stage: options.stage || "quality-review",
    });
    return { changed: true, previousStatus, status: production.status, bodySig: invalidatedBodySig };
  }

  /**
   * 装载完整正文时核对持久化签名。首次看到早期 v1 记录没有签名时只建立
   * 基线；已有签名与正文不一致时才作废报告。空正文通常是 localStorage slim
   * 缓存，不足以判断外部改稿，必须等 Vault hydrate 后再核对。
   */
  function reconcileChapter(chapter, options = {}) {
    const production = chapter?.production;
    if (!production || typeof production !== "object") {
      return { changed: false, reason: "legacy-chapter" };
    }
    const body = String(chapter?.body || "");
    if (!body.trim() && options.allowEmpty !== true) {
      return { changed: false, reason: "body-not-hydrated" };
    }
    const status = statusOf(chapter);
    const shouldVerify = production.bodyAuthoritative === true || VALIDATED_SET.has(status);
    if (!shouldVerify) return { changed: false, reason: "not-validated" };

    const actual = bodySignature(body);
    const expected = expectedBodySignature(chapter);
    if (!expected) {
      production.bodyAuthoritative = true;
      production.bodySig = actual;
      production.signatureMigratedAt = Number(options.at) || Date.now();
      return { changed: true, reason: "signature-baseline", bodySig: actual };
    }
    if (expected === actual) {
      production.bodyAuthoritative = true;
      production.bodySig = actual;
      return { changed: false, reason: "signature-match", bodySig: actual };
    }
    return {
      ...invalidateAfterBodyEdit(chapter, {
        ...options,
        authorEdit: false,
        stage: "quality-review",
        reason: options.reason || "磁盘或工作区正文已变化，旧质量报告已失效",
      }),
      reason: "signature-mismatch",
      expected,
      actual,
    };
  }

  function reconcileProject(project, options = {}) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
    const tasks = Array.isArray(project?.tasks) ? project.tasks : [];
    const taskById = new Map(tasks.map((task) => [task?.id, task]));
    let invalidated = 0;
    let baselined = 0;
    for (const chapter of chapters) {
      const task = taskById.get(chapter?.taskId);
      const result = reconcileChapter(chapter, { ...options, task });
      if (result.reason === "signature-mismatch") {
        invalidated += 1;
      } else if (result.reason === "signature-baseline") {
        baselined += 1;
      }
    }
    return { chapters: chapters.length, invalidated, baselined };
  }

  function canHandoff(chapter, cfg = {}, options = {}) {
    if (options.qualityValidated === true) return { ok: true, reason: "validated-this-run" };
    if (cfg.productionEngineEnabled === false || cfg.productionQualityPolicy === "warn") {
      return { ok: true, reason: "compatibility-policy" };
    }
    // 最终交接入口再核一次签名，兜住未来新增但忘记主动 invalidate 的正文写入路径。
    const reconciliation = reconcileChapter(chapter, {
      reason: "交接前发现正文已变化，旧质量报告已失效",
    });
    if (reconciliation.reason === "signature-mismatch") {
      return { ok: false, reason: "正文已变化，必须重新通过叙事质量闸门" };
    }
    if (isQualityBlocked(chapter)) {
      return { ok: false, reason: "本章尚未通过叙事质量闸门" };
    }
    if (chapter?.production && !VALIDATED_SET.has(statusOf(chapter))) {
      return { ok: false, reason: "本章尚未形成可验证的质量验收结果" };
    }
    return { ok: true, reason: "not-blocked" };
  }

  return {
    BLOCKED_STATUSES,
    VALIDATED_STATUSES,
    bodySignature,
    statusOf,
    isQualityBlocked,
    expectedBodySignature,
    invalidateAfterBodyEdit,
    reconcileChapter,
    reconcileProject,
    canHandoff,
  };
})();
