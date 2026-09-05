/** DOM-free application workflows for generation, revision, cancellation and handoff. */
window.NOVEL_WRITE_USE_CASES = (() => {
  function create({
    pipe,
    productionState,
    getProductionEngine = () => null,
    uid,
    persistCheckpoint = () => {},
    flushProject,
    getObservability = () => null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    createAbortController = () => new AbortController(),
  } = {}) {
    if (!pipe || typeof pipe !== "object") throw new TypeError("write use cases require pipe");
    if (typeof uid !== "function") throw new TypeError("write use cases require uid");
    if (typeof flushProject !== "function") throw new TypeError("write use cases require flushProject");

    let abortController = null;
    let runToken = 0;
    let autoRunning = false;

    function observability() {
      return getObservability?.() || null;
    }

    function classifyError(error, context = {}) {
      const observer = observability();
      if (observer?.classifyError) return observer.classifyError(error, context).category;
      if (error?.name === "AbortError") return "cancel";
      if (error?.code === "RAG_REQUIRED") return "retrieval";
      if (error?.code === "REVISION_FAILED" || error?.code === "QUALITY_GATE_BLOCKED") return "quality";
      return "model";
    }

    function abort({ stopAuto = false } = {}) {
      if (stopAuto) autoRunning = false;
      abortController?.abort();
    }

    function isAutoRunning() {
      return autoRunning;
    }

    /**
     * 生成锁也必须有运行令牌所有权。被后继运行 abort 的旧用例进入 finally 时，
     * 只能释放自己的租约，不能解开后继者仍持有的全局锁。
     */
    function acquireLock(ports, chapterId) {
      const token = runToken;
      const current = () => token === runToken;
      if (current()) ports.setLock?.(true, chapterId);
      return {
        update(nextChapterId) {
          if (current()) ports.setLock?.(true, nextChapterId);
        },
        release() {
          if (current()) ports.setLock?.(false);
        },
      };
    }

    async function run(work, opts = {}, ports = {}) {
      if (ports.guardWritable?.(opts.actionLabel || "执行生成或分析")) return { skipped: true };
      abortController?.abort();
      const token = ++runToken;
      abortController = createAbortController();
      const signal = abortController.signal;
      const current = () => token === runToken;
      ports.setStopControls?.(true);
      try {
        return await work(signal);
      } catch (error) {
        if (current()) {
          const failureContext = ports.failureContext?.(error) || {};
          const envelope = observability()?.captureFailure?.(
            failureContext.project || null,
            error,
            failureContext
          );
          const category = envelope?.category || classifyError(error, failureContext);
          if (typeof ports.onRunError === "function") {
            ports.onRunError(error, category, envelope);
            return { error };
          }
          throw error;
        }
        return { superseded: true, error };
      } finally {
        if (current()) {
          ports.flushStream?.();
          abortController = null;
          if (!opts.autoOwnsLock) {
            autoRunning = false;
            ports.setLock?.(false);
          } else if (autoRunning) {
            autoRunning = false;
            ports.setLock?.(false);
          }
          ports.setStopControls?.(false);
          if (!opts.autoOwnsLock) ports.persist?.();
        }
      }
    }

    function addWritingHints(chapter, ports) {
      if (!chapter?.title) return;
      ports.addWritingHints?.(chapter);
    }

    function checkpoint(project) {
      project._dirty = true;
      persistCheckpoint(project);
    }

    async function writeTask({ project, cfg, task, signal, instruction = "" }, ports = {}) {
      if (!task) return null;
      ports.status?.("装配写作记忆…", "busy");
      ports.autoStatus?.(`写 ${task.id}`);
      const chapter = pipe.ensureChapterForTask(project, task);
      const snapshot = ports.captureReview?.(project, chapter, "task");
      const lock = acquireLock(ports, chapter.id);
      addWritingHints(chapter, ports);
      try {
        ports.syncBeatPlan?.(chapter);
        await pipe.autoChapterCycle(project, cfg, task, {
          signal,
          onDelta: ports.onDelta,
          onStatus: (stage) => ports.chapterStatus?.(task.id, stage),
          onCheckpoint: () => checkpoint(project),
          instruction,
        });
        ports.flushStream?.();
        await flushProject(project);
        const pending =
          chapter.production?.status === "accepted_pending_handoff" || chapter.handoffStatus !== "done";
        ports.taskOutcome?.({ project, task, chapter, pending });
      } finally {
        ports.flushStream?.();
        lock.release();
      }
      ports.renderWrite?.();
      ports.renderControl?.();
      ports.showReview?.(snapshot, chapter, {
        canUndo: false,
        note:
          chapter.production?.status === "accepted_pending_handoff"
            ? "正文已通过质量闸门，等待章后交接"
            : "已完成审查与章后交接",
        undoReason: "本章结果已更新故事记忆；请通过章节历史或快照回退完整状态",
      });
      return chapter;
    }

    async function autoWrite({ project, cfg, signal, instruction = "" }, ports = {}) {
      autoRunning = true;
      const pending = (project.tasks || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .filter((task) => task.status !== "done");
      if (!pending.length) {
        autoRunning = false;
        ports.noPending?.();
        return { completed: 0, stopped: false };
      }
      ports.switchToWrite?.();
      const first = pipe.ensureChapterForTask(project, pending[0]);
      const lock = acquireLock(ports, first.id);
      let completed = 0;
      let stopped = false;
      try {
        for (const task of pending) {
          if (!autoRunning) {
            stopped = true;
            break;
          }
          ports.autoStatus?.(`自动：${task.id} (${task.status || "pending"})`);
          const chapter = pipe.ensureChapterForTask(project, task);
          lock.update(chapter.id);
          addWritingHints(chapter, ports);
          try {
            ports.status?.("装配写作记忆…", "busy");
            ports.syncBeatPlan?.(chapter);
            await pipe.autoChapterCycle(project, cfg, task, {
              signal,
              onDelta: ports.onDelta,
              onStatus: (stage) => ports.chapterStatus?.(task.id, stage),
              onCheckpoint: () => checkpoint(project),
              instruction,
            });
            ports.flushStream?.();
            if (
              chapter.production?.status === "accepted_pending_handoff" ||
              chapter.handoffStatus !== "done"
            ) {
              ports.status?.("正文验收通过 · 待章后交接", "warn");
            }
          } catch (error) {
            ports.flushStream?.();
            if (error?.name === "AbortError") throw error;
            stopped = true;
            const failure = observability()?.captureFailure?.(project, error, {
              chapter,
              task,
              stage: task.lastErrorStage || chapter.production?.stage || "write",
            });
            ports.taskError?.(task, error, failure);
            break;
          }
          try {
            await flushProject(project);
          } catch (error) {
            const wrapped = new Error(`任务 ${task.id} 已生成但未能安全存盘：${error.message || error}`, {
              cause: error,
            });
            wrapped.code = error?.code || "STORAGE_SAVE_FAILED";
            const failure = observability()?.captureFailure?.(project, wrapped, {
              chapter,
              task,
              stage: "save-book",
            });
            ports.persistError?.(task, wrapped, failure);
            throw wrapped;
          }
          completed += 1;
          ports.renderWrite?.();
          ports.renderControl?.();
          await sleep(cfg.autoChapterDelayMs || 800);
        }
      } finally {
        autoRunning = false;
        lock.release();
      }
      ports.autoStatus?.("连写结束");
      ports.autoComplete?.();
      return { completed, stopped };
    }

    function taskForRevision(project, chapter) {
      return (
        (project.tasks || []).find(
          (task) => task.id === chapter?.taskId || task.id === project.activeTaskId
        ) || {
          id: `annotation_${chapter.id}`,
          order: chapter.order || 0,
          chapter_title: chapter.title || "当前章节",
          goal: "根据作者批注修订当前章节",
          beats: [],
          must_include: [],
          must_not: project.locks?.forbidden || [],
        }
      );
    }

    async function revise({
      project,
      cfg,
      chapter,
      task = taskForRevision(project, chapter),
      signal,
      annotation,
      originalBody,
      originalUpdatedAt = chapter?.updatedAt,
    }, ports = {}) {
      if (!chapter || !String(originalBody || "").trim()) throw new Error("请先选择一章有正文的章节");
      if (!String(annotation || "").trim()) throw new Error("请先写下本轮批注");
      const snapshot = ports.captureReview?.(project, chapter, "annotate");
      ports.status?.("请求模型并根据批注修订…", "busy");
      const lock = acquireLock(ports, chapter.id);
      try {
        ports.syncBeatPlan?.(chapter);
        await pipe.reviseChapter(project, cfg, task, chapter, {
          signal,
          annotation,
          originalBody,
        });
        ports.afterRevision?.({ project, task, chapter, snapshot });
        return chapter;
      } catch (error) {
        chapter.body = originalBody;
        chapter.updatedAt = originalUpdatedAt;
        ports.rollbackRevision?.(chapter, originalBody);
        if (error?.name !== "AbortError") error.code = "REVISION_FAILED";
        throw error;
      } finally {
        lock.release();
      }
    }

    async function continueDraft({
      project,
      cfg,
      task,
      signal,
      chapterTitle,
      body,
      instruction,
    }, ports = {}) {
      let chapter = (project.chapters || []).find((item) => item.id === project.activeChapterId);
      if (!chapter) {
        chapter = {
          id: uid(),
          taskId: task?.id && task.id !== "manual" ? task.id : null,
          title: String(chapterTitle || "").trim() || task?.chapter_title || "新章节",
          order: (project.chapters?.length || 0) + 1,
          body: "",
          updatedAt: Date.now(),
        };
        project.chapters = project.chapters || [];
        project.chapters.push(chapter);
        project.activeChapterId = chapter.id;
      }
      chapter.body = String(body || "");
      chapter.title = String(chapterTitle || "").trim() || chapter.title;
      let effectiveTask = task || {
        id: "manual",
        chapter_title: chapter.title,
        goal: "按作者指令续写",
        beats: [],
        must_include: [],
        must_not: project.locks?.forbidden || [],
        hook_end: "",
      };
      if (effectiveTask.id === "manual") {
        effectiveTask = {
          ...effectiveTask,
          id: `manual_${chapter.id}`,
          order: chapter.order || (project.chapters?.length || 1),
          chapter_title: chapter.title,
          goal: instruction,
        };
      }
      const snapshot = ports.captureReview?.(project, chapter, "continue");
      ports.status?.("装配写作记忆…", "busy");
      const lock = acquireLock(ports, chapter.id);
      try {
        ports.syncBeatPlan?.(chapter);
        await pipe.continueChapter(project, cfg, effectiveTask, {
          signal,
          instruction,
          onDelta: ports.onDelta,
          onStatus: (stage) => ports.chapterStatus?.("手动生成", stage),
        });
        ports.flushStream?.();
        ports.afterContinue?.({ project, task: effectiveTask, chapter, snapshot });
        return chapter;
      } finally {
        ports.flushStream?.();
        lock.release();
      }
    }

    async function rewriteSelection({
      project,
      cfg,
      task,
      chapter,
      signal,
      body,
      start,
      end,
      instruction,
    }, ports = {}) {
      const selection = String(body || "").slice(start, end);
      if (!selection) throw new Error("请先选中要重写的段落");
      const snapshot = ports.captureReview?.(project, chapter, "rewrite");
      ports.status?.("重写中…", "busy");
      const lock = acquireLock(ports, chapter?.id || project.activeChapterId);
      try {
        ports.syncBeatPlan?.(chapter);
        await pipe.rewritePassage(project, cfg, task, chapter, {
          signal,
          selection,
          before: String(body || "").slice(0, start),
          after: String(body || "").slice(end),
          instruction,
        });
        ports.afterRewrite?.({ project, task, chapter, snapshot });
        return chapter;
      } catch (error) {
        if (error?.name !== "AbortError") error.code = "REVISION_FAILED";
        throw error;
      } finally {
        lock.release();
      }
    }

    async function handoffExisting({
      project,
      cfg,
      chapter,
      task,
      signal,
      editorBody,
      instruction = "",
    }, ports = {}) {
      if (!chapter?.body?.trim() && !String(editorBody || "").trim()) throw new Error("本章无正文");
      const lock = acquireLock(ports, chapter.id);
      ports.status?.("摘要+关系…", "busy");
      try {
        if (String(editorBody ?? chapter.body) !== String(chapter.body || "")) {
          chapter.body = String(editorBody || "");
          chapter.updatedAt = Date.now();
          ports.invalidateAfterAuthorEdit?.(chapter, task);
        }
        const effectiveTask =
          task || {
            id: `manual_${chapter.id}`,
            order: chapter.order || 0,
            chapter_title: chapter.title || "",
            goal: "根据当前正文更新长期记忆",
          };
        const blocked =
          productionState?.isQualityBlocked?.(chapter) ??
          ["needs_revision", "quality-blocked"].includes(String(chapter.production?.status || ""));
        const engine = getProductionEngine();
        if (blocked && cfg.productionEngineEnabled !== false && engine?.runChapter) {
          await engine.runChapter(project, cfg, effectiveTask, {
            signal,
            handoff: true,
            onStatus: (stage) => ports.chapterStatus?.("质量验收", stage),
            instruction,
          });
        } else {
          await pipe.handoffChapter(project, cfg, chapter, effectiveTask, {
            signal,
            onStatus: (stage) => ports.chapterStatus?.("章后交接", stage),
          });
        }
        ports.afterHandoff?.({ project, chapter, task: effectiveTask });
        return chapter;
      } finally {
        lock.release();
        ports.finalizeHandoff?.();
      }
    }

    async function repairIssue({ project, cfg, chapter, task, issue, signal }, ports = {}) {
      if (!chapter?.body?.trim()) throw new Error("本章没有可修复的正文");
      const lock = acquireLock(ports, chapter.id);
      ports.status?.("正在执行精确局部修复…", "busy");
      try {
        const result = await pipe.repairChapterContinuity(
          project,
          cfg,
          chapter,
          task || {},
          { issues: [issue] },
          { signal, onStatus: (stage) => ports.chapterStatus?.("局部修复", stage) }
        );
        if (!result?.applied) throw new Error("未找到唯一可安全替换的片段，正文保持不变");
        issue.status = "handled";
        issue.resolution = "已执行精确局部修复";
        issue.updatedAt = Date.now();
        if (cfg.manualAutoHandoff !== false) {
          try {
            await pipe.handoffChapter(project, cfg, chapter, task || {}, {
              signal,
              onStatus: (stage) => ports.chapterStatus?.("局部修复交接", stage),
            });
            ports.repairOutcome?.({ chapter, handedOff: true });
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            ports.repairOutcome?.({ chapter, handedOff: false, error });
          }
        } else {
          ports.repairOutcome?.({ chapter, handedOff: false });
        }
        ports.renderWrite?.();
        ports.renderControl?.();
        return result;
      } finally {
        lock.release();
      }
    }

    return {
      run,
      abort,
      isAutoRunning,
      classifyError,
      writeTask,
      autoWrite,
      taskForRevision,
      revise,
      continueDraft,
      rewriteSelection,
      handoffExisting,
      repairIssue,
    };
  }

  return { create };
})();
