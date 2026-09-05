/** Canon selection and authority-ranked evidence assembly for chapter production. */
window.NOVEL_CONTEXT_EVIDENCE = (() => {
  function create({
    getDefaults = () => ({}),
    buildEntityStateBlock,
    buildTimelineBlock,
    findPrevWrittenChapter,
    getActivePlotLoops,
    buildStyleVoiceBlock,
    estimateTokens,
    clipToDualBudget,
  } = {}) {
    for (const [name, dependency] of Object.entries({
      buildEntityStateBlock,
      buildTimelineBlock,
      findPrevWrittenChapter,
      getActivePlotLoops,
      buildStyleVoiceBlock,
      estimateTokens,
      clipToDualBudget,
    })) {
      if (typeof dependency !== "function") throw new TypeError(`context evidence requires ${name}`);
    }
    const Defaults = getDefaults;

    function selectCanonFacts(project, task = null, limit) {
      const max = limit || Defaults()?.canonMaxFactsInPrompt || 36;
      const facts = (project.detailCanon?.facts || []).filter((f) => f.status !== "superseded");
      const taskBlob = [
        task?.chapter_title,
        task?.goal,
        task?.conflict,
        task?.pov,
        ...(task?.beats || []),
        ...(task?.must_include || []),
        ...(task?.must_not || []),
        task?.hook_end,
      ]
        .filter(Boolean)
        .join(" ");
      const rank = { number: 42, name: 38, system: 34, item: 28, location: 26, relationship: 24, other: 12 };
      const scored = facts.map((fact, index) => {
        const key = String(fact.key || "");
        const entity = String(fact.entity || key.split(".")[0] || "");
        const searchable = `${key} ${entity} ${fact.value || ""}`;
        let score = rank[fact.category] ?? 12;
        if (fact.scope === "global" || fact.global === true || Number(fact.priority) >= 100) score += 1000;
        if (entity && taskBlob.includes(entity)) score += 500;
        if (key && taskBlob.includes(key)) score += 700;
        if (task?.pov && entity === task.pov) score += 600;
        for (const token of searchable.match(/[\u4e00-\u9fff]{2,4}|[a-z0-9_]+/gi) || []) {
          if (taskBlob.includes(token)) score += 12;
        }
        if (fact.locked !== false) score += 5;
        return { fact, score, index };
      });
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      return {
        facts: scored.slice(0, max).map((x) => x.fact),
        omitted: Math.max(0, facts.length - max),
        total: facts.length,
        scores: scored.slice(0, max).map((x) => ({ key: x.fact.key, score: x.score })),
      };
    }

    function buildProductionEvidencePack(project, task, chapter, opts = {}) {
      const contract = opts.contract && typeof opts.contract === "object" ? opts.contract : {};
      const budget = Math.max(2400, Number(opts.budget) || 10000);
      const tokenBudget = Math.max(1800, Number(opts.tokenBudget) || Math.ceil(budget * 0.72));
      const sections = [];
      const add = (id, authority, text, cap = 2200) => {
        const value = String(text || "").trim();
        if (!value) return;
        sections.push({ id, authority, text: value.slice(0, Math.max(120, cap)) });
      };
  
      const compactArray = (value, limit = 8) =>
        (Array.isArray(value) ? value : [])
          .map((item) => (typeof item === "string" ? item : item?.summary || item?.text || ""))
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, limit);
  
      // 最高优先级：本轮契约是执行指令，但其中引用的事实仍受 canon/上章约束。
      const contractText = [
        `任务:${contract.taskId || task?.id || ""}｜章节:${contract.title || chapter?.title || ""}`,
        `目标:${contract.objective || task?.goal || ""}`,
        `冲突:${contract.conflict || task?.conflict || ""}`,
        `代价/ stakes:${contract.stakes || ""}`,
        `视角:${contract.pov || task?.pov || ""}`,
        `章末钩子:${contract.hookEnd || task?.hook_end || ""}`,
        compactArray(contract.mustInclude || task?.must_include, 8).length
          ? `必须兑现:${compactArray(contract.mustInclude || task?.must_include, 8).join("；")}`
          : "",
        compactArray(contract.mustAvoid || task?.must_not, 8).length
          ? `禁止:${compactArray(contract.mustAvoid || task?.must_not, 8).join("；")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      add("contract", "instruction", contractText, 2600);
  
      // 锁定事实：只取已选中的事实，不把整个细节库塞进每个场面。
      const selected =
        typeof selectCanonFacts === "function"
          ? selectCanonFacts(project, task, opts.canonMaxFacts || 28)
          : { facts: (project?.detailCanon?.facts || []).slice(0, 28), omitted: [] };
      const canonLines = (selected.facts || [])
        .filter((fact) => fact && fact.status !== "superseded")
        .map((fact) => `- ${fact.key || "设定"} = ${fact.value || ""}${fact.evidence ? `（证据:${fact.evidence}）` : ""}`)
        .join("\n");
      add("canon", "locked", canonLines, 3000);
  
      const state = project?.storyState || {};
      add(
        "state",
        "state",
        [
          `主角处境:${state.protagonistState || ""}`,
          `地点:${state.location || ""}｜时间:${state.timeline || ""}`,
          `能力/系统:${state.powerOrSystem || ""}`,
          `已确立事实:${compactArray(state.establishedFacts, 8).join("；")}`,
          `最近钩子:${state.recentHook || state.endingNote || ""}`,
        ]
          .filter((line) => !line.endsWith(":"))
          .join("\n"),
        1800
      );
  
      const entity = typeof buildEntityStateBlock === "function" ? buildEntityStateBlock(project, task) : "";
      add("entities", "state", entity, 2200);
      const timeline = typeof buildTimelineBlock === "function" ? buildTimelineBlock(project, task) : "";
      add("timeline", "state", timeline, 1600);
  
      const prev = typeof findPrevWrittenChapter === "function" ? findPrevWrittenChapter(project, task) : null;
      const prevTail = prev?.body ? String(prev.body).slice(-(Number(opts.prevTailChars) || 1400)) : "";
      add(
        "previous",
        "continuity",
        prev
          ? `上章《${prev.title || prev.id || ""}》文末（只承接结果，不重演高潮）:\n${prevTail}`
          : "这是开篇，尚无上章正文。",
        2200
      );
  
      const loops = typeof getActivePlotLoops === "function" ? getActivePlotLoops(project, task, 8) : [];
      add(
        "loops",
        "state",
        loops.length ? loops.map((loop) => `- [${loop.id || "?"}] ${loop.summary}${loop.target ? ` → ${loop.target}` : ""}`).join("\n") : "",
        1800
      );
  
      const style = typeof buildStyleVoiceBlock === "function" ? buildStyleVoiceBlock(project, task) : "";
      add("style", "style", style, 1600);
  
      // RAG 明确标成 reference：它是召回线索，不能覆盖 canon/上章事实。
      const hits = Array.isArray(opts.ragPack?.hits) ? opts.ragPack.hits : [];
      const ragLines = hits
        .slice(0, Number(opts.ragTopK) || 6)
        .map((hit, index) => {
          const type = hit?.meta?.type || "doc";
          const chapterName = hit?.meta?.chapter ? `《${hit.meta.chapter}》` : "";
          return `- ${index + 1}. [${type}${chapterName}] ${String(hit?.text || "").replace(/\s+/g, " ").trim()}`;
        })
        .join("\n");
      add("retrieval", "reference", ragLines, Number(opts.ragMaxChars) || 2600);
  
      const completed = Array.isArray(opts.completedScenes) ? opts.completedScenes : [];
      add(
        "scene-ledger",
        "working",
        completed.length
          ? completed
              .slice(-5)
              .map((scene) => `- ${scene.id || "scene"}: ${scene.outcome || scene.turn || "已完成"}${scene.ledger?.tail ? `｜实际文末:${String(scene.ledger.tail).slice(-120)}` : ""}`)
              .join("\n")
          : "",
        1200
      );
      if (opts.currentDraftText) {
        add(
          "current-draft",
          "working",
          `当前章已存在正文尾部（只承接，不重复已写内容）：\n${String(opts.currentDraftText).slice(-1800)}`,
          2000
        );
      }
      if (opts.previousSceneText) add("previous-scene", "working", `紧邻前场文末:\n${opts.previousSceneText}`, 1800);
      if (opts.instruction) add("author", "author", opts.instruction, 1400);
  
      const priority = [
        "contract",
        "author",
        "canon",
        "previous",
        "state",
        "entities",
        "timeline",
        "loops",
        "style",
        "retrieval",
        "scene-ledger",
        "current-draft",
        "previous-scene",
      ];
      const ordered = priority.map((id) => sections.find((section) => section.id === id)).filter(Boolean);
      const header =
        "【生产证据包】\n可信度规则：locked/continuity/state 是事实依据；reference 只作召回线索；working 是本轮临时状态。发生冲突时，锁定事实与已写正文优先。";
      let usedChars = header.length;
      let usedTokens = estimateTokens(header);
      const used = [];
      const truncated = [];
      const omitted = [];
      const rendered = [header];
      for (const section of ordered) {
        const label = `\n\n【${section.id}|${section.authority}】\n`;
        const roomChars = budget - usedChars - label.length;
        const roomTokens = tokenBudget - usedTokens - estimateTokens(label);
        if (roomChars < 80 || roomTokens < 40) {
          omitted.push(section.id);
          continue;
        }
        const full = section.text;
        const clipped = clipToDualBudget(full, roomChars, roomTokens);
        if (!clipped) {
          omitted.push(section.id);
          continue;
        }
        rendered.push(label + clipped);
        used.push(section.id);
        usedChars += label.length + clipped.length;
        usedTokens += estimateTokens(label) + estimateTokens(clipped);
        if (clipped.length < full.length) truncated.push({ key: section.id, originalChars: full.length, usedChars: clipped.length });
      }
      return {
        user: rendered.join(""),
        sections: ordered,
        meta: {
          budget,
          tokenBudget,
          chars: usedChars,
          tokens: usedTokens,
          used,
          omitted,
          truncated,
          authority: { locked: ["canon"], continuity: ["previous"], state: ["state", "entities", "timeline", "loops"], reference: ["retrieval"] },
        },
      };
    }

    return {
      selectCanonFacts,
      buildProductionEvidencePack,
    };
  }

  return { create };
})();
