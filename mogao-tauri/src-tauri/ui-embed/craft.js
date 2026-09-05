/**
 * Inkwell craft layer: beat plans, opening variety, prose lint, digest gate.
 * Pure enough to run under node --test via vm.
 */
window.NOVEL_CRAFT = (() => {
  "use strict";

  const OPENING_KINDS = Object.freeze([
    "weather",
    "waking",
    "walking",
    "dialogue",
    "expression",
    "other",
  ]);

  const OPENING_LABELS = Object.freeze({
    weather: "天气/夜色起笔",
    waking: "醒来/入梦起笔",
    walking: "赶路/脚步起笔",
    dialogue: "对白起笔",
    expression: "眼神/冷笑起笔",
    other: "其他起笔",
  });

  const STOCK_PHRASES = Object.freeze([
    "嘴角勾起一抹",
    "空气仿佛凝固",
    "目光深邃",
    "心中暗道",
    "不禁",
    "宛如一尊",
    "仿佛时间停滞",
    "冷哼一声",
    "眼神微眯",
    "倒吸一口凉气",
  ]);

  function firstChunk(text, n = 80) {
    return String(text || "")
      .replace(/^\s+/, "")
      .slice(0, n);
  }

  function detectOpeningKind(text) {
    const head = firstChunk(text, 72);
    if (!head.trim()) return "other";
    if (/^[「“"]/.test(head) || /^(?:她|他|我)(?:说|问|道)/.test(head)) return "dialogue";
    if (/雾|夜色|晨光|风雨|大雪|月光|天色/.test(head)) return "weather";
    if (/醒来|睁开|梦魇|从梦/.test(head)) return "waking";
    if (/走[在上路回下]|脚步|迈步|踏上/.test(head)) return "walking";
    if (/眼[神眸]|冷笑|嘴角|眉头/.test(head)) return "expression";
    return "other";
  }

  function recentOpeningKinds(project, task, limit = 3) {
    const currentOrder = Number(task?.order) || Number.MAX_SAFE_INTEGER;
    return (project?.chapters || [])
      .filter(
        (chapter) =>
          String(chapter?.body || "").trim() &&
          chapter?.taskId !== task?.id &&
          (!Number(chapter?.order) || Number(chapter.order) < currentOrder)
      )
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .slice(-Math.max(1, limit))
      .map((chapter) => chapter.openingKind || detectOpeningKind(chapter.body));
  }

  function normalizeBeatPlan(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const scenes = (Array.isArray(src.scenes) ? src.scenes : [])
      .map((scene) => ({
        place: String(scene?.place || scene?.location || "").trim(),
        pov: String(scene?.pov || "").trim(),
        action: String(scene?.action || scene?.what || "").trim(),
        turn: String(scene?.turn || scene?.shift || "").trim(),
        sensory: String(scene?.sensory || scene?.sense || "").trim(),
      }))
      .filter((scene) => scene.place || scene.action)
      .slice(0, 6);
    return {
      chapter_title: String(src.chapter_title || src.title || "").trim(),
      scenes,
      emotion_curve: String(src.emotion_curve || src.curve || "").trim(),
      payoffs: (Array.isArray(src.payoffs) ? src.payoffs : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6),
      avoid: (Array.isArray(src.avoid) ? src.avoid : Array.isArray(src.must_not) ? src.must_not : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 8),
      opening: String(src.opening || src.opening_kind || "").trim(),
      word_target: Number(src.word_target) || 0,
    };
  }

  function buildBeatBlock(plan) {
    const beat = normalizeBeatPlan(plan);
    if (!beat.scenes.length && !beat.emotion_curve && !beat.payoffs.length) return "";
    const scenes = beat.scenes
      .map((scene, index) => {
        const bits = [
          scene.place && `地点:${scene.place}`,
          scene.pov && `视角:${scene.pov}`,
          scene.action && `动作:${scene.action}`,
          scene.turn && `转折:${scene.turn}`,
          scene.sensory && `感官:${scene.sensory}`,
        ].filter(Boolean);
        return `${index + 1}. ${bits.join(" · ")}`;
      })
      .join("\n");
    return [
      "【本章细纲·按场次写，禁止把细纲念给读者】",
      beat.chapter_title ? `标题倾向：${beat.chapter_title}` : "",
      beat.opening ? `开场方式：${beat.opening}` : "",
      scenes ? `场面：\n${scenes}` : "",
      beat.emotion_curve ? `情绪：${beat.emotion_curve}` : "",
      beat.payoffs.length ? `回收/推进：${beat.payoffs.join("；")}` : "",
      beat.avoid.length ? `本章避免：${beat.avoid.join("；")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildOpeningHint(recentKinds) {
    const kinds = (recentKinds || []).filter(Boolean);
    if (!kinds.length) return "";
    const last = kinds[kinds.length - 1];
    const label = OPENING_LABELS[last] || last;
    return `【开场轮换】上一章是${label}。本章禁止再用同一类起笔，改用场面内的具体动作或一句有身份差的对白。`;
  }

  function ngrams(text, n = 2) {
    const chars = String(text || "").replace(/\s+/g, "");
    const grams = [];
    for (let i = 0; i <= chars.length - n; i++) grams.push(chars.slice(i, i + n));
    return grams;
  }

  function overlapRatio(a, b) {
    const left = new Set(ngrams(a, 2));
    const right = ngrams(b, 2);
    if (!left.size || !right.length) return 0;
    let hit = 0;
    for (const gram of right) if (left.has(gram)) hit += 1;
    return hit / right.length;
  }

  function lintProse(opts = {}) {
    const body = String(opts.body || "");
    const prevBody = String(opts.prevBody || "");
    const issues = [];
    if (!body.trim()) return issues;

    const kind = detectOpeningKind(body);
    const recent = Array.isArray(opts.recentKinds) ? opts.recentKinds : [];
    if (recent.includes(kind) && kind !== "other") {
      issues.push({
        type: "repetition",
        severity: "major",
        summary: `开场与近章重复（${OPENING_LABELS[kind] || kind}）`,
        entity: "",
        evidence: firstChunk(body, 40),
        expected: "换一种起笔，不要连章同构",
        suggestion: "从具体动作、物件或一句有信息差的对白切入",
      });
    }

    const prevHead = firstChunk(prevBody, 48);
    const head = firstChunk(body, 48);
    if (prevHead && overlapRatio(prevHead, head) >= 0.42) {
      issues.push({
        type: "repetition",
        severity: "major",
        summary: "章首与上章开头句子过于相似",
        entity: "",
        evidence: head,
        expected: "新章应用不同切入",
        suggestion: "改写前两句，避开上章句式",
      });
    }

    const banned = [
      ...STOCK_PHRASES,
      ...((opts.styleBible?.forbiddenPhrases || []).map((x) => String(x || "").trim()).filter(Boolean)),
    ];
    const seen = new Set();
    for (const phrase of banned) {
      if (!phrase || seen.has(phrase)) continue;
      if (body.includes(phrase)) {
        seen.add(phrase);
        issues.push({
          type: "style",
          severity: "minor",
          summary: `出现套话或禁词「${phrase}」`,
          entity: "",
          evidence: phrase,
          expected: "用具体动作或对白代替套话",
          suggestion: `删掉「${phrase}」，改成这个人物才会做的小事`,
        });
      }
    }

    const starts = body
      .split(/\n+/)
      .map((line) => line.trim().slice(0, 4))
      .filter((line) => line.length >= 2);
    const counts = new Map();
    for (const start of starts) counts.set(start, (counts.get(start) || 0) + 1);
    for (const [start, count] of counts) {
      if (count >= 4) {
        issues.push({
          type: "style",
          severity: "info",
          summary: `过多段落以「${start}」起头`,
          entity: "",
          evidence: start,
          expected: "段落开头有变化",
          suggestion: "打散重复的主语起句",
        });
        break;
      }
    }

    if (opts.beatPlan) {
      const coverage = scoreBeatCoverage(body, opts.beatPlan);
      for (const miss of coverage.missing.slice(0, 3)) {
        issues.push({
          type: "task",
          severity: coverage.rate < 0.4 ? "major" : "minor",
          summary: `细纲场面未落地：${miss.place || "未标地点"}／${miss.action || "未标动作"}`,
          entity: miss.place || "",
          evidence: miss.action || miss.place || "",
          expected: "正文里演完这个场面",
          suggestion: "用具体动作和对白把该场面写出来，不要只总结情绪",
        });
      }
    }

    for (const issue of lintHumanProse(body)) {
      if (!issues.some((item) => item.summary === issue.summary && item.evidence === issue.evidence)) {
        issues.push(issue);
      }
    }

    return issues.slice(0, 12);
  }

  const KEYWORD_STOP = new Set([
    "然后",
    "他们",
    "她们",
    "自己",
    "什么",
    "一个",
    "没有",
    "已经",
    "可以",
    "因为",
    "所以",
    "但是",
    "如果",
    "还是",
    "不是",
    "就是",
    "这个",
    "那个",
    "我们",
    "以及",
    "进行",
    "出现",
    "开始",
    "继续",
    "随后",
    "于是",
  ]);

  const TELL_PHRASES = Object.freeze([
    "心中暗想",
    "心中暗道",
    "不禁想到",
    "感到一阵",
    "心中涌起",
    "显得十分",
    "非常愤怒",
    "非常悲伤",
    "十分激动",
    "内心深处",
    "他知道自己",
    "她知道自己",
    "意识到自己",
    "忍不住心中",
  ]);

  const SENSORY_MARKERS = Object.freeze([
    "气味",
    "腥",
    "铁锈",
    "冷风",
    "潮气",
    "汗",
    "掌心",
    "指腹",
    "耳边",
    "脚步声",
    "心跳",
    "温度",
    "烫",
    "凉",
    "湿",
    "干裂",
    "血腥",
    "酒气",
    "烟",
    "尘土",
    "腥甜",
    "发麻",
    "刺鼻",
  ]);

  function keywordTokens(text) {
    return String(text || "")
      .split(/[\s，。；、·:：/|()（）【】[\]「」""''！？!?]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && !KEYWORD_STOP.has(part));
  }

  function tokenHitsBody(token, hay) {
    if (!token) return false;
    return hay.includes(token);
  }

  function groupCovered(tokens, hay) {
    if (!tokens.length) return true;
    const hits = tokens.filter((token) => tokenHitsBody(token, hay));
    return hits.length / tokens.length >= 0.4;
  }

  function scoreBeatCoverage(body, plan) {
    const hay = String(body || "").replace(/\s+/g, "");
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    if (!scenes.length) {
      return { rate: 0, covered: 0, total: 0, missing: [] };
    }
    const rows = scenes.map((scene, index) => {
      const placeTokens = keywordTokens(scene.place);
      const actionTokens = keywordTokens(scene.action);
      const placeHits = placeTokens.filter((token) => tokenHitsBody(token, hay));
      const actionHits = actionTokens.filter((token) => tokenHitsBody(token, hay));
      const covered =
        placeTokens.length + actionTokens.length === 0 ||
        (groupCovered(placeTokens, hay) && groupCovered(actionTokens, hay));
      return {
        index,
        place: String(scene.place || "").trim(),
        action: String(scene.action || "").trim(),
        covered,
        hits: [...placeHits, ...actionHits],
        tokens: [...placeTokens, ...actionTokens],
      };
    });
    const covered = rows.filter((row) => row.covered).length;
    return {
      rate: covered / scenes.length,
      covered,
      total: scenes.length,
      missing: rows
        .filter((row) => !row.covered)
        .map(({ index, place, action }) => ({ index, place, action })),
    };
  }

  function dialogueRate(body) {
    const text = String(body || "");
    const chars = text.replace(/\s+/g, "").length;
    if (!chars) return 0;
    let spoken = 0;
    const re = /[「“"]([^」”"]+)[」”"]/g;
    let match;
    while ((match = re.exec(text))) spoken += String(match[1] || "").replace(/\s+/g, "").length;
    return spoken / chars;
  }

  function countSensory(body) {
    const text = String(body || "");
    let count = 0;
    for (const marker of SENSORY_MARKERS) {
      if (text.includes(marker)) count += 1;
    }
    return count;
  }

  function lintHumanProse(body) {
    const text = String(body || "");
    const compact = text.replace(/\s+/g, "");
    const issues = [];
    if (compact.length >= 400 && dialogueRate(text) < 0.06) {
      issues.push({
        type: "style",
        severity: "minor",
        summary: "对白过少，读起来像在转述",
        entity: "",
        evidence: compact.slice(0, 24),
        expected: "用对话推进冲突",
        suggestion: "把至少一处心理总结改成有身份差的对白",
      });
    }
    const seen = new Set();
    for (const phrase of TELL_PHRASES) {
      if (!text.includes(phrase) || seen.has(phrase)) continue;
      seen.add(phrase);
      issues.push({
        type: "style",
        severity: "minor",
        summary: `情绪总结句「${phrase}」`,
        entity: "",
        evidence: phrase,
        expected: "用动作或对白代替告知",
        suggestion: `删掉「${phrase}」，改成这个人物会做的小事`,
      });
    }
    if (compact.length >= 400 && countSensory(text) === 0) {
      issues.push({
        type: "style",
        severity: "info",
        summary: "缺少可被闻到或碰到的感官细节",
        entity: "",
        evidence: compact.slice(0, 24),
        expected: "每个场面至少一处具体感官",
        suggestion: "补一个温度、气味、触感或声响",
      });
    }
    return issues;
  }

  function buildUncoveredBeatHint(coverage) {
    const missing = Array.isArray(coverage?.missing) ? coverage.missing : [];
    if (!missing.length) return "";
    const lines = missing
      .slice(0, 4)
      .map((item, index) => `${index + 1}. ${item.place || "未标地点"}：${item.action || "未写动作"}`);
    return `【上章未落地场面·本章用余波补一句，不要整场重演】\n${lines.join("\n")}`;
  }

  function scoreChapterCraft(body, plan, opts = {}) {
    const issues = lintProse({
      body,
      prevBody: opts.prevBody || "",
      recentKinds: opts.recentKinds || [],
      styleBible: opts.styleBible,
      beatPlan: plan,
    });
    return {
      openingKind: detectOpeningKind(body),
      beatCoverage: scoreBeatCoverage(body, plan),
      dialogueRate: dialogueRate(body),
      sensoryCount: countSensory(body),
      issues,
      at: Date.now(),
    };
  }

  /**
   * 从作者已经接受的章节提炼可解释的风格轮廓。
   * 这是统计校准，不是让模型复制旧文；生产引擎把它作为软约束注入每个场面，
   * 用来抑制“每章都像同一个模板”的节奏漂移。
   */
  function deriveStyleProfile(chapters, opts = {}) {
    const rows = (Array.isArray(chapters) ? chapters : [])
      .filter((chapter) => {
        if (!String(chapter?.body || "").trim()) return false;
        const status = String(chapter?.production?.status || "");
        return !status || ["accepted", "accepted_pending_handoff", "done"].includes(status);
      })
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .slice(-(Math.max(1, Number(opts.limit) || 6)));
    if (!rows.length) return null;
    let chars = 0;
    let paragraphs = 0;
    let sentences = 0;
    let sentenceChars = 0;
    let dialogueChars = 0;
    let sensory = 0;
    for (const chapter of rows) {
      const body = String(chapter.body || "");
      const compact = body.replace(/\s+/g, "");
      chars += compact.length;
      paragraphs += body.split(/\n+/).filter((line) => line.trim()).length;
      const chunks = compact.split(/[。！？!?；;]/).filter(Boolean);
      sentences += chunks.length;
      sentenceChars += chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      dialogueChars += [...compact.matchAll(/[「“"]([^」”"]+)[」”"]/g)].reduce((sum, match) => sum + String(match[1] || "").length, 0);
      sensory += countSensory(body);
    }
    const avgParagraph = paragraphs ? Math.round(chars / paragraphs) : 0;
    const avgSentence = sentences ? Math.round(sentenceChars / sentences) : 0;
    const dialogue = chars ? Math.round((dialogueChars / chars) * 100) : 0;
    const sensoryPerK = chars ? Math.round((sensory / chars) * 1000 * 10) / 10 : 0;
    return {
      schemaVersion: 1,
      sampleChapters: rows.length,
      chars,
      averageParagraphChars: avgParagraph,
      averageSentenceChars: avgSentence,
      dialogueRate: dialogue / 100,
      sensoryPerThousandChars: sensoryPerK,
      rhythm: avgParagraph && avgParagraph < 70 ? "短段落" : avgParagraph > 150 ? "长段落" : "中等段落",
      guidance: [
        `段落以${avgParagraph ? `${avgParagraph}字左右` : "适中"}为中位节奏（${avgParagraph && avgParagraph < 70 ? "保持切段" : "避免连续大段"}）`,
        `对白约占${dialogue}%；对白必须带来信息或选择，不为凑比例`,
        `每千字约${sensoryPerK}个感官锚点，优先具体物件/声音/触感`,
        `句子中位约${avgSentence || "适中"}字，长短句交替而非机械等长`,
      ],
      at: Date.now(),
    };
  }

  function evidenceInBody(evidence, body) {
    const ev = String(evidence || "").replace(/\s+/g, "");
    if (ev.length < 2) return false;
    const hay = String(body || "").replace(/\s+/g, "");
    if (hay.includes(ev.slice(0, Math.min(ev.length, 16)))) return true;
    return overlapRatio(hay.slice(0, 800) + hay.slice(-800), ev) >= 0.5;
  }

  function validateDigest(project, digest, body, ctx = null) {
    const src = digest && typeof digest === "object" ? digest : {};
    const dropped = [];
    const compare = ctx?.compareCanonValues;
    const locked = new Map(
      (project?.detailCanon?.facts || [])
        .filter((fact) => fact && fact.locked !== false && fact.status !== "superseded")
        .map((fact) => [String(fact.key || "").trim(), fact])
    );

    const keptFacts = [];
    for (const raw of Array.isArray(src.canon_facts) ? src.canon_facts : []) {
      if (!raw || typeof raw !== "object") continue;
      const key = String(raw.key || "").trim();
      const value = String(raw.value ?? "").trim();
      if (!key || !value) {
        dropped.push({ reason: "empty", key, value });
        continue;
      }
      const evidence = String(raw.evidence || "").trim();
      if (!evidence || !evidenceInBody(evidence, body)) {
        dropped.push({ reason: "no_evidence", key, value, evidence });
        continue;
      }
      const existing = locked.get(key);
      if (existing && typeof compare === "function") {
        const same = compare(existing.value, value);
        if (same && same.equal === false && existing.dynamic !== true) {
          dropped.push({
            reason: "locked_conflict",
            key,
            value,
            kept: existing.value,
          });
          continue;
        }
      }
      keptFacts.push(raw);
    }

    return {
      canon_facts: keptFacts,
      abandoned_loops: Array.isArray(src.abandoned_loops) ? src.abandoned_loops : [],
      dropped,
    };
  }

  const PACE_PROFILES = Object.freeze({
    idle: { id: "idle", label: "闲笔/过渡", scenesMin: 2, scenesMax: 3, wordTarget: 1400 },
    build: { id: "build", label: "推进", scenesMin: 3, scenesMax: 4, wordTarget: 2000 },
    climax: { id: "climax", label: "高潮", scenesMin: 4, scenesMax: 5, wordTarget: 2600 },
  });

  function volumePosition(project, order) {
    const vols = project?.spine?.volumes || [];
    let acc = 0;
    for (const volume of vols) {
      const total = Number(volume.chapters || volume.chapter_count || volume.count) || 0;
      if (total > 0 && order > acc && order <= acc + total) {
        return { index: order - acc, total, volume };
      }
      acc += total;
    }
    const total = (project?.tasks || []).length || Number(project?.targetChapters) || 0;
    return { index: order, total, volume: null };
  }

  function classifyChapterPace(task, project) {
    const blob = [
      task?.chapter_title,
      task?.goal,
      task?.conflict,
      task?.hook_end,
      ...(Array.isArray(task?.beats) ? task.beats : []),
    ]
      .filter(Boolean)
      .join(" ");
    if (/高潮|决战|摊牌|揭穿|大比决赛|终局|破局|对决/.test(blob)) return "climax";
    if (/闲笔|过渡|日常|休整|铺垫|喘息/.test(blob)) return "idle";
    const order = Number(task?.order) || 0;
    const pos = volumePosition(project, order);
    if (pos.total >= 4) {
      if (pos.index >= pos.total || pos.index / pos.total >= 0.85) return "climax";
      if (pos.index <= 2 || pos.index / pos.total <= 0.22) return "idle";
    }
    return "build";
  }

  function paceProfile(kind) {
    return PACE_PROFILES[kind] || PACE_PROFILES.build;
  }

  function applyPaceToTask(task, project) {
    if (!task || typeof task !== "object") return paceProfile("build");
    const kind = classifyChapterPace(task, project);
    const profile = paceProfile(kind);
    task.paceKind = kind;
    if (!task.word_target_locked) task.word_target = profile.wordTarget;
    return profile;
  }

  function buildDiscipline(openingHint) {
    const extra = openingHint ? `\n8. ${openingHint.replace(/^【开场轮换】/, "")}` : "";
    return `【连贯性纪律】
1. 先确认【故事线位置】与【推进方向】，再按【本章细纲】场次落笔；数字/专名以【细节设定文档】与【RAG检索】为准。
2. RAG 命中的既有正文/设定若与任务卡冲突，以「已写正文+锁定细节」为准，任务卡只决定本章新推进。
3. 已确立事实不得无故推翻；能力/药方按状态递进，禁止每章「第一次终极进化」。
4. 上章高潮只写后果与余波，禁止重演。
5. 细纲每个场面必须在正文落地，禁止只写情绪总结。
6. 用对白和具体感官推进冲突，少用「他知道/心中涌起」。
7. 只输出正文，不要大纲、不要分析、不要自我解释。${extra}`;
  }

  return {
    OPENING_KINDS,
    OPENING_LABELS,
    STOCK_PHRASES,
    detectOpeningKind,
    recentOpeningKinds,
    normalizeBeatPlan,
    buildBeatBlock,
    buildOpeningHint,
    lintProse,
    scoreBeatCoverage,
    dialogueRate,
    countSensory,
    lintHumanProse,
    buildUncoveredBeatHint,
    scoreChapterCraft,
    deriveStyleProfile,
    validateDigest,
    buildDiscipline,
    overlapRatio,
    PACE_PROFILES,
    volumePosition,
    classifyChapterPace,
    paceProfile,
    applyPaceToTask,
  };
})();
