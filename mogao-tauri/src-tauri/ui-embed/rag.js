/**
 * Inkwell 本地混合 RAG（Hybrid Lexical RAG）
 *
 * 设计对齐 2024–2025 长篇连载实践：
 * - 分层语料：原文块 / 章摘要 / 细节 canon / 人物卡 / 世界观 / 故事线
 * - 混合检索：BM25 词法 + 元数据加权（类型、近章、实体命中）
 * - 可选：经 gemini2api 的 embedding 向量检索（cfg.ragUseEmbeddings）
 * - 无外部向量库依赖，索引落在 project.ragIndex → 记忆/rag-index.json
 *
 * 参考模式：Hierarchical memory + Story Bible retrieval + hybrid BM25/dense
 */
window.NOVEL_RAG = (() => {
  const K = 1.2;
  const B = 0.75;

  function tokenize(text) {
    const s = String(text || "").toLowerCase();
    // 中英混合：连续汉字按 2-gram + 单字；英文按词
    const tokens = [];
    const en = s.match(/[a-z0-9_]+/g) || [];
    tokens.push(...en);
    const cn = s.replace(/[a-z0-9_\s]+/g, " ");
    for (const seg of cn.split(/\s+/)) {
      if (!seg) continue;
      if (seg.length === 1) tokens.push(seg);
      else {
        for (let i = 0; i < seg.length; i++) tokens.push(seg[i]);
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
      }
    }
    return tokens.filter((t) => t && t.length > 0);
  }

  function docId(prefix, i, extra = "") {
    return `${prefix}_${i}${extra ? "_" + extra : ""}`.replace(/\s+/g, "");
  }

  function chunkText(text, size = 420, overlap = 60) {
    const t = String(text || "").trim();
    if (!t) return [];
    if (t.length <= size) return [t];
    const out = [];
    let i = 0;
    while (i < t.length) {
      out.push(t.slice(i, i + size));
      i += Math.max(40, size - overlap);
    }
    return out;
  }

  /**
   * 从 project 构建可检索文档列表
   */
  function collectDocuments(project) {
    const docs = [];
    let n = 0;

    // 1) 细节设定 canon（最高权威小块）
    for (const f of project.detailCanon?.facts || []) {
      if (!f?.key || f.status === "superseded") continue;
      docs.push({
        id: docId("canon", n++, f.key),
        text: `${f.key} = ${f.value}。实体:${f.entity || ""}。类别:${f.category || ""}。证据:${f.evidence || ""}。首见:${f.firstChapter || ""}`,
        meta: {
          type: "canon",
          key: f.key,
          entity: f.entity || "",
          category: f.category || "other",
          chapter: f.lastChapter || f.firstChapter || "",
          weight: 2.4,
        },
      });
    }

    // 2) 故事线 / 状态
    const sl = project.storyline || {};
    if (sl.positionSummary || sl.lastSummary || sl.nextDirection) {
      docs.push({
        id: docId("storyline", 0),
        text: `故事线位置:${sl.positionSummary || ""}。上章概要:${sl.lastSummary || ""}。推进方向:${sl.nextDirection || ""}。下一任务:${sl.nextTaskId || ""} ${sl.nextTaskGoal || ""}`,
        meta: { type: "storyline", weight: 2.0 },
      });
    }
    for (const log of (sl.chapterLogs || []).slice(-20)) {
      docs.push({
        id: docId("slog", n++, String(log.order || "")),
        text: `第${log.order}章 ${log.chapter || ""}。概要:${log.summary || ""}。位置:${log.position || ""}。方向:${log.nextDirection || ""}`,
        meta: { type: "chapter_log", order: log.order || 0, chapter: log.chapter || "", weight: 1.6 },
      });
    }

    const st = project.storyState || {};
    if (st.protagonistState || st.powerOrSystem || (st.openLoops || []).length) {
      docs.push({
        id: docId("state", 0),
        text: `主角状态:${st.protagonistState || ""}。能力:${st.powerOrSystem || ""}。地点:${st.location || ""}。时间:${st.timeline || ""}。钩子:${(st.openLoops || []).join("；")}。事实:${(st.establishedFacts || []).join("；")}`,
        meta: { type: "story_state", weight: 1.8 },
      });
    }

    // 独立钩子账本：不受 memoryRoll 40 章窗口影响；已解决项保留为低权重历史证据。
    for (const loop of project.plotLoops || []) {
      if (!loop?.summary) continue;
      docs.push({
        id: docId("loop", n++, loop.id || ""),
        text: `钩子:${loop.summary}。状态:${loop.status || "open"}。首次:${loop.openedChapter || ""}。最近:${
          loop.lastChapter || ""
        }。目标:${loop.target || ""}。证据:${loop.resolutionEvidence || loop.evidence || ""}`,
        meta: {
          type: "plot_loop",
          loopId: loop.id || "",
          status: loop.status || "open",
          order: loop.lastOrder || loop.openedOrder || 0,
          chapter: loop.lastChapter || loop.openedChapter || "",
          weight: ["open", "deferred"].includes(loop.status) ? 1.9 : 0.7,
        },
      });
    }

    for (const issue of project.continuityIssues || []) {
      if (!issue?.summary) continue;
      docs.push({
        id: docId("issue", n++, issue.id || ""),
        text: `连续性风险:${issue.summary}。类型:${issue.type || "general"}。级别:${issue.severity || "major"}。状态:${
          issue.status || "open"
        }。实体:${issue.entity || ""}。证据:${issue.evidence || ""}。建议:${issue.suggestion || ""}`,
        meta: {
          type: "continuity_issue",
          issueId: issue.id || "",
          status: issue.status || "open",
          order: issue.lastOrder || issue.firstOrder || 0,
          chapter: issue.lastChapter || issue.firstChapter || "",
          weight: issue.status === "open" ? (issue.severity === "blocker" ? 2.2 : 1.8) : 0.5,
        },
      });
    }

    for (const state of Object.values(project.entityStates || {})) {
      if (!state?.entity) continue;
      docs.push({
        id: docId("estate", n++, state.entity),
        text: `实体:${state.entity}。类型:${state.type || ""}。位置:${state.location || ""}。状态:${
          state.condition || state.status || ""
        }。能力:${state.power || ""}。阵营:${state.faction || ""}。持有:${(state.possessions || []).join("、")}。证据:${
          state.evidence || ""
        }`,
        meta: {
          type: "entity_state",
          entity: state.entity,
          order: state.lastOrder || 0,
          chapter: state.lastChapter || "",
          weight: 1.9,
        },
      });
    }

    for (const event of (project.timelineEvents || []).slice(-80)) {
      if (!event?.event) continue;
      docs.push({
        id: docId("timeline", n++, event.id || ""),
        text: `时间:${event.time || ""}。事件:${event.event}。地点:${event.location || ""}。实体:${(
          event.entities || []
        ).join("、")}。证据:${event.evidence || ""}`,
        meta: {
          type: "timeline_event",
          order: event.order || 0,
          chapter: event.chapter || "",
          weight: 1.7,
        },
      });
    }

    const style = project.styleBible || {};
    if (Object.values(style).some((x) => (Array.isArray(x) ? x.length : String(x || "").trim()))) {
      docs.push({
        id: docId("style", 0),
        text: `风格:视角${style.pov || ""}；时态${style.tense || ""}；节奏${style.pacing || ""}；对白${
          style.dialogue || ""
        }；规则${(style.rules || []).join("；")}；禁用${(style.forbiddenPhrases || []).join("；")}`,
        meta: { type: "style_bible", weight: 1.5 },
      });
    }

    // 3) 滚动摘要
    (project.memoryRoll || []).forEach((m, i) => {
      if (typeof m === "string") {
        docs.push({ id: docId("mem", i), text: m, meta: { type: "digest", weight: 1.5 } });
        return;
      }
      const text = [
        m.chapter || "",
        m.summary || "",
        (m.happened || []).join("；"),
        (m.must_carry || []).join("；"),
        (m.new_info || []).join("；"),
        (m.open_loops || []).join("；"),
        m.state || "",
        m.power_or_system || "",
        m.next_direction || "",
        m.storyline_position || "",
      ]
        .filter(Boolean)
        .join("。");
      docs.push({
        id: docId("mem", i, m.taskId || ""),
        text,
        meta: {
          type: "digest",
          chapter: m.chapter || "",
          order: m.order || 0,
          taskId: m.taskId || "",
          weight: 1.7,
        },
      });
    });

    // 4) 人物卡
    for (const node of project.graph?.nodes || []) {
      if (!node?.label) continue;
      docs.push({
        id: docId("char", n++, node.id || node.label),
        text: `人物:${node.label}。别名:${(node.aliases || []).join("、")}。角色:${node.role || ""}。阵营:${node.sect || ""}。弧光:${node.arc || ""}。欲望:${node.want || ""}。备注:${node.note || ""}。声口:${node.voice || ""}`,
        meta: { type: "character", entity: node.label, id: node.id, weight: 1.5 },
      });
    }

    // 5) 世界观
    const w = project.world;
    if (w && typeof w === "object") {
      docs.push({
        id: docId("world", 0),
        text: `时代:${w.era || ""}。体系:${w.power_system || ""}。规则:${(w.rules || []).join("；")}。禁忌:${(w.taboos || []).join("；")}。秘密:${(w.secrets || []).join("；")}。势力:${(w.factions || [])
          .map((f) => (typeof f === "string" ? f : f.name))
          .filter(Boolean)
          .join("、")}`,
        meta: { type: "world", weight: 1.3 },
      });
    }

    // 6) 锁定主线
    const locks = project.locks || {};
    docs.push({
      id: docId("lock", 0),
      text: `主线:${locks.logline || project.spine?.logline || project.pitch || ""}。禁区:${(locks.forbidden || []).join("；")}。必须兑现:${(locks.mustHonor || []).join("；")}`,
      meta: { type: "lock", weight: 1.4 },
    });

    // 7) 章节正文块（近章加权在检索时做）
    const chapters = (project.chapters || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const ch of chapters) {
      const body = String(ch.body || "").trim();
      if (!body) continue;
      const parts = chunkText(body, 400, 50);
      parts.forEach((part, pi) => {
        docs.push({
          id: docId("ch", ch.order || 0, `${pi}`),
          text: part,
          meta: {
            type: "chapter_body",
            chapter: ch.title || "",
            order: ch.order || 0,
            taskId: ch.taskId || "",
            weight: 1.0,
          },
        });
      });
    }

    // 8) 出场记录
    for (const a of project.appearanceLog || []) {
      docs.push({
        id: docId("app", a.order || n++, a.taskId || ""),
        text: `出场 #${a.order} ${a.chapter || ""}。人物:${(a.characters || []).join("、")}。地点:${(a.locations || []).join("、")}。道具:${(a.items || []).join("、")}。势力:${(a.factions || []).join("、")}`,
        meta: { type: "appearance", order: a.order || 0, chapter: a.chapter || "", weight: 1.2 },
      });
    }

    return docs;
  }

  function buildIndex(docs) {
    const inverted = Object.create(null);
    const docLen = [];
    let totalLen = 0;
    docs.forEach((d, i) => {
      const toks = tokenize(d.text);
      docLen[i] = toks.length || 1;
      totalLen += docLen[i];
      const tf = Object.create(null);
      for (const t of toks) tf[t] = (tf[t] || 0) + 1;
      d._tf = tf;
      for (const t of Object.keys(tf)) {
        if (!inverted[t]) inverted[t] = [];
        inverted[t].push(i);
      }
    });
    return {
      version: 2,
      builtAt: Date.now(),
      docs,
      inverted,
      docLen,
      avgdl: docs.length ? totalLen / docs.length : 1,
      N: docs.length,
    };
  }

  /**
   * Deterministic content signature. Length-only signatures miss edits where
   * text is replaced by text of the same size, leaving retrieval results stale.
   */
  function contentSignature(docs) {
    let fnv = 0x811c9dc5;
    let djb = 0x1505;
    const feed = (value) => {
      const text = String(value ?? "");
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        fnv ^= code;
        fnv = Math.imul(fnv, 0x01000193);
        djb = (Math.imul(djb, 33) ^ code) >>> 0;
      }
      fnv ^= 0xff;
      fnv = Math.imul(fnv, 0x01000193);
    };
    for (const doc of docs || []) {
      feed(doc?.id);
      feed(doc?.text);
      feed(JSON.stringify(doc?.meta || {}));
    }
    return `v3:${(docs || []).length}:${(fnv >>> 0).toString(16).padStart(8, "0")}${djb
      .toString(16)
      .padStart(8, "0")}`;
  }

  function bm25Score(index, docIdx, queryTf) {
    const dlen = index.docLen[docIdx] || 1;
    const tfMap = index.docs[docIdx]._tf || {};
    let score = 0;
    for (const term of Object.keys(queryTf)) {
      const fre = (index.inverted[term] || []).length;
      if (!fre) continue;
      const idf = Math.log(1 + (index.N - fre + 0.5) / (fre + 0.5));
      const f = tfMap[term] || 0;
      if (!f) continue;
      const denom = f + K * (1 - B + B * (dlen / (index.avgdl || 1)));
      score += idf * ((f * (K + 1)) / denom) * queryTf[term];
    }
    return score;
  }

  function metaBoost(meta, queryText, opts = {}) {
    let w = Number(meta?.weight) || 1;
    const q = String(queryText || "");
    // 类型偏好：写章时 canon/digest/storyline 更重要
    const prefer = opts.preferTypes || {
      canon: 1.35,
      storyline: 1.25,
      story_state: 1.2,
      digest: 1.15,
      character: 1.1,
      chapter_log: 1.1,
      chapter_body: 1.0,
      world: 0.95,
    };
    w *= prefer[meta?.type] || 1;

    // 近章加权
    const curOrder = Number(opts.currentOrder) || 0;
    const ord = Number(meta?.order) || 0;
    if (curOrder && ord) {
      const dist = Math.abs(curOrder - ord);
      if (dist === 0) w *= 0.5; // 当前章自己（续写时）降权，避免只检索到自己
      else if (dist === 1) w *= 1.35;
      else if (dist <= 3) w *= 1.15;
      else if (dist > 15) w *= 0.85;
    }

    // 实体名出现在 query 中
    if (meta?.entity && q.includes(meta.entity)) w *= 1.4;
    if (meta?.key && q.includes(String(meta.key).split(".")[0])) w *= 1.25;

    return w;
  }

  /**
   * 多查询检索
   */
  function retrieve(index, queries, opts = {}) {
    if (!index?.docs?.length) return [];
    const topK = opts.topK || window.NOVEL_DEFAULTS?.ragTopK || 8;
    const scores = new Map();

    const qList = Array.isArray(queries) ? queries : [queries];
    for (const q of qList) {
      const qText = String(q || "").trim();
      if (!qText) continue;
      const qTokens = tokenize(qText);
      const queryTf = Object.create(null);
      for (const t of qTokens) queryTf[t] = (queryTf[t] || 0) + 1;

      // 候选：至少命中一个 query term
      const cand = new Set();
      for (const t of Object.keys(queryTf)) {
        for (const di of index.inverted[t] || []) cand.add(di);
      }
      // 若太少，全库扫（小 N 可接受）
      if (cand.size < 8) {
        for (let i = 0; i < index.docs.length; i++) cand.add(i);
      }

      for (const di of cand) {
        const base = bm25Score(index, di, queryTf);
        if (base <= 0) continue;
        const doc = index.docs[di];
        const boost = metaBoost(doc.meta, qText, opts);
        const s = base * boost;
        const prev = scores.get(di) || 0;
        // 多 query 取 max + 0.15*sum 鼓励多角度命中
        scores.set(di, Math.max(prev, s) + s * 0.15);
      }
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([di, score]) => ({
        id: index.docs[di].id,
        text: index.docs[di].text,
        meta: index.docs[di].meta,
        score: Math.round(score * 1000) / 1000,
      }));

    return ranked;
  }

  /**
   * 从任务卡构造多查询（Agentic RAG 的 query decomposition 轻量版）
   */
  function buildQueriesFromTask(project, task) {
    const queries = [];
    if (!task) return queries;
    queries.push([task.chapter_title, task.goal, task.conflict].filter(Boolean).join(" "));
    if (task.beats?.length) queries.push(task.beats.join(" "));
    if (task.must_include?.length) queries.push(task.must_include.join(" "));
    if (task.pov) queries.push(`人物 ${task.pov} 状态 关系`);
    // 开放钩子
    const activeLoopRecords = (project.plotLoops || []).filter((x) => ["open", "deferred"].includes(x?.status));
    const loops = (activeLoopRecords.length
      ? activeLoopRecords.map((x) => x.summary)
      : project.storyState?.openLoops || []
    ).slice(0, 5);
    if (loops.length) queries.push(loops.join(" "));
    // 故事线方向
    if (project.storyline?.nextDirection) queries.push(project.storyline.nextDirection);
    if (project.storyline?.lastSummary) queries.push(project.storyline.lastSummary);
    // 人物别名与一跳关系：任务只写别称时仍能召回人物卡和关系另一端。
    const taskBlobWithSpaces = [task.chapter_title, task.goal, task.conflict, ...(task.beats || []), ...(task.must_include || [])]
      .filter(Boolean)
      .join(" ");
    const graphNodes = project.graph?.nodes || [];
    const matchedIds = new Set();
    for (const node of graphNodes) {
      const names = [node.label, ...(node.aliases || [])].filter(Boolean);
      if (names.some((name) => taskBlobWithSpaces.includes(name))) {
        matchedIds.add(node.id);
        queries.push(`人物 ${names.join(" ")} ${node.sect || ""} ${node.role || ""} ${node.voice || ""}`);
      }
    }
    for (const edge of project.graph?.edges || []) {
      if (!matchedIds.has(edge.source) && !matchedIds.has(edge.target)) continue;
      const source = graphNodes.find((x) => x.id === edge.source)?.label || edge.source || "";
      const target = graphNodes.find((x) => x.id === edge.target)?.label || edge.target || "";
      queries.push(`${source} ${edge.relationship || "关系"} ${target}`);
    }
    // 从 goal 抽可能实体（2-4 字连续中文当候选）
    const blob = `${task.goal || ""}${task.conflict || ""}${(task.must_include || []).join("")}`;
    const entities = blob.match(/[\u4e00-\u9fff]{2,4}/g) || [];
    const uniq = [...new Set(entities)].slice(0, 6);
    for (const e of uniq) queries.push(`${e} 设定 粉丝 身份 关系 状态`);
    return queries.filter((q) => String(q).trim().length >= 2).slice(0, 12);
  }

  function ensureIndex(project, force = false) {
    const docs = collectDocuments(project);
    const sig = contentSignature(docs);
    if (!force && project.ragIndex && project.ragIndex._sig === sig && project.ragIndex.docs?.length) {
      if (project.ragIndex.inverted && project.ragIndex.docLen && project.ragIndex.N != null) {
        return project.ragIndex;
      }
      const hydrated = deserializeIndex(project.ragIndex);
      project.ragIndex = hydrated;
      project.ragIndexMeta = {
        builtAt: hydrated.builtAt,
        docs: hydrated.N,
        sig,
      };
      return hydrated;
    }
    const index = buildIndex(docs);
    index._sig = sig;
    // 持久化时去掉 _tf 可减小体积——但检索需要 _tf；保存时再 strip
    project.ragIndex = index;
    project.ragIndexMeta = {
      builtAt: index.builtAt,
      docs: index.N,
      sig,
    };
    return index;
  }

  /** 保存用精简索引（无 inverted 可重建）——存 docs 即可 */
  function serializeIndex(index) {
    if (!index) return null;
    return {
      version: index.version || 2,
      builtAt: index.builtAt,
      _sig: index._sig,
      docs: (index.docs || []).map((d) => ({
        id: d.id,
        text: d.text,
        meta: d.meta,
      })),
    };
  }

  function deserializeIndex(raw) {
    if (!raw?.docs?.length) return null;
    const index = buildIndex(raw.docs);
    index.version = raw.version || index.version;
    index.builtAt = raw.builtAt || index.builtAt;
    index._sig = raw._sig || contentSignature(raw.docs);
    return index;
  }

  function formatHitsForPrompt(hits, maxChars = 3200) {
    if (!hits?.length) return "【RAG检索】（未命中既有语料；仅依赖任务卡与上章衔接）";
    const lines = ["【RAG检索·与本章相关的既有细节/正文/设定】", "规则：下列为已写内容检索结果，数字与专名必须与此一致，禁止无故改写。"];
    let used = lines.join("\n").length;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const tag = h.meta?.type || "doc";
      const ch = h.meta?.chapter ? `《${h.meta.chapter}》` : "";
      const head = `${i + 1}. [${tag}${ch ? " " + ch : ""} score=${h.score}] `;
      let body = String(h.text || "").replace(/\s+/g, " ").trim();
      const room = maxChars - used - head.length - 10;
      if (room < 40) break;
      if (body.length > room) body = body.slice(0, room) + "…";
      const line = head + body;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  /**
   * 一站式：确保索引 + 多查询检索 + 格式化
   */
  function retrieveForChapter(project, task, opts = {}) {
    const index = ensureIndex(project, opts.forceReindex);
    const queries = opts.queries || buildQueriesFromTask(project, task);
    const hits = retrieve(index, queries, {
      topK: opts.topK || window.NOVEL_DEFAULTS?.ragTopK || 8,
      currentOrder: Number(task?.order) || 0,
      preferTypes: opts.preferTypes,
    });
    return {
      queries,
      hits,
      promptBlock: formatHitsForPrompt(hits, opts.maxChars || window.NOVEL_DEFAULTS?.ragMaxChars || 3200),
      indexSize: index.N,
    };
  }

  /**
   * 可选：用远程 embedding 增强（gemini2api）。失败则静默回退 BM25。
   * 期望 API: POST /v1/embeddings { model, input: string[] }
   */
  async function embedTexts(cfg, texts, { signal } = {}) {
    const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
    const model = cfg.embeddingModel || "text-embedding-004";
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
        "x-api-key": cfg.apiKey || "",
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const data = await res.json();
    const arr = data.data || data.embeddings || [];
    return arr.map((x) => x.embedding || x);
  }

  function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function buildDenseCandidatePool(index, lexicalHits, task, candidateK = 48) {
    const cap = Math.max(8, Number(candidateK) || 48);
    const selected = [];
    const seen = new Set();
    const add = (hit) => {
      if (!hit?.id || seen.has(hit.id) || selected.length >= cap) return;
      seen.add(hit.id);
      selected.push(hit);
    };
    for (const hit of lexicalHits || []) add(hit);

    const currentOrder = Number(task?.order) || 0;
    const docs = (index?.docs || []).map((doc) => ({ id: doc.id, text: doc.text, meta: doc.meta, score: 0 }));
    const typeCaps = {
      canon: 10,
      entity_state: 8,
      plot_loop: 6,
      continuity_issue: 6,
      storyline: 2,
      story_state: 2,
      style_bible: 2,
      digest: 8,
      timeline_event: 8,
    };
    for (const [type, typeCap] of Object.entries(typeCaps)) {
      const group = docs
        .filter((x) => x.meta?.type === type)
        .sort((a, b) => {
          const ad = currentOrder && a.meta?.order ? Math.abs(currentOrder - Number(a.meta.order)) : 9999;
          const bd = currentOrder && b.meta?.order ? Math.abs(currentOrder - Number(b.meta.order)) : 9999;
          return ad - bd || (Number(b.meta?.weight) || 1) - (Number(a.meta?.weight) || 1);
        })
        .slice(0, typeCap);
      for (const hit of group) add(hit);
    }

    const nearbyBodies = docs
      .filter((x) => x.meta?.type === "chapter_body")
      .sort((a, b) => {
        const ad = currentOrder ? Math.abs(currentOrder - Number(a.meta?.order || 0)) : Number.MAX_SAFE_INTEGER;
        const bd = currentOrder ? Math.abs(currentOrder - Number(b.meta?.order || 0)) : Number.MAX_SAFE_INTEGER;
        return ad - bd || Number(b.meta?.order || 0) - Number(a.meta?.order || 0);
      })
      .slice(0, 16);
    for (const hit of nearbyBodies) add(hit);
    for (const hit of docs) add(hit);
    return selected;
  }

  function selectDiverseHits(hits, topK) {
    const limit = Math.max(1, Number(topK) || 8);
    const caps = {
      chapter_body: Math.max(2, Math.ceil(limit * 0.5)),
      canon: Math.max(2, Math.ceil(limit * 0.4)),
      digest: Math.max(1, Math.ceil(limit * 0.3)),
      timeline_event: 2,
      entity_state: 3,
    };
    const counts = Object.create(null);
    const out = [];
    const deferred = [];
    for (const hit of hits || []) {
      const type = hit.meta?.type || "other";
      const cap = caps[type] || limit;
      if ((counts[type] || 0) >= cap) {
        deferred.push(hit);
        continue;
      }
      counts[type] = (counts[type] || 0) + 1;
      out.push(hit);
      if (out.length >= limit) return out;
    }
    for (const hit of deferred) {
      out.push(hit);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function retrieveHybrid(project, task, cfg, opts = {}) {
    const lexical = retrieveForChapter(project, task, opts);
    if (!cfg?.ragUseEmbeddings) return { ...lexical, mode: "bm25" };

    try {
      const index = ensureIndex(project);
      const candidateK = cfg.ragDenseCandidateK || window.NOVEL_DEFAULTS?.ragDenseCandidateK || 48;
      const wideLexical = retrieve(index, lexical.queries, {
        topK: Math.min(candidateK, 32),
        currentOrder: Number(task?.order) || 0,
      });
      // 除词法命中外，加入权威结构化记忆与相邻正文，允许真正的语义召回。
      const pre = buildDenseCandidatePool(index, wideLexical, task, candidateK);
      if (!pre.length) return { ...lexical, mode: "bm25" };
      const q = (lexical.queries || []).slice(0, 3).join(" \n ");
      const inputs = [q, ...pre.map((h) => h.text.slice(0, 700))];
      const vectors = await embedTexts(cfg, inputs, { signal: opts.signal });
      const qv = vectors[0];
      const rescoredAll = pre
        .map((h, i) => ({
          ...h,
          score: Math.round((cosine(qv, vectors[i + 1]) * 100 + (h.score || 0) * 0.15) * 1000) / 1000,
        }))
        .sort((a, b) => b.score - a.score);
      const rescored = selectDiverseHits(rescoredAll, opts.topK || window.NOVEL_DEFAULTS?.ragTopK || 8);
      return {
        queries: lexical.queries,
        hits: rescored,
        promptBlock: formatHitsForPrompt(rescored, opts.maxChars || window.NOVEL_DEFAULTS?.ragMaxChars || 3200),
        indexSize: index.N,
        mode: "hybrid",
      };
    } catch (e) {
      return { ...lexical, mode: "bm25_fallback", embedError: e.message || String(e) };
    }
  }

  return {
    collectDocuments,
    buildIndex,
    ensureIndex,
    retrieve,
    retrieveForChapter,
    retrieveHybrid,
    buildQueriesFromTask,
    formatHitsForPrompt,
    serializeIndex,
    deserializeIndex,
    contentSignature,
    tokenize,
    buildDenseCandidatePool,
    selectDiverseHits,
  };
})();
