/** 全自动策划 + 短上下文写章流水线 */
window.NOVEL_PIPELINE = (() => {
  const P = () => window.NOVEL_PROMPTS;
  const C = () => window.NOVEL_CONTEXT;
  const API = () => window.NOVEL_API;
  const STALE_HANDOFF_LIMIT = 3;

  function log(project, msg) {
    project.pipelineLog = project.pipelineLog || [];
    project.pipelineLog.push({ t: Date.now(), msg });
    if (project.pipelineLog.length > 200) project.pipelineLog.shift();
  }

  function textSignature(text) {
    const s = String(text || "");
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${s.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  async function runPitch(project, cfg, signal) {
    const pr = P().stagePitch;
    const json = await API().chatJson({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      signal,
      messages: [
        { role: "system", content: P().commonGuard + "\n" + pr.system },
        { role: "user", content: pr.user(project.ideaInput || "热门玄幻升级流") },
      ],
    });
    Object.assign(project, {
      title_candidates: json.title_candidates || [],
      pitch: json.pitch || "",
      genre: json.genre || "",
      sub_genre: json.sub_genre || "",
      hooks: json.hooks || [],
      tone: json.tone || "",
      styleBible:
        json.style_bible && typeof json.style_bible === "object"
          ? json.style_bible
          : {
              ...(project.styleBible || {}),
              pacing: project.styleBible?.pacing || json.tone || "",
            },
      audience: json.audience || "",
      risks: json.risks || [],
      title: (json.title_candidates && json.title_candidates[0]) || project.title,
      stage: "pitch",
    });
    log(project, "完成立项/卖点");
    return json;
  }

  async function runWorld(project, cfg, signal) {
    const pr = P().stageWorld;
    const json = await API().chatJson({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      signal,
      messages: [
        { role: "system", content: P().commonGuard + "\n" + pr.system },
        {
          role: "user",
          content: pr.user({
            pitch: project.pitch,
            genre: project.genre,
            hooks: project.hooks,
            tone: project.tone,
            authorNote: project.authorNote,
          }),
        },
      ],
    });
    project.world = json;
    project.stage = "world";
    if (project.locks.lockedFields?.includes("world") === false) {
      /* ok */
    }
    log(project, "完成世界观");
    return json;
  }

  async function runCast(project, cfg, signal) {
    const pr = P().stageCast;
    const json = await API().chatJson({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      signal,
      messages: [
        { role: "system", content: P().commonGuard + "\n" + pr.system },
        {
          role: "user",
          content: pr.user({
            pitch: project.pitch,
            genre: project.genre,
            sub_genre: project.sub_genre,
            world: project.world,
            authorCastNote: project.authorCastNote,
          }),
        },
      ],
    });
    project.graph = {
      nodes: json.nodes || [],
      edges: json.edges || [],
      stats: {
        characters: (json.nodes || []).length,
        relationships: (json.edges || []).length,
      },
    };
    project.cast_summary = json.cast_summary || "";
    project.stage = "cast";
    log(project, "完成人物与关系");
    return json;
  }

  async function runSpine(project, cfg, signal) {
    const pr = P().stageSpine;
    const n = project.targetChapters || 20;
    const json = await API().chatJson({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      signal,
      messages: [
        { role: "system", content: P().commonGuard + "\n" + pr.system },
        {
          role: "user",
          content: pr.user(
            {
              pitch: project.pitch,
              title_candidates: project.title_candidates,
              cast_summary: project.cast_summary,
              graph: project.graph,
              world: project.world,
              authorSpineLock: project.authorSpineLock || project.locks?.logline,
              authorForbidden: project.authorForbidden || (project.locks?.forbidden || []).join("；"),
            },
            n
          ),
        },
      ],
    });
    project.spine = {
      logline: json.logline || project.pitch,
      theme: json.theme || "",
      spine: json.spine || [],
      volumes: json.volumes || [],
      foreshadow: json.foreshadow || [],
    };
    // author lock defaults
    if (!project.locks.logline) project.locks.logline = project.spine.logline;
    const incoming = (json.tasks || []).map((t, i) => {
      const id = t.id || `t${String(i + 1).padStart(3, "0")}`;
      const order = t.order || i + 1;
      // 忽略模型胡写的 status/done，进度以本地为准
      const { status: _ignoreStatus, ...rest } = t;
      return {
        status: "pending",
        order,
        ...rest,
        id,
        order,
        status: "pending",
      };
    });
    project.tasks = mergeTasksPreservingProgress(project.tasks || [], incoming, project.chapters || []);
    project.stage = "spine";
    log(project, `完成主线与 ${project.tasks.length} 个章任务（已保留本地进度）`);
    return json;
  }

  /**
   * 合并任务板：已 done/written/digested 的本地任务优先保留，避免重跑策划炸进度。
   * 无进度的 pending 可被同 id/order 的新规划覆盖文案。
   */
  function mergeTasksPreservingProgress(existing, incoming, chapters) {
    const chByTask = new Map();
    for (const c of chapters || []) {
      if (c.taskId) chByTask.set(c.taskId, c);
    }
    const oldById = new Map((existing || []).map((t) => [t.id, t]));
    const oldByOrder = new Map((existing || []).map((t) => [Number(t.order) || 0, t]));
    const usedOld = new Set();
    const result = [];

    function isProgressed(t) {
      if (!t) return false;
      const st = t.status || "pending";
      if (["done", "written", "digested", "writing"].includes(st)) return true;
      const ch = chByTask.get(t.id);
      return !!(ch && String(ch.body || "").trim());
    }

    for (const neu of incoming || []) {
      const old = oldById.get(neu.id) || oldByOrder.get(Number(neu.order) || 0);
      if (old && isProgressed(old)) {
        usedOld.add(old.id);
        result.push({
          ...neu,
          ...old,
          // 保留进度字段
          id: old.id,
          status: old.status,
          order: old.order || neu.order,
          lastError: old.lastError,
          lastErrorStage: old.lastErrorStage,
          // 无正文进度时才允许用新标题/目标（已有进度则只补空字段）
          chapter_title: old.chapter_title || neu.chapter_title,
          goal: old.goal || neu.goal,
          conflict: old.conflict || neu.conflict,
          beats: old.beats?.length ? old.beats : neu.beats,
          must_include: old.must_include?.length ? old.must_include : neu.must_include,
          must_not: old.must_not?.length ? old.must_not : neu.must_not,
          hook_end: old.hook_end || neu.hook_end,
        });
      } else {
        if (old) usedOld.add(old.id);
        result.push({ ...neu, status: "pending" });
      }
    }
    // 本地有进度但不在新规划里的任务：追加保留，避免丢章
    for (const old of existing || []) {
      if (usedOld.has(old.id)) continue;
      if (isProgressed(old)) result.push(old);
    }
    result.sort((a, b) => (a.order || 0) - (b.order || 0));
    return result;
  }

  /** 一键策划到 spine（中途可被 abort） */
  async function runFullPlan(project, cfg, { signal, onStep } = {}) {
    const steps = [
      ["pitch", runPitch],
      ["world", runWorld],
      ["cast", runCast],
      ["spine", runSpine],
    ];
    for (const [name, fn] of steps) {
      onStep?.(name, "start");
      // skip if locked and already has data
      if (name === "world" && project.locks.lockedFields?.includes("world") && project.world) {
        onStep?.(name, "skip-locked");
        continue;
      }
      if (name === "cast" && project.locks.lockedFields?.includes("cast") && project.graph?.nodes?.length) {
        onStep?.(name, "skip-locked");
        continue;
      }
      if (name === "spine" && project.locks.lockedFields?.includes("logline") && project.tasks?.length) {
        // still allow refresh tasks? skip full if locked spine
        if (project.locks.lockedFields.includes("spine")) {
          onStep?.(name, "skip-locked");
          continue;
        }
      }
      await fn(project, cfg, signal);
      onStep?.(name, "done");
    }
    project.stage = "ready";
    log(project, "策划流水线完成，等待作者确认主线后可自动写章");
  }

  function ensureChapterForTask(project, task) {
    let ch = project.chapters.find((c) => c.taskId === task.id);
    if (!ch) {
      ch = {
        id: window.NOVEL_STORE.uid(),
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
    const kinds = window.NOVEL_CRAFT?.recentOpeningKinds?.(project, task, 3) || [];
    const hint = window.NOVEL_CRAFT?.buildOpeningHint?.(kinds) || "";
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
        const pace = window.NOVEL_CRAFT?.applyPaceToTask?.(task, project);
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
    const pace = window.NOVEL_CRAFT?.applyPaceToTask?.(task, project);
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
        signal: hooks.signal,
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          { role: "user", content: pr.user(buildBeatPlanPrompt(project, task, ch)) },
        ],
      });
      const plan = window.NOVEL_CRAFT?.normalizeBeatPlan?.(json) || json;
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

    task.status = "writing";
    task.lastError = "";
    task.lastErrorStage = "";

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
      wordTarget: task.word_target || window.NOVEL_DEFAULTS?.chapterTargetWords || 2000,
      budget: cfg.contextBudgetChars || window.NOVEL_DEFAULTS?.contextBudgetChars,
      tokenBudget: cfg.contextBudgetTokens || window.NOVEL_DEFAULTS?.contextBudgetTokens,
      bodyTailChars: cfg.bodyTailChars || window.NOVEL_DEFAULTS?.bodyTailChars,
      prevChapterTailChars: cfg.prevChapterTailChars || window.NOVEL_DEFAULTS?.prevChapterTailChars,
      memoryDepth: cfg.memoryDepth || window.NOVEL_DEFAULTS?.memoryDepth,
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
        outputTokens:
          cfg.outputReserveTokens || window.NOVEL_DEFAULTS?.outputReserveTokens || 3500,
        signal,
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
      task.status = "written";
      log(project, `写完任务 ${task.id}《${ch.title}》 ${content.length}字`);
      return ch;
    } catch (e) {
      task.lastError = e.message || String(e);
      task.lastErrorStage = "writing";
      // 保留 partial body；回到 pending 以便识别为未完成（有正文时可续）
      if (task.status === "writing") task.status = ch.body?.trim() ? "pending" : "pending";
      throw e;
    }
  }

  async function digestChapter(project, cfg, chapter, task, { signal } = {}) {
    const pr = P().chapterDigest;
    const pack = C().packForDigest(project, chapter, task);
    const json = await API().chatJson({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      signal,
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
      abandoned_loops: Array.isArray(json.abandoned_loops) ? json.abandoned_loops : [],
      appeared: json.appeared && typeof json.appeared === "object" ? json.appeared : {},
      taskId: task?.id || chapter.taskId || "",
      order: chapter.order || task?.order || 0,
    };
    if (window.NOVEL_CRAFT?.validateDigest) {
      const gated = window.NOVEL_CRAFT.validateDigest(project, normalized, chapter.body, C());
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
      if (window.NOVEL_CRAFT?.validateDigest && extraFacts.length) {
        const gatedExtras = window.NOVEL_CRAFT.validateDigest(
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

    task.status = "digested";
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
        signal,
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
    if (!hooks.force && chapter.continuityReview?.bodySig === sig && chapter.continuityReview?.status) {
      return chapter.continuityReview;
    }
    const pr = P().continuityReview;
    if (!pr) return { status: "skipped", bodySig: sig, issues: [] };
    const pack = C().packForContinuityReview(project, chapter, task, {
      prevChapterTailChars: cfg.prevChapterTailChars,
      budget: Math.min(18000, cfg.contextBudgetChars || 16000),
      tokenBudget: Math.min(13000, cfg.contextBudgetTokens || 12000),
    });
    hooks.onStatus?.("reviewing");
    try {
      const json = await API().chatJson({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        signal: hooks.signal,
        messages: [
          { role: "system", content: P().commonGuard + "\n" + pr.system },
          { role: "user", content: pr.user(pack.user) },
        ],
      });
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
      signal: hooks.signal,
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
      chapter.handoffStatus = "stale";
      chapter.handoffError = "连续性修订后等待复检与交接";
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
    if (cfg.continuityReviewPolicy === "strict" && finalReview.status === "fail") {
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
    if (!chapter?.body?.trim()) throw new Error("本章无正文，不能执行章后交接");
    chapter.handoffStatus = "running";
    chapter.handoffError = "";
    try {
      if (!task.status || !["written", "digested", "done"].includes(task.status)) task.status = "written";
      await reviewAndRepairChapter(project, cfg, chapter, task, hooks);
      hooks.onStatus?.("digesting");
      const digest = await digestChapter(project, cfg, chapter, task, hooks);
      hooks.onStatus?.("graphing");
      await extractGraphDelta(project, cfg, chapter, hooks);
      task.status = "done";
      task.lastError = "";
      task.lastErrorStage = "";
      chapter.handoffStatus = "done";
      chapter.handoffAt = Date.now();
      chapter.handoffError = "";
      hooks.onStatus?.("index");
      try {
        window.NOVEL_RAG?.ensureIndex(project, true);
      } catch (e) {
        log(project, `章后索引更新失败: ${e.message || e}`);
      }
      hooks.onStatus?.("done");
      return digest;
    } catch (e) {
      chapter.handoffStatus = "stale";
      chapter.handoffError = e.message || String(e);
      task.lastError = e.message || String(e);
      task.lastErrorStage = task.lastErrorStage || "digest";
      throw e;
    }
  }

  /**
   * 自动：写一章 + 摘要 + 关系。
   * 状态机：pending → writing → written → digested → done
   * 重入时：written 只补摘要/关系，digested 只补关系，避免叠正文。
   */
  async function autoChapterCycle(project, cfg, task, hooks = {}) {
    await recoverStaleHandoffs(project, cfg, task, hooks);
    // 默认走 Harness：Retrieve → Write → Handoff → Reindex
    if (window.NOVEL_HARNESS && typeof window.NOVEL_HARNESS.runChapterHarness === "function" && cfg.harnessEnabled !== false) {
      try {
        return await window.NOVEL_HARNESS.runChapterHarness(project, cfg, task, hooks);
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
        if (window.NOVEL_RAG && cfg.ragEnabled !== false) {
          try {
            hooks.onStatus?.("retrieve");
            const ragPack = await window.NOVEL_RAG.retrieveHybrid(project, task, cfg, {
              signal: hooks.signal,
            });
            hooks.ragPack = ragPack;
          } catch (e) {
            log(project, `RAG 检索失败: ${e.message || e}`);
            if (
              cfg.ragFailurePolicy === "strict" &&
              window.NOVEL_HARNESS?.hasPriorWrittenStory?.(project, task)
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
            ch.handoffStatus = "stale";
            ch.handoffError = e.message || String(e);
            throw e;
          }
        }
        hooks.onStatus?.("digesting");
        try {
          await digestChapter(project, cfg, ch, task, hooks);
        } catch (e) {
          task.lastError = e.message || String(e);
          task.lastErrorStage = "digest";
          ch.handoffStatus = "stale";
          ch.handoffError = e.message || String(e);
          throw e;
        }
      }

      if (task.status === "digested") {
        hooks.onStatus?.("graphing");
        await extractGraphDelta(project, cfg, ch, hooks);
        task.status = "done";
        task.lastError = "";
        task.lastErrorStage = "";
        ch.handoffStatus = "done";
        ch.handoffAt = Date.now();
        ch.handoffError = "";
        try {
          window.NOVEL_RAG?.ensureIndex(project, true);
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
      signal,
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
    if (!ragPack && cfg.ragEnabled !== false && window.NOVEL_HARNESS?.prepareAndRetrieve) {
      hooks.onStatus?.("retrieve");
      try {
        const retrieveTask = {
          ...task,
          must_include: [...(task.must_include || []), hooks.instruction || ""].filter(Boolean),
        };
        ragPack = (await window.NOVEL_HARNESS.prepareAndRetrieve(project, cfg, retrieveTask, hooks))?.ragPack;
      } catch (e) {
        log(project, `续写检索失败: ${e.message || e}`);
        const strictBlocked =
          cfg.ragFailurePolicy === "strict" && window.NOVEL_HARNESS.hasPriorWrittenStory?.(project, task);
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
      ch.handoffStatus = "stale";
      return ch;
    }
    await handoffChapter(project, cfg, ch, task, hooks);
    return ch;
  }

  function applyCraftSignals(project, task, chapter, openingSource) {
    const Craft = window.NOVEL_CRAFT;
    if (!Craft || !chapter) return [];
    const body = String(chapter.body || "");
    const increment = openingSource == null ? body : String(openingSource);
    const prefixEmpty = !body.trim() || increment === body;
    if (typeof Craft.scoreChapterCraft === "function") {
      const prev = C().findPrevWrittenChapter?.(project, task);
      chapter.craftScore = Craft.scoreChapterCraft(body, chapter.beatPlan || task?.beatPlan, {
        prevBody: prev?.body || "",
        recentKinds: Craft.recentOpeningKinds?.(project, task, 3) || [],
        styleBible: project?.styleBible,
      });
      if (!chapter.openingKind || prefixEmpty) {
        chapter.openingKind = chapter.craftScore.openingKind;
      }
      return chapter.craftScore.issues || [];
    }
    if (Craft.detectOpeningKind && (!chapter.openingKind || prefixEmpty)) {
      chapter.openingKind = Craft.detectOpeningKind(prefixEmpty ? increment || body : body);
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
    chapter.handoffStatus = "stale";
    chapter.handoffError = kind === "rewrite" ? "正文重写后尚未重新交接" : "根据作者批注修订后等待重新交接";
    if (task && ["done", "digested"].includes(task.status)) task.status = "written";
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
      signal: hooks.signal,
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
      outputTokens: cfg.outputReserveTokens || window.NOVEL_DEFAULTS?.outputReserveTokens || 3500,
      signal: hooks.signal,
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
    runPitch,
    runWorld,
    runCast,
    runSpine,
    runFullPlan,
    mergeTasksPreservingProgress,
    writeOneChapter,
    planChapterBeat,
    digestChapter,
    extractGraphDelta,
    reviewChapterContinuity,
    repairChapterContinuity,
    reviewAndRepairChapter,
    repairableIssues,
    handoffChapter,
    autoChapterCycle,
    continueChapter,
    rewritePassage,
    reviseChapter,
    recoverStaleHandoffs,
    pendingHandoffChapters,
    applyCraftSignals,
    authorSteer,
    ensureChapterForTask,
    log,
    textSignature,
  };
})();
