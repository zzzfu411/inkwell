/**
 * Inkwell Narrative Production Engine v1
 *
 * 这是写章质量链路的编排层，不是另一个提示词集合：
 *   Chapter Contract → Scene Contracts → Coherent Chapter Draft → Semantic Critic
 *   → bounded Revision → Quality Gate → Handoff
 *
 * 旧版 pipeline/harness 仍保留。生产引擎只在 productionEngineEnabled 开启且
 * 任务尚未完成时接管，旧书可以安全回退。默认以一次模型调用消费完整场面契约，
 * scene 模式仅作兼容。模块不碰 DOM，所有中间状态都写进
 * chapter.production，因而可恢复、可审计、可在离线测试中验证。
 */
window.NOVEL_PRODUCTION_ENGINE = (() => {
  "use strict";

  const VERSION = 1;
  const MIN_SCENES = 2;
  const MAX_SCENES = 5;
  function ChapterState() {
    const state = window.NOVEL_CHAPTER_STATE;
    if (!state) throw new Error("NOVEL_CHAPTER_STATE 未在 production-engine.js 前加载");
    return state;
  }

  function clamp(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function text(value) {
    return String(value ?? "").trim();
  }

  function list(value, limit = 12) {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return source
      .map((item) => (typeof item === "string" ? item : item?.summary || item?.text || item?.value || ""))
      .map(text)
      .filter(Boolean)
      .slice(0, limit);
  }

  function unique(items) {
    return [...new Set((items || []).map(text).filter(Boolean))];
  }

  function hash(value) {
    // FNV-1a，足够用于本地运行签名，不冒充密码学 hash。
    let h = 0x811c9dc5;
    const source = String(value || "");
    for (let i = 0; i < source.length; i++) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function bodySignature(value) {
    const shared = window.NOVEL_PRODUCTION_STATE?.bodySignature;
    if (typeof shared === "function") return shared(value);
    return `body_${hash(value || "")}`;
  }

  function log(project, message) {
    try {
      window.NOVEL_PIPELINE?.log?.(project, `[production] ${message}`);
    } catch (_) {
      // 日志不能让生成链路失败。
    }
  }

  function previousChapter(project, task) {
    return window.NOVEL_CONTEXT?.findPrevWrittenChapter?.(project, task) || null;
  }

  function targetFor(task, cfg, raw) {
    return Math.max(
      500,
      Number(raw?.word_target || raw?.wordTarget || task?.word_target) ||
        Number(cfg?.chapterTargetWords) ||
        Number(window.NOVEL_DEFAULTS?.chapterTargetWords) ||
        2000
    );
  }

  function normalizeScene(raw, index, target, fallbackPov, fallbackConflict = "") {
    const source = raw && typeof raw === "object" ? raw : {};
    const sceneTarget = Math.max(
      220,
      Number(source.word_target || source.wordTarget || source.target_words) ||
        Math.round(target / Math.max(MIN_SCENES, 3))
    );
    const action = text(source.action || source.what || source.event || source.goal);
    const goal = text(source.goal || source.objective || action);
    const obstacle = text(source.obstacle || source.resistance || source.conflict || fallbackConflict);
    const turn = text(source.turn || source.shift || source.reversal);
    const outcome = text(source.outcome || source.result || source.exit || turn);
    return {
      id: text(source.id) || `s${index + 1}`,
      index,
      purpose: text(source.purpose || source.function || (index === 0 ? "承接并建立本章目标" : "推进因果并改变处境")),
      location: text(source.location || source.place || source.setting),
      pov: text(source.pov || fallbackPov),
      goal,
      obstacle,
      action,
      turn,
      outcome,
      sensory: text(source.sensory || source.sense || source.anchor),
      wordTarget: sceneTarget,
      status: "pending",
      text: "",
    };
  }

  function fallbackScenes(task, target) {
    const pov = text(task?.pov || task?.viewpoint);
    const conflict = text(task?.conflict);
    const beats = list(task?.beats, 4);
    const scenes = [];
    if (beats.length >= 2) {
      beats.slice(0, 4).forEach((beat, index) => {
        scenes.push(
          normalizeScene(
            {
              id: `s${index + 1}`,
              purpose: index === 0 ? "承接余波并使目标落地" : "让任务发生不可逆变化",
              goal: beat,
              action: beat,
              obstacle: conflict,
              turn: index === beats.length - 1 ? text(task?.hook_end) : "阻力迫使人物改变策略",
              outcome: index === beats.length - 1 ? text(task?.hook_end) : "人物带着新的代价进入下一场",
              sensory: "场景中的可触物件或声响",
              pov,
            },
            index,
            target,
            pov,
            conflict
          )
        );
      });
    } else {
      const goal = text(task?.goal) || "完成本章目标";
      scenes.push(
        normalizeScene(
          {
            id: "s1",
            purpose: "把本章目标放进可见冲突",
            goal,
            action: `人物开始执行：${goal}`,
            obstacle: conflict || "现实阻力迫使人物付出代价",
            turn: "第一次行动带来意外后果",
            outcome: "人物获得线索但失去原有安全",
            sensory: "与冲突有关的具体物件",
            pov,
          },
          0,
          target,
          pov,
          conflict
        )
      );
      scenes.push(
        normalizeScene(
          {
            id: "s2",
            purpose: "让人物主动选择并留下章末问题",
            goal: "在代价上继续推进目标",
            action: "人物做出不可撤回的选择",
            obstacle: conflict || "对手把代价推到眼前",
            turn: "选择改变局势",
            outcome: text(task?.hook_end) || "新的威胁在章末出现",
            sensory: "选择发生时的声音或触感",
            pov,
          },
          1,
          target,
          pov,
          conflict
        )
      );
    }
    return scenes.slice(0, MAX_SCENES);
  }

  function contractSourceSignature(project, task, chapter) {
    const prev = previousChapter(project, task);
    const source = {
      task: {
        id: task?.id,
        order: task?.order,
        title: task?.chapter_title,
        goal: task?.goal,
        conflict: task?.conflict,
        beats: task?.beats,
        must_include: task?.must_include,
        must_not: task?.must_not,
        hook_end: task?.hook_end,
        pov: task?.pov,
        word_target: task?.word_target,
      },
      previous: prev ? { id: prev.id, order: prev.order, title: prev.title, tail: String(prev.body || "").slice(-1200) } : null,
      // 只有作者明确锁定的细纲才属于契约输入；引擎自己投影出的 beatPlan
      // 不参与签名，否则每次完成一章都会把同一契约误判成“变更”。
      lockedBeatPlan: chapter?.beatPlanLocked === true ? chapter?.beatPlan || null : null,
      locks: {
        logline: project?.locks?.logline || project?.spine?.logline || "",
        forbidden: project?.locks?.forbidden || [],
      },
      storyline: {
        position: project?.storyline?.positionSummary || "",
        direction: project?.storyline?.nextDirection || "",
      },
    };
    return `src_${hash(JSON.stringify(source))}`;
  }

  function deterministicPlanScenes(task, chapter) {
    const taskScenes = Array.isArray(task?.beatPlan?.scenes) ? task.beatPlan.scenes : [];
    const chapterScenes = Array.isArray(chapter?.beatPlan?.scenes) ? chapter.beatPlan.scenes : [];
    if (taskScenes.length >= MIN_SCENES) return taskScenes;
    if (chapterScenes.length >= MIN_SCENES) return chapterScenes;
    return taskScenes.length ? taskScenes : chapterScenes;
  }

  function normalizeContract(raw, project, task, chapter, cfg = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const target = targetFor(task, cfg, source);
    const pov = text(source.pov || task?.pov || task?.viewpoint || project?.styleBible?.pov);
    const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
    let scenes = rawScenes
      .slice(0, MAX_SCENES)
      .map((scene, index) => normalizeScene(scene, index, target, pov, text(source.conflict || task?.conflict)))
      .filter((scene) => scene.location || scene.goal || scene.action || scene.turn);
    if (scenes.length < MIN_SCENES) {
      const planScenes = deterministicPlanScenes(task, chapter);
      if (planScenes.length >= MIN_SCENES) {
        scenes = planScenes
          .slice(0, MAX_SCENES)
          .map((scene, index) => normalizeScene(scene, index, target, pov, text(source.conflict || task?.conflict)));
      }
    }
    if (scenes.length < MIN_SCENES) scenes = fallbackScenes(task, target);
    scenes = scenes.slice(0, MAX_SCENES);
    const requestedSum = scenes.reduce((sum, scene) => sum + (Number(scene.wordTarget) || 0), 0);
    const scale = requestedSum > 0 ? target / requestedSum : 1;
    const usedIds = new Set();
    scenes = scenes.map((scene, index) => {
      let sceneId = text(scene.id) || `s${index + 1}`;
      if (usedIds.has(sceneId)) sceneId = `${sceneId}_${index + 1}`;
      usedIds.add(sceneId);
      return {
      ...scene,
      index,
      id: sceneId,
      wordTarget: Math.max(220, Math.round((Number(scene.wordTarget) || target / scenes.length) * scale)),
      status: scene.status === "complete" ? "complete" : "pending",
      text: text(scene.text),
      };
    });
    const mustInclude = unique([...list(task?.must_include, 12), ...list(source.must_include || source.mustInclude, 12)]).slice(0, 16);
    const mustAvoid = unique([...list(task?.must_not, 12), ...list(source.must_avoid || source.mustAvoid, 12)]).slice(0, 16);
    return {
      schemaVersion: VERSION,
      id: text(source.id) || `contract_${task?.id || chapter?.id || "manual"}`,
      taskId: text(task?.id || chapter?.taskId),
      chapterId: text(chapter?.id),
      order: Number(task?.order || chapter?.order) || 0,
      title: text(source.title || source.chapter_title || task?.chapter_title || chapter?.title),
      pov,
      objective: text(source.objective || source.goal || task?.goal) || "完成本章任务并改变人物处境",
      stakes: text(source.stakes || source.cost || task?.stakes || task?.conflict),
      conflict: text(source.conflict || task?.conflict),
      change: text(source.change || source.irreversible_change || source.desired_change),
      scenes,
      hookEnd: text(source.hook_end || source.hookEnd || task?.hook_end),
      mustInclude,
      mustAvoid,
      continuityChecks: list(source.continuity_checks || source.continuityChecks, 12),
      wordTarget: target,
      createdAt: Date.now(),
    };
  }

  function contractToBeatPlan(contract) {
    const c = contract || {};
    return {
      chapter_title: c.title || "",
      opening: "action",
      scenes: (Array.isArray(c.scenes) ? c.scenes : []).map((scene) => ({
        place: scene.location || "",
        pov: scene.pov || c.pov || "",
        action: scene.action || scene.goal || "",
        turn: scene.turn || scene.outcome || "",
        sensory: scene.sensory || "",
        // 保留新字段供质量检查器和未来 UI 使用。
        purpose: scene.purpose || "",
        obstacle: scene.obstacle || "",
        outcome: scene.outcome || "",
        word_target: scene.wordTarget || 0,
      })),
      emotion_curve: "",
      payoffs: c.hookEnd ? [c.hookEnd] : [],
      avoid: c.mustAvoid || [],
      word_target: c.wordTarget || 0,
    };
  }

  function composeBody(baseBody, scenes) {
    let result = text(baseBody);
    for (const scene of Array.isArray(scenes) ? scenes : []) {
      const part = text(scene?.text);
      if (!part) continue;
      if (!result) result = part;
      else result += result.endsWith("\n") ? `\n${part}` : `\n\n${part}`;
    }
    return result;
  }

  function productionState(chapter, sourceSig, currentBody, force = false) {
    const existing = chapter?.production && typeof chapter.production === "object" ? chapter.production : null;
    const compatible =
      !force &&
      existing &&
      existing.schemaVersion === VERSION &&
      existing.contractSourceSig === sourceSig &&
      typeof existing.baseBody === "string";
    if (compatible) {
      existing.scenes = Array.isArray(existing.scenes) ? existing.scenes : [];
      existing.revisions = Number(existing.revisions) || 0;
      existing.revisionPasses = Number(existing.revisionPasses) || 0;
      existing.contextManifests = Array.isArray(existing.contextManifests) ? existing.contextManifests : [];
      // 兼容 v1 早期已压缩的运行记录：没有 bodySig 时以当前正文建立一次基线。
      if (existing.bodyAuthoritative == null && existing.compactedAt) existing.bodyAuthoritative = true;
      existing.bodyAuthoritative = Boolean(existing.bodyAuthoritative);
      existing.bodySig = existing.bodySig || (existing.bodyAuthoritative ? bodySignature(currentBody) : "");
      return existing;
    }
    const fresh = {
      schemaVersion: VERSION,
      runId: `run_${Date.now()}_${hash(`${sourceSig}:${Math.random()}`)}`,
      contractSourceSig: sourceSig,
      status: "pending",
      stage: "idle",
      baseBody: force ? "" : text(currentBody),
      scenes: [],
      bodyAuthoritative: false,
      bodySig: "",
      revisions: 0,
      // revisions 是跨运行的累计统计；revisionPasses 是当前稿件/作者编辑周期
      // 的有限预算，避免一次失败后无限自动救稿，同时允许作者改稿后重新尝试。
      revisionPasses: 0,
      qualityReview: null,
      localMetrics: null,
      contextManifests: [],
      rag: null,
      errors: [],
      updatedAt: Date.now(),
    };
    chapter.production = fresh;
    if (force) chapter.body = "";
    return fresh;
  }

  function resetIfAuthorEdited(chapter, production, task) {
    if (!production) return;
    const actual = text(chapter?.body);
    // 交接/救稿后场面正文会被压缩掉，但 chapter.body 仍是唯一完整正文。
    // 只有签名变化才说明作者真的改过，不能把压缩状态误判成编辑器改稿。
    if (production.bodyAuthoritative) {
      if (production.bodySig && production.bodySig === bodySignature(actual)) return;
      production.bodyAuthoritative = false;
      production.bodySig = bodySignature(actual);
      production.qualityReview = null;
      production.localMetrics = null;
      production.gate = null;
      production.revisionPasses = 0;
      production.updatedAt = Date.now();
      ChapterState().requestRevision(chapter, task, {
        reason: "正文已由作者修改，等待重新验收",
        stage: "edited-base",
      });
      return;
    }
    if (production.status === "needs_revision" || production.status === "done") return;
    const assembled = composeBody(production.baseBody, production.scenes);
    if (actual !== assembled) {
      // 作者在两次场面生成之间手改正文：以作者版本为新的生产基线，不能覆盖。
      production.baseBody = actual;
      production.scenes = [];
      production.qualityReview = null;
      production.localMetrics = null;
      production.gate = null;
      production.bodySig = bodySignature(actual);
      production.stage = "edited-base";
      production.updatedAt = Date.now();
    }
  }

  function plannerInput(project, task, chapter, ragPack, production, cfg = {}) {
    if (window.NOVEL_CONTEXT?.buildProductionEvidencePack) {
      return evidencePack(project, cfg, task, chapter, production, "contract", {
        ragPack,
        currentDraftText: chapter?.body ? String(chapter.body).slice(-1800) : "",
        budget: 9000,
        tokenBudget: 7000,
        prevTailChars: 1800,
        canonMaxFacts: 28,
        instruction: "只编译章节契约，不写正文。",
      }).user;
    }
    return [
      `任务:${task?.id || ""} ${task?.chapter_title || chapter?.title || ""}`,
      `目标:${task?.goal || ""}`,
      `冲突:${task?.conflict || ""}`,
      `节拍:${list(task?.beats).join("；")}`,
      `必须:${list(task?.must_include).join("；")}`,
      `钩子:${task?.hook_end || ""}`,
      `上章:${String(previousChapter(project, task)?.body || "").slice(-1500)}`,
    ].join("\n");
  }

  async function retrieve(project, cfg, task, hooks) {
    if (cfg?.ragEnabled === false) return null;
    const H = window.NOVEL_HARNESS;
    if (H?.prepareAndRetrieve) {
      const result = await H.prepareAndRetrieve(project, cfg, task, hooks);
      return result?.ragPack || null;
    }
    const R = window.NOVEL_RAG;
    if (R?.retrieveHybrid) return R.retrieveHybrid(project, task, cfg, hooks);
    if (R?.retrieveForChapter) return R.retrieveForChapter(project, task, hooks);
    return null;
  }

  function evidencePack(project, cfg, task, chapter, production, stage, opts = {}) {
    const C = window.NOVEL_CONTEXT;
    if (typeof C?.buildProductionEvidencePack !== "function") return { user: "", meta: null };
    const packed = C.buildProductionEvidencePack(project, task, chapter, { ...opts, stage }) || {
      user: "",
      meta: {},
    };
    const meta = packed.meta && typeof packed.meta === "object" ? packed.meta : {};
    const snapshot = {
      stage,
      at: Date.now(),
      chars: Number(meta.chars) || 0,
      tokens: Number(meta.tokens) || 0,
      budget: Number(meta.budget) || 0,
      tokenBudget: Number(meta.tokenBudget) || 0,
      used: Array.isArray(meta.used) ? meta.used.slice() : [],
      omitted: Array.isArray(meta.omitted) ? meta.omitted.slice() : [],
      truncated: Array.isArray(meta.truncated) ? meta.truncated.slice() : [],
      authority: meta.authority || {},
    };
    production.contextManifests = Array.isArray(production.contextManifests) ? production.contextManifests : [];
    production.contextManifests.push(snapshot);
    if (production.contextManifests.length > 12) production.contextManifests = production.contextManifests.slice(-12);
    try {
      C.recordContextManifest?.(project, task, chapter, { meta: { ...meta, stage, blocks: meta.used || [] } });
    } catch (error) {
      log(project, `上下文清单记录跳过：${error.message || error}`);
    }
    return packed;
  }

  async function createContract(project, cfg, task, chapter, ragPack, hooks, production) {
    const P = window.NOVEL_PROMPTS;
    const A = window.NOVEL_API;
    hooks.onStatus?.("contract");
    production.stage = "contract";
    production.updatedAt = Date.now();
    let raw;
    const lockedPlan = chapter?.beatPlanLocked === true ? chapter?.beatPlan || task?.beatPlan : null;
    const lockedScenes = Array.isArray(lockedPlan?.scenes) ? lockedPlan.scenes : [];
    const fallbackPlanScenes = deterministicPlanScenes(task, chapter);
    const hasDeterministicPlan = (task?.beats?.length || 0) >= MIN_SCENES || fallbackPlanScenes.length >= MIN_SCENES;
    const planPolicy = cfg?.productionPlanPolicy || window.NOVEL_DEFAULTS?.productionPlanPolicy || "strict";
    if (lockedScenes.length >= MIN_SCENES) {
      // 作者锁定的细纲是执行契约，不应再被规划器悄悄改写；仍由
      // normalizeContract 补齐 goal/outcome 等新字段，保证旧细纲可执行。
      hooks.onStatus?.("scene-planning");
      production.stage = "scene-planning";
      raw = {
        ...lockedPlan,
        title: lockedPlan.title || lockedPlan.chapter_title || task?.chapter_title || chapter?.title,
        objective: lockedPlan.objective || task?.goal || "",
        conflict: task?.conflict || "",
        hook_end: lockedPlan.hook_end || lockedPlan.hookEnd || task?.hook_end || "",
        scenes: lockedScenes,
      };
    } else {
      try {
        if (P?.chapterContract && typeof A?.chatJson === "function") {
          raw = await A.chatJson({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            temperature: cfg.temperature,
            seed: cfg.seed,
            signal: hooks.signal,
            diagnosticStage: "production-contract",
            messages: [
              { role: "system", content: `${P.commonGuard || ""}\n${P.chapterContract.system}` },
              { role: "user", content: P.chapterContract.user(plannerInput(project, task, chapter, ragPack, production, cfg)) },
            ],
          });
        } else if (planPolicy === "strict" && !hasDeterministicPlan) {
          const error = new Error("章节契约规划器不可用，且任务没有足够的确定性场面输入");
          error.code = "PRODUCTION_PLAN_FAILED";
          throw error;
        }
      } catch (error) {
        production.errors.push({ stage: "contract", message: error.message || String(error), at: Date.now() });
        log(project, `章节契约模型失败：${error.message || error}`);
        if (planPolicy === "strict" && !hasDeterministicPlan) {
          error.code = error.code || "PRODUCTION_PLAN_FAILED";
          throw error;
        }
      }
    }
    const rawScenes = Array.isArray(raw?.scenes) ? raw.scenes : [];
    const usableRawScenes = rawScenes.filter(
      (scene) =>
        scene &&
        typeof scene === "object" &&
        [scene.location, scene.goal, scene.action, scene.turn, scene.outcome].some((value) => text(value))
    );
    if (planPolicy === "strict" && !hasDeterministicPlan && usableRawScenes.length < MIN_SCENES) {
      const error = new Error("无法形成章节契约：缺少规划结果或至少两个确定性场面");
      error.code = "PRODUCTION_PLAN_FAILED";
      throw error;
    }
    const contract = normalizeContract(raw, project, task, chapter, cfg);
    if (!contract.scenes.length) {
      const error = new Error("无法形成至少两个可执行场面");
      error.code = "PRODUCTION_PLAN_FAILED";
      throw error;
    }
    production.contract = contract;
    production.contractSourceSig = contractSourceSignature(project, task, chapter);
    production.stage = "scene-planning";
    production.updatedAt = Date.now();
    // 旧 UI / craft 层继续看到 beatPlan；作者锁定的细纲不被新契约投影覆盖，
    // 这样下一次运行的签名仍代表作者真正锁定的输入。
    if (chapter?.beatPlanLocked === true && chapter.beatPlan) {
      task.beatPlan = chapter.beatPlan;
    } else {
      chapter.beatPlan = contractToBeatPlan(contract);
      task.beatPlan = chapter.beatPlan;
    }
    chapter.beatPlanSig = production.contractSourceSig;
    chapter.beatPlanAt = Date.now();
    task.chapterContract = contract;
    hooks.onCheckpoint?.(chapter, production);
    return contract;
  }

  function ensureContract(project, cfg, task, chapter, production, ragPack, hooks) {
    const sig = contractSourceSignature(project, task, chapter);
    if (!hooks.forcePlan && production.contract && production.contractSourceSig === sig) {
      return Promise.resolve(production.contract);
    }
    production.contract = null;
    production.contractSourceSig = sig;
    production.scenes = [];
    return createContract(project, cfg, task, chapter, ragPack, hooks, production);
  }

  function scenePromptContext(project, cfg, task, chapter, production, scene, index, ragPack, hooks) {
    const completed = production.scenes.filter((item) => item.status === "complete");
    const previousScene = completed.length ? completed[completed.length - 1] : null;
    const evidence = window.NOVEL_CONTEXT?.buildProductionEvidencePack
      ? evidencePack(project, cfg, task, chapter, production, "scene-writing", {
          contract: production.contract,
          ragPack,
          completedScenes: completed,
          currentDraftText: production.baseBody ? String(production.baseBody).slice(-1800) : "",
          previousSceneText: previousScene?.text ? previousScene.text.slice(-1800) : "",
          instruction: hooks.instruction || "",
          budget: Number(cfg.productionSceneContextChars) || 10000,
          tokenBudget: Math.max(4500, Math.ceil((Number(cfg.productionSceneContextChars) || 10000) * 0.72)),
          prevTailChars: Number(cfg.prevChapterTailChars) || 1600,
          canonMaxFacts: 24,
          ragTopK: 5,
          ragMaxChars: 2200,
        })
      : { user: "" };
    const contract = production.contract || {};
    const sceneLine = JSON.stringify({
      id: scene.id,
      index: index + 1,
      purpose: scene.purpose,
      location: scene.location,
      pov: scene.pov || contract.pov,
      goal: scene.goal,
      obstacle: scene.obstacle,
      action: scene.action,
      turn: scene.turn,
      outcome: scene.outcome,
      sensory: scene.sensory,
    });
    return `${evidence.user || ""}\n\n【当前场面契约】${sceneLine}\n【场面位置】第 ${index + 1}/${production.contract?.scenes?.length || 1} 场\n【本场结束标准】必须让 outcome 在正文中可观察地发生。`;
  }

  function cleanGeneratedText(value) {
    let result = String(value || "").trim();
    result = result.replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
    // 模型偶尔会把“场面一：”当标题；只去掉明确的元标签，不碰正常对白。
    result = result.replace(/^(?:场面\s*[一二三四五1-5]|Scene\s*[1-5])\s*[:：-]\s*/i, "").trim();
    return result;
  }

  function sceneOutputTokens(cfg, scene) {
    const wanted = Math.ceil((Number(scene?.wordTarget) || 600) * 1.9);
    const configured = Number(cfg?.productionSceneOutputTokens) || 0;
    const reserve = Number(cfg?.outputReserveTokens) || Number(window.NOVEL_DEFAULTS?.outputReserveTokens) || 3500;
    return Math.max(512, Math.min(65536, configured || Math.min(Math.max(900, wanted), Math.max(reserve, wanted))));
  }

  async function generateScene(project, cfg, task, chapter, production, scene, index, ragPack, hooks) {
    const P = window.NOVEL_PROMPTS;
    const A = window.NOVEL_API;
    if (!P?.sceneWriter || typeof A?.chat !== "function") {
      const error = new Error("分场生产提示协议不可用，请同步 prompts.js");
      error.code = "PRODUCTION_PROTOCOL_MISSING";
      throw error;
    }
    hooks.onStatus?.("scene-writing");
    production.stage = "scene-writing";
    production.currentScene = scene.id;
    production.updatedAt = Date.now();
    scene.status = "writing";
    const committedBody = composeBody(production.baseBody, production.scenes);
    let preview = "";
    try {
      const result = await A.chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        outputTokens: sceneOutputTokens(cfg, scene),
        signal: hooks.signal,
        diagnosticStage: "scene-writing",
        stream: true,
        messages: [
          {
            role: "system",
            content: `${P.commonGuard || ""}\n${P.sceneWriter.system({
              wordTarget: scene.wordTarget,
              tone: project.tone || project.stylePreset || "",
            })}`,
          },
          { role: "user", content: scenePromptContext(project, cfg, task, chapter, production, scene, index, ragPack, hooks) },
        ],
        onDelta: (delta, full) => {
          preview = cleanGeneratedText(full);
          chapter.body = composeBody(committedBody, [{ text: preview }]);
          chapter.updatedAt = Date.now();
          hooks.onDelta?.(delta, chapter.body, chapter.id);
        },
      });
      const output = cleanGeneratedText(result?.content || preview);
      const minChars = Math.max(80, Math.round((Number(scene.wordTarget) || 600) * 0.12));
      if (output.length < minChars) {
        const error = new Error(`第 ${index + 1} 场输出过短（${output.length} 字）`);
        error.code = "SCENE_OUTPUT_TOO_SHORT";
        throw error;
      }
      scene.text = output;
      scene.status = "complete";
      scene.wordCount = output.length;
      scene.ledger = {
        location: scene.location,
        pov: scene.pov,
        goal: scene.goal,
        plannedTurn: scene.turn,
        plannedOutcome: scene.outcome,
        tail: output.slice(-260),
        at: Date.now(),
      };
      scene.completedAt = Date.now();
      chapter.body = composeBody(production.baseBody, production.scenes);
      chapter.updatedAt = Date.now();
      production.updatedAt = Date.now();
      hooks.onDelta?.("", chapter.body, chapter.id);
      hooks.onCheckpoint?.(chapter, production);
      return output;
    } catch (error) {
      // 半稿只用于界面预览；失败/停止后恢复到最后一个已提交场面。
      chapter.body = committedBody;
      scene.status = "pending";
      scene.text = "";
      production.stage = "scene-failed";
      production.errors.push({ stage: "scene", sceneId: scene.id, message: error.message || String(error), at: Date.now() });
      if (error.name !== "AbortError") {
        task.lastError = error.message || String(error);
        task.lastErrorStage = "scene";
      }
      throw error;
    }
  }

  async function generateScenes(project, cfg, task, chapter, production, ragPack, hooks) {
    const scenes = Array.isArray(production.contract?.scenes) ? production.contract.scenes : [];
    if (!scenes.length) throw new Error("章节契约没有可生成场面");
    const existingScenes = Array.isArray(production.scenes) ? production.scenes : [];
    production.scenes = scenes.map((scene) => {
      const old = existingScenes.find((item) => item.id === scene.id);
      return old ? { ...scene, ...old } : scene;
    });
    if (
      production.bodyAuthoritative &&
      production.bodySig &&
      production.bodySig === bodySignature(chapter?.body) &&
      text(chapter?.body) &&
      production.scenes.length === scenes.length &&
      production.scenes.every((scene) => scene.status === "complete")
    ) {
      // 压缩后的场面元数据仍然是已提交检查点；完整正文在 chapter.body，不能重复追加。
      return chapter.body;
    }
    const assembled = composeBody(production.baseBody, production.scenes);
    if (text(chapter.body) !== assembled && production.status !== "needs_revision") {
      production.baseBody = text(chapter.body);
      production.scenes = production.scenes.map((scene) => ({ ...scene, status: "pending", text: "" }));
    }
    for (let index = 0; index < production.scenes.length; index++) {
      const scene = production.scenes[index];
      if (scene.status === "complete" && (text(scene.text) || scene.revised === true)) continue;
      await generateScene(project, cfg, task, chapter, production, scene, index, ragPack, hooks);
      hooks.onSceneProgress?.({ index, total: production.scenes.length, scene });
    }
    chapter.body = composeBody(production.baseBody, production.scenes);
    return chapter.body;
  }

  async function generateCoherentChapter(project, cfg, task, chapter, production, ragPack, hooks) {
    const Drafting = window.NOVEL_CHAPTER_DRAFTING;
    const P = window.NOVEL_PROMPTS;
    const A = window.NOVEL_API;
    if (typeof Drafting?.create !== "function" || typeof A?.chat !== "function" || !P?.chapterWriter) {
      const error = new Error("整章连贯起草协议不可用，请同步 chapter-drafting-service.js / prompts.js");
      error.code = "PRODUCTION_PROTOCOL_MISSING";
      throw error;
    }
    hooks.onStatus?.("chapter-drafting");
    production.stage = "chapter-drafting";
    production.updatedAt = Date.now();
    const evidence = evidencePack(project, cfg, task, chapter, production, "chapter-drafting", {
      contract: production.contract,
      ragPack,
      instruction: hooks.instruction || "",
      budget: Number(cfg.productionChapterContextChars) || 14000,
      tokenBudget: Math.max(6500, Math.ceil((Number(cfg.productionChapterContextChars) || 14000) * 0.72)),
      prevTailChars: Number(cfg.prevChapterTailChars) || 1800,
      canonMaxFacts: 32,
      ragTopK: 6,
      ragMaxChars: 2600,
    }).user;
    const drafting = Drafting.create({ chat: (options) => A.chat(options) });
    return drafting.draftChapter({
      project,
      cfg,
      task,
      chapter,
      production,
      evidence,
      systemPrompt: `${P.commonGuard || ""}\n${P.chapterWriter.system({
        wordTarget: production.contract?.wordTarget || cfg.chapterTargetWords || 2000,
        tone: project.tone || project.stylePreset || "",
        pov: production.contract?.pov || task?.pov || "",
      })}`,
      hooks,
    });
  }

  function Quality() {
    const quality = window.NOVEL_PRODUCTION_QUALITY;
    if (!quality) throw new Error("NOVEL_PRODUCTION_QUALITY 未在 production-engine.js 前加载");
    return quality;
  }

  function sceneContractCoverage(body, contract, drafts = null) {
    return Quality().sceneContractCoverage(body, contract, drafts);
  }

  function localQuality(project, task, chapter, contract, cfg) {
    return Quality().localQuality(project, task, chapter, contract, cfg, {
      craft: window.NOVEL_CRAFT,
      previousChapter,
      contractToBeatPlan,
    });
  }

  function normalizeQuality(raw, local, contract, cfg = {}) {
    return Quality().normalizeQuality(raw, local, contract, cfg, { defaults: window.NOVEL_DEFAULTS });
  }

  function qualityContext(project, cfg, task, chapter, production, ragPack) {
    const local = production.localMetrics || {};
    const contract = production.contract || {};
    const contractText = JSON.stringify({
      objective: contract.objective,
      stakes: contract.stakes,
      conflict: contract.conflict,
      pov: contract.pov,
      hookEnd: contract.hookEnd,
      mustInclude: contract.mustInclude,
      scenes: contract.scenes?.map((scene) => ({
        id: scene.id,
        purpose: scene.purpose,
        location: scene.location,
        goal: scene.goal,
        obstacle: scene.obstacle,
        turn: scene.turn,
        outcome: scene.outcome,
      })),
    });
    const evidence = window.NOVEL_CONTEXT?.buildProductionEvidencePack
      ? evidencePack(project, cfg, task, chapter, production, "quality-review", {
          contract,
          ragPack,
          budget: 8500,
          tokenBudget: 6500,
          prevTailChars: 1600,
          canonMaxFacts: 28,
          ragTopK: 5,
          ragMaxChars: 2200,
        }).user
      : "";
    const P = window.NOVEL_PROMPTS;
    const sampler = P?.sampleNarrativeText || ((value, n) => String(value || "").slice(0, n));
    const body = sampler(chapter.body, Number(cfg.productionCriticBodyChars) || 14000);
    return [
      evidence,
      `【章节契约】${contractText}`,
      `【本地可复现指标】${JSON.stringify(local)}`,
      `【待验收正文】\n${body}`,
      "请逐场核对因果链；正文证据必须来自待验收正文，不能把契约愿望当成已完成事实。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function reviewQuality(project, cfg, task, chapter, production, ragPack, hooks) {
    const P = window.NOVEL_PROMPTS;
    const A = window.NOVEL_API;
    hooks.onStatus?.("quality-review");
    production.stage = "quality-review";
    production.localMetrics = localQuality(project, task, chapter, production.contract, cfg);
    let raw;
    try {
      if (P?.chapterQualityReview && typeof A?.chatJson === "function") {
        raw = await A.chatJson({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          signal: hooks.signal,
          diagnosticStage: "quality-review",
          messages: [
            { role: "system", content: `${P.commonGuard || ""}\n${P.chapterQualityReview.system}` },
            { role: "user", content: P.chapterQualityReview.user(qualityContext(project, cfg, task, chapter, production, ragPack)) },
          ],
        });
      } else {
        throw new Error("质量批评协议不可用，请同步 prompts.js");
      }
    } catch (error) {
      production.errors.push({ stage: "quality-review", message: error.message || String(error), at: Date.now() });
      if (cfg.productionQualityPolicy === "strict") {
        error.code = error.code || "PRODUCTION_REVIEW_FAILED";
        throw error;
      }
      raw = { verdict: "revise", overall: 0, issues: [{ severity: "major", type: "review", summary: "质量批评器不可用", fix: "重新运行质量验收" }] };
    }
    const review = normalizeQuality(raw, production.localMetrics, production.contract, cfg);
    review.bodySig = `body_${hash(chapter.body || "")}`;
    review.model = cfg.model || "";
    production.qualityReview = review;
    chapter.qualityReview = review;
    production.updatedAt = Date.now();
    hooks.onCheckpoint?.(chapter, production);
    if (review.issues.length && window.NOVEL_CONTEXT?.mergeContinuityIssues) {
      window.NOVEL_CONTEXT.mergeContinuityIssues(
        project,
        {
          continuity_warnings: review.issues.map((issue) => ({
            ...issue,
            evidence: issue.evidence || "质量批评器指出的结构问题",
            suggestion: issue.fix,
          })),
        },
        { chapter: chapter.title, taskId: task?.id || chapter.taskId || "", order: chapter.order || task?.order || 0 }
      );
    }
    log(project, `质量验收 ${chapter.title || chapter.id} verdict=${review.verdict} overall=${review.overall} issues=${review.issues.length}`);
    return review;
  }

  function qualityGate(review, cfg = {}) {
    return Quality().qualityGate(review, cfg, { defaults: window.NOVEL_DEFAULTS });
  }

  function revisionContext(project, cfg, task, chapter, production, review, ragPack, instruction = "") {
    const evidence = window.NOVEL_CONTEXT?.buildProductionEvidencePack
      ? evidencePack(project, cfg, task, chapter, production, "revision", {
          contract: production.contract,
          ragPack,
          budget: 9000,
          tokenBudget: 6800,
          prevTailChars: 1600,
          canonMaxFacts: 30,
        }).user
      : "";
    const P = window.NOVEL_PROMPTS;
    const bodyBudget = Math.max(5000, Number(cfg.productionCriticBodyChars) || 14000);
    const body = window.NOVEL_CONTEXT?.clipToDualBudget
      ? window.NOVEL_CONTEXT.clipToDualBudget(chapter.body || "", bodyBudget, Math.max(3600, Math.ceil(bodyBudget * 0.72)))
      : String(chapter.body || "").slice(0, bodyBudget);
    return [
      evidence,
      `【质量批评报告】${JSON.stringify(review)}`,
      `【当前完整正文】\n${body}`,
      instruction ? `【作者本轮修订要求】\n${instruction}` : "",
      "只修复报告中的 blocker/major；返回完整正文，不要解释。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function commitRevision(chapter, task, production, revised, note) {
    const original = String(chapter.body || "");
    chapter.revisionHistory = Array.isArray(chapter.revisionHistory) ? chapter.revisionHistory : [];
    chapter.revisionHistory.push({
      at: Date.now(),
      kind: "production-quality-revision",
      note: note || "",
      body: original,
      bodySig: bodySignature(original),
    });
    if (chapter.revisionHistory.length > 6) chapter.revisionHistory = chapter.revisionHistory.slice(-6);
    chapter.body = revised;
    chapter.updatedAt = Date.now();
    production.revisions = (Number(production.revisions) || 0) + 1;
    production.revisionPasses = (Number(production.revisionPasses) || 0) + 1;
    ChapterState().markRevising(chapter, task, {
      reason: "质量修订后等待重新验收与交接",
    });
    // 修订后的正文不再与逐场草稿一一对应；保留契约，但禁止把旧场面当新正文重复追加。
    // 正文本身已经落在 chapter.body；不要在生产元数据里再复制一整章，
    // 否则 localStorage/vault 快照会随每次救稿成倍膨胀。
    production.baseBody = "";
    production.bodyAuthoritative = true;
    production.bodySig = bodySignature(revised);
    production.scenes = production.scenes.map((scene) => ({ ...scene, status: "complete", revised: true, text: "" }));
  }

  function compactProduction(production, body = "") {
    if (!production || typeof production !== "object") return production;
    production.baseBody = "";
    production.scenes = (Array.isArray(production.scenes) ? production.scenes : []).map((scene) => {
      const { text: _discardedText, ...meta } = scene || {};
      return { ...meta, text: "" };
    });
    production.bodyAuthoritative = true;
    production.bodySig = bodySignature(body);
    production.compactedAt = Date.now();
    return production;
  }

  function markHandoffComplete(chapter, task = null) {
    const production = chapter?.production;
    if (!production || typeof production !== "object") return null;
    if (production.status !== "done" || chapter.handoffStatus !== "done") {
      ChapterState().completeHandoff(chapter, task);
    }
    production.handoffAt = Number(chapter.handoffAt) || Date.now();
    compactProduction(production, chapter.body);
    return production;
  }

  function refreshStyleProfile(project) {
    const Craft = window.NOVEL_CRAFT;
    if (typeof Craft?.deriveStyleProfile !== "function") return null;
    try {
      const profile = Craft.deriveStyleProfile(project?.chapters || [], { limit: 6 });
      if (profile) project.styleProfile = profile;
      return profile;
    } catch (error) {
      // 风格画像是软约束；统计失败不能阻断正文验收或章后交接。
      log(project, `风格画像更新跳过：${error.message || error}`);
      return null;
    }
  }

  async function reviseChapter(project, cfg, task, chapter, production, review, ragPack, hooks) {
    const P = window.NOVEL_PROMPTS;
    const A = window.NOVEL_API;
    if (!P?.chapterRevision || typeof A?.chat !== "function") {
      const error = new Error("整章救稿协议不可用，请同步 prompts.js");
      error.code = "PRODUCTION_PROTOCOL_MISSING";
      throw error;
    }
    hooks.onStatus?.("revising");
    production.stage = "revising";
    const original = String(chapter.body || "");
    let preview = "";
    try {
      const result = await A.chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        outputTokens: Math.max(Number(cfg.outputReserveTokens) || 3500, Math.ceil(original.length * 1.7)),
        signal: hooks.signal,
        diagnosticStage: "revision",
        stream: true,
        messages: [
          {
            role: "system",
            content: `${P.commonGuard || ""}\n${P.chapterRevision.system({
              wordTarget: production.contract?.wordTarget || cfg.chapterTargetWords || 2000,
            })}`,
          },
          { role: "user", content: P.chapterRevision.user(revisionContext(project, cfg, task, chapter, production, review, ragPack, hooks.instruction || "")) },
        ],
        onDelta: (delta, full) => {
          preview = cleanGeneratedText(full);
          chapter.body = preview;
          chapter.updatedAt = Date.now();
          hooks.onDelta?.(delta, chapter.body, chapter.id);
        },
      });
      const revised = cleanGeneratedText(result?.content || preview);
      const ratio = original.length ? revised.length / original.length : 1;
      const minRatio = Number(cfg.productionMinLengthRatio) || Number(window.NOVEL_DEFAULTS?.productionMinLengthRatio) || 0.55;
      if (!revised || revised.length < 120 || ratio < minRatio || ratio > 2.4) {
        const error = new Error("救稿结果长度异常，原稿已保留");
        error.code = "REVISION_FAILED";
        throw error;
      }
      commitRevision(chapter, task, production, revised, (review.issues || []).slice(0, 4).map((x) => x.summary).join("；"));
      hooks.onDelta?.("", chapter.body, chapter.id);
      hooks.onCheckpoint?.(chapter, production);
      return revised;
    } catch (error) {
      chapter.body = original;
      if (error.name !== "AbortError") {
        production.errors.push({ stage: "revising", message: error.message || String(error), at: Date.now() });
        task.lastError = error.message || String(error);
        task.lastErrorStage = "revising";
      }
      throw error;
    }
  }

  function qualityBlockedError(gate) {
    const message = `本章未通过质量闸门：${(gate?.reasons || []).slice(0, 4).join("；") || "需要重新验收"}`;
    const error = new Error(message);
    error.code = "QUALITY_GATE_BLOCKED";
    error.gate = gate;
    return error;
  }

  async function handoff(project, cfg, task, chapter, production, hooks) {
    if (cfg.manualAutoHandoff === false && hooks.handoff !== true) {
      ChapterState().markAccepted(chapter, task, {
        pendingHandoff: true,
        reason: "正文已通过质量闸门，等待章后交接",
      });
      compactProduction(production, chapter.body);
      // 正文已通过质量闸门，即使等待手工交接，也可以作为下一章的软风格样本。
      refreshStyleProfile(project);
      return chapter;
    }
    hooks.onStatus?.("accepted");
    ChapterState().markAccepted(chapter, task);
    const P = window.NOVEL_PIPELINE;
    if (typeof P?.handoffChapter !== "function") {
      markHandoffComplete(chapter, task);
      refreshStyleProfile(project);
      return chapter;
    }
    await P.handoffChapter(project, cfg, chapter, task, { ...hooks, qualityValidated: true });
    if (production.status !== "done") markHandoffComplete(chapter);
    production.updatedAt = Date.now();
    refreshStyleProfile(project);
    return chapter;
  }

  async function runChapter(project, cfg = {}, task, hooks = {}) {
    const P = window.NOVEL_PIPELINE;
    if (!project || !task || typeof P?.ensureChapterForTask !== "function") throw new Error("生产引擎缺少项目或任务");
    const chapter = P.ensureChapterForTask(project, task);
    if (task.status === "done" && chapter.body?.trim() && !hooks.force && !hooks.forceRewrite) {
      hooks.onStatus?.("skip-done");
      return chapter;
    }
    const sourceSig = contractSourceSignature(project, task, chapter);
    const production = productionState(chapter, sourceSig, chapter.body, !!hooks.forceRewrite);
    resetIfAuthorEdited(chapter, production, task);
    if (production.status === "done") {
      ChapterState().markGenerating(chapter, task, { stage: "idle" });
    }
    production.updatedAt = Date.now();
    task.lastError = "";
    task.lastErrorStage = "";

    // needs_revision 是可恢复状态：再次点击只走救稿/复检，不重复追加场面。
    // production.rag 默认只保存可审计元数据，不是可直接注入 prompt 的完整
    // RetrievalPack；只有带 hits 数组的旧/显式缓存才可复用，否则恢复时重检索。
    let ragPack = production.rag && Array.isArray(production.rag.hits) ? production.rag : null;
    try {
      if (!ragPack) {
        hooks.onStatus?.("retrieve");
        ragPack = await retrieve(project, cfg, task, hooks);
        production.rag = ragPack
          ? { mode: ragPack.mode, hitCount: ragPack.hits?.length || 0, queries: ragPack.queries || [], indexSize: ragPack.indexSize || 0 }
          : null;
      }
      const contract = await ensureContract(project, cfg, task, chapter, production, ragPack, hooks);
      // 修订/人工编辑重试时正文已经存在，跳过场面追加；首次/中断恢复才逐场生成。
      // 质量报告可能因作者手改而被清空，仍不能把整章正文当作 baseBody 再追加一遍。
      const retryingRevision =
        (window.NOVEL_PRODUCTION_STATE?.isQualityBlocked?.(chapter) ??
          ["needs_revision", "quality-blocked"].includes(String(production.status || ""))) &&
        chapter.body?.trim();
      if (!retryingRevision) {
        const productionMode = cfg.productionMode || window.NOVEL_DEFAULTS?.productionMode || "scene";
        if (productionMode === "chapter") {
          await generateCoherentChapter(project, cfg, task, chapter, production, ragPack, hooks);
        } else {
          await generateScenes(project, cfg, task, chapter, production, ragPack, hooks);
        }
      }

      // 连续性自动修订会改写正文，必须发生在语义质量验收之前；否则报告会
      // 指向旧正文，而后续交接却把新正文标记为 done。
      if (cfg.continuityReviewEnabled === true && typeof P.reviewAndRepairChapter === "function") {
        hooks.onStatus?.("continuity-review");
        await P.reviewAndRepairChapter(project, cfg, chapter, task, hooks);
      }

      let review = await reviewQuality(project, cfg, task, chapter, production, ragPack, hooks);
      let gate = qualityGate(review, cfg);
      const maxRevisions = Math.max(0, Number(cfg.productionMaxRevisionPasses ?? window.NOVEL_DEFAULTS?.productionMaxRevisionPasses) || 0);
      while (!gate.accepted && (Number(production.revisionPasses) || 0) < maxRevisions) {
        await reviseChapter(project, cfg, task, chapter, production, review, ragPack, hooks);
        review = await reviewQuality(project, cfg, task, chapter, production, ragPack, hooks);
        gate = qualityGate(review, cfg);
      }
      if (!gate.accepted) {
        production.gate = gate;
        ChapterState().requestRevision(chapter, task, {
          reason: gate.reasons.join("；") || "质量闸门未通过，等待修订",
          stage: "quality-blocked",
        });
        hooks.onStatus?.("quality-blocked");
        log(project, `质量闸门阻断 ${task.id}: ${gate.reasons.join("；")}`);
        throw qualityBlockedError(gate);
      }
      production.gate = gate;
      chapter.body = text(chapter.body);
      if (typeof P.applyCraftSignals === "function") P.applyCraftSignals(project, task, chapter, chapter.body);
      await handoff(project, cfg, task, chapter, production, hooks);
      task.lastError = "";
      task.lastErrorStage = "";
      hooks.onStatus?.(production.status === "accepted_pending_handoff" ? "accepted" : "done");
      log(project, `生产完成 ${task.id} scenes=${production.contract?.scenes?.length || 0} revisions=${production.revisions}`);
      return chapter;
    } catch (error) {
      if (error?.name === "AbortError") {
        ChapterState().markPaused(chapter, task);
      } else if (error?.code !== "QUALITY_GATE_BLOCKED") {
        ChapterState().markFailed(chapter, task, {
          reason: error.message || String(error),
          stage: production.stage || "failed",
          errorStage: task.lastErrorStage || production.stage || "production",
        });
      }
      production.updatedAt = Date.now();
      chapter.production = production;
      throw error;
    }
  }

  function summary(chapter) {
    const production = chapter?.production || {};
    const review = production.qualityReview || chapter?.qualityReview || null;
    return {
      version: VERSION,
      status: production.status || "pending",
      stage: production.stage || "idle",
      scenes: Array.isArray(production.contract?.scenes) ? production.contract.scenes.length : Array.isArray(production.scenes) ? production.scenes.length : 0,
      completedScenes: Array.isArray(production.scenes) ? production.scenes.filter((scene) => scene.status === "complete").length : 0,
      revisions: Number(production.revisions) || 0,
      revisionPasses: Number(production.revisionPasses) || 0,
      overall: Number(review?.overall) || 0,
      verdict: review?.verdict || "",
      gate: production.gate || null,
    };
  }

  return {
    VERSION,
    normalizeScene,
    normalizeContract,
    contractToBeatPlan,
    contractSourceSignature,
    composeBody,
    sceneContractCoverage,
    localQuality,
    normalizeQuality,
    qualityGate,
    markHandoffComplete,
    summary,
    runChapter,
  };
})();
