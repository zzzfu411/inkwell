/**
 * Inkwell 写章 Harness（Agent Harness）
 *
 * 对齐业界「Plan → Retrieve → Generate → Reflect/Handoff → Update Memory」图：
 * 1. prepare   重建分层记忆索引（RAG）
 * 2. retrieve  多查询混合检索（BM25 ± embeddings）
 * 3. write     装配上下文（故事线+canon+RAG+上章）→ 生成
 * 4. handoff   章后交接（摘要/细节/故事线/出场）
 * 5. index     新章入索引
 *
 * 参考：ReAct/Plan-Execute 写作流水线、Corrective/Adaptive RAG、
 * Hierarchical memory + Story Bible、Reflexion 式交接（用结构化 handoff 代替二次全文重写以省额度）
 */
window.NOVEL_HARNESS = (() => {
  const Pipe = () => window.NOVEL_PIPELINE;
  const Rag = () => window.NOVEL_RAG;
  const Ctx = () => window.NOVEL_CONTEXT;
  function ChapterState() {
    const state = window.NOVEL_CHAPTER_STATE;
    if (!state) throw new Error("NOVEL_CHAPTER_STATE 未在 harness.js 前加载");
    return state;
  }

  function log(project, msg) {
    Pipe().log(project, `[harness] ${msg}`);
  }

  function hasPriorWrittenStory(project, task) {
    const currentOrder = Number(task?.order) || Number.MAX_SAFE_INTEGER;
    return (project.chapters || []).some(
      (ch) =>
        String(ch?.body || "").trim() &&
        ch?.taskId !== task?.id &&
        (!Number(ch?.order) || Number(ch.order) < currentOrder)
    );
  }

  /**
   * 写前准备：索引 + 检索包
   */
  async function prepareAndRetrieve(project, cfg, task, { signal, forceReindex } = {}) {
    if (cfg?.ragEnabled === false) {
      project._lastRag = { at: Date.now(), taskId: task?.id, mode: "disabled", hitCount: 0, indexSize: 0 };
      return { ragPack: null, stage: "retrieve-disabled" };
    }
    const rag = Rag();
    if (!rag) {
      if (cfg?.ragFailurePolicy === "strict" && hasPriorWrittenStory(project, task)) {
        const err = new Error("严格连续性模式：RAG 模块不可用，已停止裸写");
        err.code = "RAG_REQUIRED";
        throw err;
      }
      return { ragPack: null, stage: "retrieve-skip" };
    }
    rag.ensureIndex(project, !!forceReindex);
    const ragPack = await rag.retrieveHybrid(project, task, cfg, {
      signal,
      topK: cfg.ragTopK || window.NOVEL_DEFAULTS?.ragTopK || 8,
      maxChars: cfg.ragMaxChars || window.NOVEL_DEFAULTS?.ragMaxChars || 3200,
    });
    project._lastRag = {
      at: Date.now(),
      taskId: task?.id,
      mode: ragPack.mode,
      hitCount: ragPack.hits?.length || 0,
      queries: ragPack.queries,
      indexSize: ragPack.indexSize,
    };
    log(
      project,
      `retrieve ${ragPack.mode} hits=${ragPack.hits?.length || 0}/${ragPack.indexSize} q=${(ragPack.queries || []).length}${
        ragPack.embedError ? " embed_err" : ""
      }`
    );
    if (cfg?.ragFailurePolicy === "strict" && hasPriorWrittenStory(project, task) && !(ragPack.hits || []).length) {
      const err = new Error("严格连续性模式：已有历史正文，但本章 RAG 零命中，已停止裸写");
      err.code = "RAG_REQUIRED";
      throw err;
    }
    return { ragPack, stage: "retrieved" };
  }

  /**
   * 完整一章 harness 周期（供 pipeline.autoChapterCycle 调用）
   * hooks 与 autoChapterCycle 兼容
   */
  async function runChapterHarness(project, cfg, task, hooks = {}) {
    const P = Pipe();
    const ch = P.ensureChapterForTask(project, task);

    if (task.status === "done" && ch.body?.trim() && !hooks.force && !hooks.forceRewrite) {
      hooks.onStatus?.("skip-done");
      log(project, `skip done ${task.id}`);
      return ch;
    }

    const st = task.status || "pending";
    let ragPack;

    // --- write path ---
    if (hooks.forceRewrite || !["written", "digested", "done"].includes(st)) {
      hooks.onStatus?.("retrieve");
      try {
        const prep = await prepareAndRetrieve(project, cfg, task, {
          signal: hooks.signal,
          forceReindex: hooks.forceReindex,
        });
        ragPack = prep.ragPack;
      } catch (e) {
        log(project, `retrieve failed: ${e.message || e}`);
        const strictBlocked =
          cfg?.ragFailurePolicy === "strict" &&
          cfg?.ragEnabled !== false &&
          hasPriorWrittenStory(project, task);
        project._lastRag = {
          at: Date.now(),
          taskId: task?.id,
          mode: strictBlocked ? "blocked" : "failed",
          hitCount: 0,
          error: e.message || String(e),
        };
        if (strictBlocked) {
          task.lastError = e.message || String(e);
          task.lastErrorStage = "retrieve";
          hooks.onStatus?.("retrieve-blocked");
          throw e;
        }
        hooks.onStatus?.("retrieve-warning");
        ragPack = null;
      }

      if (cfg.chapterBeatEnabled !== false) {
        try {
          hooks.onStatus?.("planning");
          await P.planChapterBeat(project, cfg, task, hooks);
        } catch (e) {
          log(project, `plan failed: ${e.message || e}`);
          if (cfg.chapterBeatPolicy === "strict") {
            task.lastError = e.message || String(e);
            task.lastErrorStage = "planning";
            throw e;
          }
        }
      }

      hooks.onStatus?.("writing");
      await P.writeOneChapter(project, cfg, task, {
        ...hooks,
        ragPack,
        beatPlan: task.beatPlan,
      });
    } else {
      log(project, `续跑 ${task.id}：跳过写章（${st}）`);
    }

    // --- handoff path ---
    if (task.status === "written") {
      if (cfg.continuityReviewEnabled === true) {
        hooks.onStatus?.("reviewing");
        try {
          await P.reviewAndRepairChapter(project, cfg, ch, task, hooks);
        } catch (e) {
          task.lastError = e.message || String(e);
          task.lastErrorStage = "review";
          ChapterState().markHandoffStale(ch, task, { reason: e.message || String(e) });
          throw e;
        }
      }
      hooks.onStatus?.("digesting");
      try {
        await P.digestChapter(project, cfg, ch, task, hooks);
      } catch (e) {
        task.lastError = e.message || String(e);
        task.lastErrorStage = "digest";
        ChapterState().markHandoffStale(ch, task, { reason: e.message || String(e) });
        throw e;
      }
    }

    if (task.status === "digested") {
      hooks.onStatus?.("graphing");
      await P.extractGraphDelta(project, cfg, ch, hooks);
      ChapterState().completeHandoff(ch, task);

      // 更新索引（新章正文 + 新 digest/canon）
      hooks.onStatus?.("index");
      try {
        Rag()?.ensureIndex(project, true);
        log(project, `reindex docs=${project.ragIndex?.N || 0}`);
      } catch (e) {
        log(project, `reindex skip: ${e.message || e}`);
      }
    }

    hooks.onStatus?.("done");
    return ch;
  }

  /**
   * 仅重建索引（设置页 / 手动）
   */
  function rebuildIndex(project) {
    const index = Rag()?.ensureIndex(project, true);
    log(project, `manual reindex docs=${index?.N || 0}`);
    return index;
  }

  /**
   * 调试：对任意 query 检索
   */
  function debugSearch(project, query, topK = 8) {
    const rag = Rag();
    if (!rag) return [];
    const index = rag.ensureIndex(project, false);
    return rag.retrieve(index, [query], { topK });
  }

  return {
    prepareAndRetrieve,
    runChapterHarness,
    rebuildIndex,
    debugSearch,
    hasPriorWrittenStory,
  };
})();
