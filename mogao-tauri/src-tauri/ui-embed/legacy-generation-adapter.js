/** Compatibility adapter for legacy one-pass generation and author revision flows. */
window.NOVEL_LEGACY_GENERATION_ADAPTER = (() => {
  function create({
    getPrompts,
    getContext,
    getApi,
    getChapterState,
    getProductionState,
    getUid,
    getDefaults = () => ({}),
    getCraft = () => null,
    getProductionEngine = () => null,
    getHarness = () => null,
    getRag = () => null,
    getHandoffService,
    textSignature,
    log,
  } = {}) {
    for (const [name, dependency] of Object.entries({
      getPrompts,
      getContext,
      getApi,
      getChapterState,
      getProductionState,
      getUid,
      getHandoffService,
      textSignature,
      log,
    })) {
      if (typeof dependency !== "function") throw new TypeError(`legacy generation adapter requires ${name}`);
    }
    const P = getPrompts;
    const C = getContext;
    const API = getApi;
    const ChapterState = getChapterState;
    const ProductionState = getProductionState;
    const uid = getUid;
    const Defaults = getDefaults;
    const Craft = getCraft;
    const ProductionEngine = getProductionEngine;
    const Harness = getHarness;
    const Rag = getRag;
    const Handoff = getHandoffService;

    function recoverStaleHandoffs(...args) {
      return Handoff().recoverStaleHandoffs(...args);
    }

    function reviewAndRepairChapter(...args) {
      return Handoff().reviewAndRepairChapter(...args);
    }

    function digestChapter(...args) {
      return Handoff().digestChapter(...args);
    }

    function extractGraphDelta(...args) {
      return Handoff().extractGraphDelta(...args);
    }

    function handoffChapter(...args) {
      return Handoff().handoffChapter(...args);
    }

    function maybeHandoffAfterRevision(...args) {
      return Handoff().maybeHandoffAfterRevision(...args);
    }

    function ensureChapterForTask(project, task) {
      let ch = project.chapters.find((c) => c.taskId === task.id);
      if (!ch) {
        ch = {
          id: uid(),
          taskId: task.id,
          title: task.chapter_title || `第${task.order}章`,
          order: task.order || (project.chapters.length + 1),
          body: "",
          updatedAt: Date.now(),
        };
        project.chapters.push(ch);
      } else {
        if (task.order && !ch.order) ch.order = task.order;
        if (task.chapter_title && (!ch.title || ch.title.startsWith("第"))) {
          // 不强制覆盖用户改过的标题
        }
      }
      project.activeChapterId = ch.id;
      project.activeTaskId = task.id;
      return ch;
    }
  
    function buildBeatPlanPrompt(project, task, chapter) {
      const prev = C().findPrevWrittenChapter?.(project, task);
      const loops = C().getActivePlotLoops?.(project, task, 8) || [];
      const kinds = Craft()?.recentOpeningKinds?.(project, task, 3) || [];
      const hint = Craft()?.buildOpeningHint?.(kinds) || "";
      return [
        `【任务】${task?.id || ""} ${task?.chapter_title || chapter?.title || ""}`,
        `目标：${task?.goal || ""}`,
        `冲突：${task?.conflict || ""}`,
        `节拍：${(task?.beats || []).join(" → ")}`,
        `必须：${(task?.must_include || []).join("；") || "无"}`,
        `禁止：${(task?.must_not || []).join("；") || "无"}`,
        `章末钩子：${task?.hook_end || ""}`,
        `视角：${task?.pov || ""}`,
        prev ? `【上章】${prev.title || ""}\n${String(prev.body || "").slice(-900)}` : "【上章】无",
        chapter?.body?.trim()
          ? `【本章已写文末·不要重写】\n${String(chapter.body).slice(-1200)}\n请只规划从这里往后的 2–3 个场面，完成任务剩余部分。`
          : "【本章尚空】规划完整 2–5 个场面。",
        loops.length ? `【开放钩子】${loops.map((x) => `[${x.id}] ${x.summary}`).join("；")}` : "",
        hint,
        project.tone ? `【文风】${project.tone}` : "",
        (() => {
          const pace = Craft()?.applyPaceToTask?.(task, project);
          return pace
            ? `【节奏】${pace.label}；目标约 ${pace.wordTarget} 字；场面 ${pace.scenesMin}–${pace.scenesMax} 个`
            : "";
        })(),
      ]
        .filter(Boolean)
        .join("\n");
    }
  
    async function planChapterBeat(project, cfg, task, hooks = {}) {
      const ch = ensureChapterForTask(project, task);
      if (cfg.chapterBeatEnabled === false) return ch.beatPlan || null;
      const pace = Craft()?.applyPaceToTask?.(task, project);
      const sig = `${task?.id || ""}:${textSignature(task?.goal || "")}:${textSignature(ch.body || "")}:${pace?.id || ""}`;
      if (ch.beatPlanLocked && ch.beatPlan && !hooks.forceBeat) return ch.beatPlan;
      if (ch.beatPlan && ch.beatPlanSig === sig && !hooks.forceBeat) return ch.beatPlan;
      const pr = P().chapterBeat;
      if (!pr || typeof API().chatJson !== "function") return null;
      hooks.onStatus?.("planning");
      try {
        const json = await API().chatJson({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          signal: hooks.signal,
          diagnosticStage: "plan-beats",
          messages: [
            { role: "system", content: P().commonGuard + "\n" + pr.system },
            { role: "user", content: pr.user(buildBeatPlanPrompt(project, task, ch)) },
          ],
        });
        const plan = Craft()?.normalizeBeatPlan?.(json) || json;
        ch.beatPlan = plan;
        ch.beatPlanSig = sig;
        ch.beatPlanAt = Date.now();
        task.beatPlan = plan;
        log(project, `本章细纲 ${task.id} 场面=${(plan.scenes || []).length}`);
        return plan;
      } catch (e) {
        log(project, `本章细纲失败: ${e.message || e}`);
        if (cfg.chapterBeatPolicy === "strict") {
          task.lastError = e.message || String(e);
          task.lastErrorStage = "planning";
          throw e;
        }
        return ch.beatPlan || null;
      }
    }
  
    async function writeOneChapter(project, cfg, task, hooks = {}) {
      const { signal, onDelta, instruction, forceRewrite, forceContinue, ragPack } = hooks;
      const ch = ensureChapterForTask(project, task);
      // 已写完正文的阶段禁止再生成，避免自动重入叠章；续写用 forceContinue 追加。
      if (!forceRewrite && !forceContinue && ["written", "digested", "done"].includes(task.status)) {
        log(project, `跳过写章 ${task.id}（状态 ${task.status}）`);
        return ch;
      }
  
      ChapterState().markWriting(ch, task);
  
      // 写前：若有摘要但 storyState 空，先从 memory 重建，保证模型「读到进度」
      if (
        (!project.storyState || !project.storyState.establishedFacts?.length) &&
        (project.memoryRoll || []).length &&
        typeof C().rebuildStoryStateFromMemory === "function"
      ) {
        C().rebuildStoryStateFromMemory(project);
      }
  
      const packed = C().packForWrite(project, task, {
        instruction:
          instruction ||
          (ch.body?.trim()
            ? "请续写至完成本章任务与章末钩子，不要重复已写内容，不要重述上章已完成的高潮。"
            : "请先承接【故事线位置】【本章细纲】【RAG检索】【上章衔接】与【细节设定】，再按场次撰写；禁止把上章事件重写一遍，禁止改写已锁定数字。"),
        wordTarget: task.word_target || Defaults()?.chapterTargetWords || 2000,
        budget: cfg.contextBudgetChars || Defaults()?.contextBudgetChars,
        tokenBudget: cfg.contextBudgetTokens || Defaults()?.contextBudgetTokens,
        bodyTailChars: cfg.bodyTailChars || Defaults()?.bodyTailChars,
        prevChapterTailChars: cfg.prevChapterTailChars || Defaults()?.prevChapterTailChars,
        memoryDepth: cfg.memoryDepth || Defaults()?.memoryDepth,
        ragPack: ragPack || null,
        ragTopK: cfg.ragTopK,
        ragMaxChars: cfg.ragMaxChars,
        autoRag: cfg.ragEnabled !== false,
        beatPlan: hooks.beatPlan || ch.beatPlan || task.beatPlan,
      });
      C().recordContextManifest?.(project, task, ch, packed);
  
      log(
        project,
        `写章上下文 ${task.id} chars=${packed.meta.chars}/${packed.meta.budget} blocks=${(packed.meta.used || []).join("+")}${
          packed.meta.prevChapterId ? " +prev" : ""
        }${ragPack ? ` +rag${ragPack.hits?.length || 0}` : ""}`
      );
  
      const sys = P().writeChapter.system({
        wordTarget: packed.meta.wordTarget,
        tone: project.tone || "",
      });
  
      const startLen = ch.body?.length || 0;
      const prefix = ch.body || "";
      const sep = startLen > 0 && !prefix.endsWith("\n") ? "\n" : "";
  
      try {
        const { content } = await API().chat({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          outputTokens:
            cfg.outputReserveTokens || Defaults()?.outputReserveTokens || 3500,
          signal,
          diagnosticStage: "legacy-writing",
          stream: true,
          messages: [
            { role: "system", content: P().commonGuard + "\n" + sys },
            { role: "user", content: packed.user },
          ],
          onDelta: (delta, full) => {
            ch.body = prefix + sep + full;
            ch.updatedAt = Date.now();
            onDelta?.(delta, ch.body, ch.id);
          },
        });
  
        ch.body = prefix + sep + content;
        ch.updatedAt = Date.now();
        const lint = applyCraftSignals(project, task, ch, content || ch.body);
        if (cfg.proseLintEnabled !== false && lint.length && typeof C().mergeContinuityIssues === "function") {
          C().mergeContinuityIssues(
            project,
            { continuity_warnings: lint },
            { chapter: ch.title, taskId: task.id, order: ch.order || task.order }
          );
          log(project, `文风检查 ${task.id} 记 ${lint.length} 条`);
        }
        ChapterState().markWritten(ch, task);
        log(project, `写完任务 ${task.id}《${ch.title}》 ${content.length}字`);
        return ch;
      } catch (e) {
        task.lastError = e.message || String(e);
        task.lastErrorStage = "writing";
        // 保留 partial body；回到 pending 以便识别为未完成（有正文时可续）
        if (task.status === "writing") {
          ChapterState().markPaused(ch, task, { reason: "写章中断，已保留最后一次提交的正文" });
        }
        throw e;
      }
    }
  
    async function autoChapterCycle(project, cfg, task, hooks = {}) {
      await recoverStaleHandoffs(project, cfg, task, hooks);
      // 新版生产编排器：未完成任务走“章节契约→分场→语义验收”状态机。
      // written/digested 旧状态仍由下方兼容路径补交接，避免重复追加正文。
      const productionEngine = ProductionEngine();
      const taskState = String(task?.status || "pending");
      const shouldProduce = hooks.forceRewrite || hooks.production === true || !["written", "digested", "done"].includes(taskState);
      // 明确关闭“写前本章细纲”时保留旧 Harness 作为兼容档：旧书/低额度服务
      // 仍可选择一次性写章，但默认 chapterBeatEnabled=true 继续走新生产引擎。
      // hooks.production 可供迁移脚本显式要求新引擎，不受兼容开关影响。
      const legacyBeatCompatibility = cfg.chapterBeatEnabled === false && hooks.production !== true && !hooks.forceRewrite;
      if (
        productionEngine &&
        typeof productionEngine.runChapter === "function" &&
        cfg.productionEngineEnabled !== false &&
        !legacyBeatCompatibility &&
        shouldProduce
      ) {
        try {
          return await productionEngine.runChapter(project, cfg, task, hooks);
        } catch (e) {
          log(project, `生产编排器中断 ${task.id} @${task.lastErrorStage || "production"} : ${e.message || e}`);
          throw e;
        }
      }
      // 默认走 Harness：Retrieve → Write → Handoff → Reindex
      if (Harness() && typeof Harness().runChapterHarness === "function" && cfg.harnessEnabled !== false) {
        try {
          return await Harness().runChapterHarness(project, cfg, task, hooks);
        } catch (e) {
          log(project, `章循环中断 ${task.id} @${task.lastErrorStage || "harness"} : ${e.message || e}`);
          throw e;
        }
      }
  
      const ch = ensureChapterForTask(project, task);
      try {
        if (task.status === "done" && ch.body?.trim() && !hooks.force && !hooks.forceRewrite) {
          hooks.onStatus?.("skip-done");
          log(project, `跳过已完成任务 ${task.id}`);
          return ch;
        }
  
        const st = task.status || "pending";
        if (hooks.forceRewrite || !["written", "digested", "done"].includes(st)) {
          // 无 harness 时仍尽量预检索
          if (Rag() && cfg.ragEnabled !== false) {
            try {
              hooks.onStatus?.("retrieve");
              const ragPack = await Rag().retrieveHybrid(project, task, cfg, {
                signal: hooks.signal,
              });
              hooks.ragPack = ragPack;
            } catch (e) {
              log(project, `RAG 检索失败: ${e.message || e}`);
              if (
                cfg.ragFailurePolicy === "strict" &&
                Harness()?.hasPriorWrittenStory?.(project, task)
              ) {
                task.lastError = e.message || String(e);
                task.lastErrorStage = "retrieve";
                throw e;
              }
              hooks.onStatus?.("retrieve-warning");
            }
          }
          if (cfg.chapterBeatEnabled !== false) {
            try {
              await planChapterBeat(project, cfg, task, hooks);
            } catch (e) {
              if (cfg.chapterBeatPolicy === "strict") throw e;
            }
          }
          hooks.onStatus?.("writing");
          await writeOneChapter(project, cfg, task, hooks);
        } else {
          log(project, `续跑 ${task.id}：跳过写章（${st}）`);
        }
  
        if (task.status === "written") {
          if (cfg.continuityReviewEnabled === true) {
            hooks.onStatus?.("reviewing");
            try {
              await reviewAndRepairChapter(project, cfg, ch, task, hooks);
            } catch (e) {
              task.lastError = e.message || String(e);
              task.lastErrorStage = "review";
              ChapterState().markHandoffStale(ch, task, { reason: e.message || String(e) });
              throw e;
            }
          }
          hooks.onStatus?.("digesting");
          try {
            await digestChapter(project, cfg, ch, task, hooks);
          } catch (e) {
            task.lastError = e.message || String(e);
            task.lastErrorStage = "digest";
            ChapterState().markHandoffStale(ch, task, { reason: e.message || String(e) });
            throw e;
          }
        }
  
        if (task.status === "digested") {
          hooks.onStatus?.("graphing");
          await extractGraphDelta(project, cfg, ch, hooks);
          ChapterState().completeHandoff(ch, task);
          try {
            Rag()?.ensureIndex(project, true);
          } catch (_) {}
        }
  
        hooks.onStatus?.("done");
        return ch;
      } catch (e) {
        log(project, `章循环中断 ${task.id} @${task.lastErrorStage || "?"} : ${e.message || e}`);
        throw e;
      }
    }
  
    async function authorSteer(project, cfg, note, { signal } = {}) {
      const pr = P().authorSteer;
      const ctx = `【当前锁定主线】${project.locks.logline || project.spine?.logline}
  【禁区】${(project.locks.forbidden || []).join("；")}
  【任务板摘要】${(project.tasks || [])
    .slice(0, 15)
    .map((t) => `${t.id} ${t.status} ${t.chapter_title}:${t.goal}`)
    .join("\n")}
  【已写章节数】${(project.chapters || []).filter((c) => c.body?.trim()).length}
  【作者批注】${note}`;
  
      const json = await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal,
        diagnosticStage: "author-steer",
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          { role: "user", content: pr.user(ctx) },
        ],
      });
  
      if (json.logline) {
        project.locks.logline = json.logline;
        if (project.spine) project.spine.logline = json.logline;
      }
      if (Array.isArray(json.new_forbidden)) {
        project.locks.forbidden = [...new Set([...(project.locks.forbidden || []), ...json.new_forbidden])];
      }
      if (Array.isArray(json.patch_tasks)) {
        for (const patch of json.patch_tasks) {
          const t = project.tasks.find((x) => x.id === patch.id);
          if (t && patch.field) t[patch.field] = patch.value;
        }
      }
      log(project, `作者纠偏：${json.editor_note || "已应用"}`);
      return json;
    }
  
    /**
     * Composer 续写与自动连写共用的质量闭环。
     * 已有正文则追加；可选章后交接。
     */
    async function continueChapter(project, cfg, task, hooks = {}) {
      await recoverStaleHandoffs(project, cfg, task, hooks);
      const ch = ensureChapterForTask(project, task);
      let ragPack = hooks.ragPack || null;
      if (!ragPack && cfg.ragEnabled !== false && Harness()?.prepareAndRetrieve) {
        hooks.onStatus?.("retrieve");
        try {
          const retrieveTask = {
            ...task,
            must_include: [...(task.must_include || []), hooks.instruction || ""].filter(Boolean),
          };
          ragPack = (await Harness().prepareAndRetrieve(project, cfg, retrieveTask, hooks))?.ragPack;
        } catch (e) {
          log(project, `续写检索失败: ${e.message || e}`);
          const strictBlocked =
            cfg.ragFailurePolicy === "strict" && Harness().hasPriorWrittenStory?.(project, task);
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
            e.code = e.code || "RAG_REQUIRED";
            hooks.onStatus?.("retrieve-blocked");
            throw e;
          }
          hooks.onStatus?.("retrieve-warning");
        }
      }
      if (cfg.chapterBeatEnabled !== false) {
        try {
          hooks.onStatus?.("planning");
          await planChapterBeat(project, cfg, task, hooks);
        } catch (e) {
          if (cfg.chapterBeatPolicy === "strict") throw e;
        }
      }
      hooks.onStatus?.("writing");
      await writeOneChapter(project, cfg, task, {
        ...hooks,
        ragPack,
        forceContinue: true,
      });
      if (hooks.handoff === false) return ch;
      if (cfg.manualAutoHandoff === false && hooks.handoff !== true) {
        ChapterState().markHandoffStale(ch, task, { reason: "正文已生成，等待手工章后交接" });
        return ch;
      }
      await handoffChapter(project, cfg, ch, task, hooks);
      return ch;
    }
  
    function applyCraftSignals(project, task, chapter, openingSource) {
      const craft = Craft();
      if (!craft || !chapter) return [];
      const body = String(chapter.body || "");
      const increment = openingSource == null ? body : String(openingSource);
      const prefixEmpty = !body.trim() || increment === body;
      if (typeof craft.scoreChapterCraft === "function") {
        const prev = C().findPrevWrittenChapter?.(project, task);
        chapter.craftScore = craft.scoreChapterCraft(body, chapter.beatPlan || task?.beatPlan, {
          prevBody: prev?.body || "",
          recentKinds: craft.recentOpeningKinds?.(project, task, 3) || [],
          styleBible: project?.styleBible,
        });
        if (!chapter.openingKind || prefixEmpty) {
          chapter.openingKind = chapter.craftScore.openingKind;
        }
        return chapter.craftScore.issues || [];
      }
      if (craft.detectOpeningKind && (!chapter.openingKind || prefixEmpty)) {
        chapter.openingKind = craft.detectOpeningKind(prefixEmpty ? increment || body : body);
      }
      return [];
    }
  
    function markChapterRevised(chapter, task, project, nextBody, kind, note) {
      chapter.revisionHistory = Array.isArray(chapter.revisionHistory) ? chapter.revisionHistory : [];
      chapter.revisionHistory.push({
        at: Date.now(),
        kind,
        note: note || "",
        body: chapter.body || "",
      });
      if (chapter.revisionHistory.length > 3) chapter.revisionHistory = chapter.revisionHistory.slice(-3);
      chapter.body = nextBody;
      chapter.updatedAt = Date.now();
      ProductionState().invalidateAfterBodyEdit(chapter, {
        task,
        reason: kind === "rewrite" ? "正文重写后尚未重新交接" : "根据作者批注修订后等待重新交接",
      });
      const lint = applyCraftSignals(project, task, chapter, nextBody);
      if (lint.length && typeof C().mergeContinuityIssues === "function") {
        C().mergeContinuityIssues(project, { continuity_warnings: lint }, {
          chapter: chapter.title,
          taskId: task?.id,
          order: chapter.order || task?.order,
        });
      }
      return chapter;
    }
  
    async function rewritePassage(project, cfg, task, chapter, hooks = {}) {
      const selection = String(hooks.selection || "");
      if (!selection.trim()) throw new Error("没有可重写的选段");
      const before = String(hooks.before || "");
      const after = String(hooks.after || "");
      const packed = C().packForWrite(project, task, {
        instruction: `请按作者要求重写选段，只输出重写后的段落正文。\n作者要求：${hooks.instruction || ""}\n选段：\n${selection}`,
        beatPlan: chapter?.beatPlan || task?.beatPlan,
      });
      let acc = "";
      const result = await API().chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        signal: hooks.signal,
        diagnosticStage: "selection-rewrite",
        stream: true,
        messages: [
          {
            role: "system",
            content: P().commonGuard + "\n只输出重写后的段落，不要解释。遵守锁定主线、细节设定与人物声线。",
          },
          { role: "user", content: packed.user },
        ],
        onDelta: (_d, full) => {
          acc = full;
        },
      });
      acc = String(result?.content || acc || "").trim();
      if (!acc) {
        const err = new Error("模型没有返回可用的重写段落");
        err.code = "REVISION_FAILED";
        throw err;
      }
      markChapterRevised(chapter, task, project, before + acc + after, "rewrite", hooks.instruction);
      return maybeHandoffAfterRevision(project, cfg, task, chapter, hooks);
    }
  
    async function reviseChapter(project, cfg, task, chapter, hooks = {}) {
      const originalBody = String(hooks.originalBody || chapter.body || "");
      const annotation = String(hooks.annotation || "").trim();
      if (!originalBody.trim()) throw new Error("请先选择一章有正文的章节");
      if (!annotation) throw new Error("请先写下本轮批注");
      const packed = C().packForWrite(project, task, {
        instruction: `根据作者批注修订整章；未被批注涉及的剧情、事实与声线保持不变。作者批注：${annotation}`,
        beatPlan: chapter?.beatPlan || task?.beatPlan,
      });
      let revised = "";
      const result = await API().chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        outputTokens: cfg.outputReserveTokens || Defaults()?.outputReserveTokens || 3500,
        signal: hooks.signal,
        diagnosticStage: "revision",
        stream: true,
        messages: [
          {
            role: "system",
            content:
              P().commonGuard +
              "\n你是长篇小说责任编辑。严格按作者批注修订当前章节，保留未涉及部分、锁定事实与既有叙事声线。只输出修订后的完整章节正文，不要解释、标题或 Markdown 围栏。",
          },
          {
            role: "user",
            content: `${packed.user}\n\n【作者批注】\n${annotation}\n\n【待修订完整原稿】\n${originalBody}`,
          },
        ],
        onDelta: (_delta, full) => {
          // 修订类操作采用成功后提交：流式半稿绝不覆盖作者原文。
          revised = full;
        },
      });
      revised = String(result?.content || revised || "").trim();
      if (!revised) {
        const err = new Error("模型没有返回可用的修订正文");
        err.code = "REVISION_FAILED";
        throw err;
      }
      const revision = { kind: "author-annotation", note: annotation };
      markChapterRevised(chapter, task, project, revised, revision.kind, revision.note);
      return maybeHandoffAfterRevision(project, cfg, task, chapter, hooks);
    }

    return {
      ensureChapterForTask,
      buildBeatPlanPrompt,
      planChapterBeat,
      writeOneChapter,
      autoChapterCycle,
      authorSteer,
      continueChapter,
      applyCraftSignals,
      markChapterRevised,
      rewritePassage,
      reviseChapter,
    };
  }

  return { create };
})();
