/**
 * 「本次生成结果」卡片的状态机。
 *
 * 一次续写/重写/修订之后，作者要能看清改了多少字，并且在结果还没进故事记忆前撤回。
 * 撤销是毁稿风险最高的动作，所以「能不能撤」「撤回什么」必须是纯函数并被单测锁住：
 * 正文只要被再次改动，旧快照就作废，绝不能拿旧正文盖掉新写的内容。
 */
(function () {
  const KIND_LABELS = Object.freeze({
    continue: Object.freeze({ kicker: "续写结果", title: "新正文已接在原稿之后" }),
    rewrite: Object.freeze({ kicker: "选段重写", title: "重写结果已替换选中段落" }),
    annotate: Object.freeze({ kicker: "批注修订", title: "修订结果已替换本章原稿" }),
  });
  const FALLBACK_LABEL = Object.freeze({ kicker: "本次生成", title: "结果已写入正文" });
  const DEFAULT_UNDO_REASON = "结果已进入故事记忆，不能只回退正文";

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /** 生成前拍快照。revisionHistory 必须深拷贝，否则撤销时拿到的是被改过的同一个数组。 */
  function capture(project, chapter, kind) {
    const linkedTask = (project?.tasks || []).find((task) => task.id === chapter?.taskId);
    return {
      projectId: project?.id || "",
      chapterId: chapter?.id || "",
      kind,
      beforeBody: chapter?.body || "",
      beforeHandoffStatus: chapter?.handoffStatus,
      beforeHandoffError: chapter?.handoffError,
      beforeRevisionHistory: Array.isArray(chapter?.revisionHistory) ? clone(chapter.revisionHistory) : null,
      taskId: linkedTask?.id || "",
      beforeTaskStatus: linkedTask?.status,
      beforeProjection: window.NOVEL_CHAPTER_STATE?.captureProjection?.(chapter, linkedTask),
    };
  }

  /** 生成后落定：记住结果正文，用来判断作者之后有没有再动过。 */
  function seal(snapshot, chapter, opts = {}) {
    return {
      ...snapshot,
      afterBody: chapter?.body || "",
      canUndo: opts.canUndo !== false,
      undoReason: opts.canUndo === false ? opts.undoReason || DEFAULT_UNDO_REASON : "",
    };
  }

  function presentation(state, countWords, opts = {}) {
    const label = KIND_LABELS[state?.kind] || FALLBACK_LABEL;
    const before = countWords(state?.beforeBody || "");
    const after = countWords(state?.afterBody || "");
    const delta = after - before;
    const deltaLabel = delta === 0 ? "字数不变" : `${delta > 0 ? "+" : ""}${delta} 字`;
    const note = String(opts.note || "").trim();
    return {
      kicker: label.kicker,
      title: label.title,
      meta: `${before} → ${after} 字 · ${deltaLabel}${note ? ` · ${note}` : ""}`,
      delta,
      canUndo: state?.canUndo !== false,
      undoTitle: state?.canUndo !== false ? "恢复生成前的正文" : state?.undoReason || DEFAULT_UNDO_REASON,
    };
  }

  /** 结果卡只在「同一本书、同一章、正文仍是生成结果」时有效。 */
  function stillApplies(state, project, chapter) {
    if (!state) return false;
    return (
      project?.id === state.projectId &&
      chapter?.id === state.chapterId &&
      chapter?.body === state.afterBody
    );
  }

  function canUndo(state, project, chapter) {
    return Boolean(state?.canUndo) && stillApplies(state, project, chapter);
  }

  /**
   * 把章节和任务恢复到生成前。只改快照里记过的字段，
   * 生成前没有 revisionHistory 就删掉，不留下一条空历史。
   */
  function restore(state, chapter, task) {
    chapter.body = state.beforeBody;
    chapter.updatedAt = Date.now();
    if (state.beforeRevisionHistory) chapter.revisionHistory = state.beforeRevisionHistory;
    else delete chapter.revisionHistory;
    const projection =
      state.beforeProjection ||
      {
        hasProduction: false,
        hasQualityReview: false,
        handoffStatus: state.beforeHandoffStatus,
        handoffError: state.beforeHandoffError,
        taskStatus: state.beforeTaskStatus,
      };
    const transition = window.NOVEL_CHAPTER_STATE?.restoreProjection?.(chapter, task, projection);
    if (!transition) throw new Error("NOVEL_CHAPTER_STATE 未在 composer-review.js 前加载");
    return chapter;
  }

  window.NOVEL_COMPOSER_REVIEW = {
    KIND_LABELS,
    DEFAULT_UNDO_REASON,
    capture,
    seal,
    presentation,
    stillApplies,
    canUndo,
    restore,
  };
})();
