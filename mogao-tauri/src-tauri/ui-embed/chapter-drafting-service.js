/**
 * Coherent chapter drafting service.
 *
 * The scene contract remains the structural source of truth, but one model call writes the whole
 * chapter. This avoids the recap/seam/voice drift produced by concatenating independently sampled
 * scenes. Network, clock and UI effects are injected ports.
 */
window.NOVEL_CHAPTER_DRAFTING = (() => {
  function text(value) {
    return String(value ?? "").trim();
  }

  function hash(value) {
    let h = 2166136261;
    const source = String(value || "");
    for (let i = 0; i < source.length; i += 1) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function cleanDraft(value) {
    let result = text(value);
    result = result.replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
    result = result.replace(/^(?:正文|章节正文|完整正文)\s*[:：]\s*/i, "").trim();
    return result;
  }

  function contractManifest(contract = {}) {
    return {
      id: text(contract.id),
      title: text(contract.title),
      pov: text(contract.pov),
      objective: text(contract.objective),
      stakes: text(contract.stakes),
      conflict: text(contract.conflict),
      change: text(contract.change),
      hookEnd: text(contract.hookEnd),
      mustInclude: Array.isArray(contract.mustInclude) ? contract.mustInclude.slice(0, 16) : [],
      mustAvoid: Array.isArray(contract.mustAvoid) ? contract.mustAvoid.slice(0, 16) : [],
      scenes: (Array.isArray(contract.scenes) ? contract.scenes : []).map((scene, index) => ({
        index: index + 1,
        id: text(scene.id) || `s${index + 1}`,
        purpose: text(scene.purpose),
        location: text(scene.location),
        pov: text(scene.pov || contract.pov),
        goal: text(scene.goal),
        obstacle: text(scene.obstacle),
        action: text(scene.action),
        turn: text(scene.turn),
        outcome: text(scene.outcome),
        sensory: text(scene.sensory),
        wordTarget: Number(scene.wordTarget) || 0,
      })),
      wordTarget: Number(contract.wordTarget) || 0,
    };
  }

  function buildPrompt({ evidence = "", contract = {}, instruction = "" } = {}) {
    const manifest = contractManifest(contract);
    return [
      text(evidence),
      `【整章执行契约】${JSON.stringify(manifest)}`,
      `【整章连贯性要求】\n- 一次输出完整章节；场面边界只体现在自然转场，不输出“场面一/二”等标签。\n- 开头直接进入当前目标，不复述上章摘要；相邻场面不得重新介绍同一人物、地点或冲突。\n- 所有场面共享同一叙述距离、POV、人物声线与时间连续性。\n- 每场 outcome 必须成为下一场的原因或约束；章末只兑现契约中的 hookEnd。\n- 只输出小说正文，不输出标题、解释、提纲、JSON 或 Markdown 围栏。`,
      instruction ? `【作者本次指令】${text(instruction)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function outputTokens(cfg = {}, contract = {}) {
    const target = Number(contract.wordTarget) || Number(cfg.chapterTargetWords) || 2000;
    const wanted = Math.ceil(target * 1.9);
    const configured = Number(cfg.productionChapterOutputTokens) || 0;
    const reserve = Number(cfg.outputReserveTokens) || 3500;
    return Math.max(1024, Math.min(65536, configured || Math.max(reserve, wanted)));
  }

  function validateDraft(body, contract = {}, cfg = {}) {
    const value = cleanDraft(body);
    const target = Number(contract.wordTarget) || Number(cfg.chapterTargetWords) || 2000;
    const minRatio = Number(cfg.productionMinLengthRatio) || 0.55;
    const minChars = Math.max(240, Math.round(target * minRatio));
    const maxChars = Math.max(minChars + 1, Math.round(target * 2.4));
    const reasons = [];
    if (value.length < minChars) reasons.push(`正文过短：${value.length} < ${minChars}`);
    if (value.length > maxChars) reasons.push(`正文过长：${value.length} > ${maxChars}`);
    if (/^(?:#{1,6}\s|第[一二三四五六七八九十\d]+章\s|场面\s*[一二三四五六\d]+\s*[:：])/m.test(value)) {
      reasons.push("正文包含章节/场面元标签");
    }
    return { ok: reasons.length === 0, reasons, body: value, chars: value.length, target };
  }

  function markContractScenesComplete(production, body, now) {
    const scenes = Array.isArray(production?.contract?.scenes) ? production.contract.scenes : [];
    production.scenes = scenes.map((scene, index) => ({
      ...scene,
      index,
      status: "complete",
      text: "",
      wordCount: 0,
      revised: false,
      ledger: {
        location: scene.location,
        pov: scene.pov || production.contract?.pov || "",
        goal: scene.goal,
        plannedTurn: scene.turn,
        plannedOutcome: scene.outcome,
        wholeDraft: true,
        verification: "pending-critic",
        at: now,
      },
      completedAt: now,
    }));
    production.baseBody = body;
    production.currentScene = null;
    production.draftMode = "chapter";
  }

  function create(deps = {}) {
    const now = typeof deps.now === "function" ? deps.now : () => Date.now();

    async function draftChapter(args = {}) {
      const { project, cfg = {}, task, chapter, production, evidence = "", systemPrompt = "", hooks = {} } = args;
      if (!chapter || !production?.contract) throw new Error("整章起草缺少章节或执行契约");
      if (typeof deps.chat !== "function") {
        const error = new Error("整章起草模型端口不可用");
        error.code = "PRODUCTION_PROTOCOL_MISSING";
        throw error;
      }
      const original = String(chapter.body || "");
      const prompt = buildPrompt({ evidence, contract: production.contract, instruction: hooks.instruction || "" });
      const startedAt = now();
      let preview = "";
      try {
        const result = await deps.chat({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          seed: cfg.seed,
          outputTokens: outputTokens(cfg, production.contract),
          signal: hooks.signal,
          stream: true,
          messages: [
            { role: "system", content: String(systemPrompt || "") },
            { role: "user", content: prompt },
          ],
          onDelta(delta, full) {
            preview = cleanDraft(full);
            chapter.body = preview;
            chapter.updatedAt = now();
            hooks.onDelta?.(delta, preview, chapter.id);
          },
        });
        const validation = validateDraft(result?.content || preview, production.contract, cfg);
        if (!validation.ok) {
          const error = new Error(`整章草稿未通过结构校验：${validation.reasons.join("；")}`);
          error.code = "CHAPTER_DRAFT_INVALID";
          error.validation = validation;
          throw error;
        }
        chapter.body = validation.body;
        chapter.updatedAt = now();
        markContractScenesComplete(production, validation.body, chapter.updatedAt);
        production.draftManifest = {
          schemaVersion: 1,
          mode: "chapter",
          model: cfg.model || "",
          taskId: task?.id || chapter.taskId || "",
          contractId: production.contract.id || "",
          promptHash: `prompt_${hash(prompt)}`,
          bodyHash: `body_${hash(validation.body)}`,
          promptChars: prompt.length,
          bodyChars: validation.chars,
          startedAt,
          completedAt: chapter.updatedAt,
        };
        production.updatedAt = chapter.updatedAt;
        hooks.onDelta?.("", chapter.body, chapter.id);
        hooks.onCheckpoint?.(chapter, production, project);
        return validation.body;
      } catch (error) {
        chapter.body = original;
        chapter.updatedAt = now();
        production.stage = "draft-failed";
        hooks.onDelta?.("", original, chapter.id);
        throw error;
      }
    }

    return { draftChapter };
  }

  return {
    cleanDraft,
    contractManifest,
    buildPrompt,
    outputTokens,
    validateDraft,
    markContractScenesComplete,
    create,
  };
})();
