/**
 * 短上下文装配器：网页反代单次输入有限，禁止塞全书。
 * 核心目标：写下一章前必须「读懂」已发生情节、设定与未收回钩子。
 *
 * 预算按字符近似；优先级保证：锁定 > 本章任务 > 故事进度/状态 >
 * 上章文末衔接 > 开放钩子 > 滚动摘要 > 人物/世界 > 本章已写正文。
 */
window.NOVEL_CONTEXT = (() => {
  const { truncate, summarizeNodes, summarizeEdges } = window.NOVEL_PROMPTS;

  function estimate(text) {
    return String(text || "").length;
  }

  /** 中英混合保守 token 估算：CJK 约 1/token，拉丁文本约 4 chars/token。 */
  function estimateTokens(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const latin = (s.match(/[A-Za-z0-9]+/g) || []).reduce((n, x) => n + x.length, 0);
    const other = Math.max(0, s.length - cjk - latin);
    return Math.max(1, Math.ceil(cjk + latin / 4 + other / 6));
  }

  function clipToDualBudget(text, maxChars, maxTokens) {
    const source = String(text || "");
    const charCap = Math.max(0, Math.floor(maxChars));
    const tokenCap = Math.max(0, Math.floor(maxTokens));
    if (!source || charCap <= 0 || tokenCap <= 0) return "";
    if (source.length <= charCap && estimateTokens(source) <= tokenCap) return source;
    const marker = "\n…[按上下文预算截断]…";
    if (charCap <= marker.length + 12 || tokenCap <= estimateTokens(marker) + 8) {
      return source.slice(0, Math.min(charCap, 24));
    }
    let lo = 0;
    let hi = Math.min(source.length, charCap - marker.length);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = source.slice(0, mid) + marker;
      if (candidate.length <= charCap && estimateTokens(candidate) <= tokenCap) lo = mid;
      else hi = mid - 1;
    }
    return source.slice(0, lo) + marker;
  }

  function orderedChapters(project) {
    return (project.chapters || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
  }

  function writtenChapters(project) {
    return orderedChapters(project).filter((c) => String(c.body || "").trim().length > 0);
  }

  /** 相对当前任务，找到「上一已写章节」（按 order） */
  function findPrevWrittenChapter(project, task) {
    const order = Number(task?.order) || 0;
    const list = writtenChapters(project);
    if (!list.length) return null;
    // 优先：order 严格小于当前任务
    const before = list.filter((c) => (c.order || 0) < order || (order === 0 && c.taskId && c.taskId !== task?.id));
    if (before.length) return before[before.length - 1];
    // 若当前章已有正文（续写），上一章仍取更早的
    const cur = list.find((c) => c.taskId === task?.id || c.id === project.activeChapterId);
    if (cur) {
      const idx = list.findIndex((c) => c.id === cur.id);
      if (idx > 0) return list[idx - 1];
      return null;
    }
    return list[list.length - 1];
  }

  function formatDigestLine(m, i) {
    if (typeof m === "string") return `- ${m}`;
    const title = m.chapter || m.title || `#${i + 1}`;
    const happened = Array.isArray(m.happened) ? m.happened.filter(Boolean).join("；") : "";
    const state = typeof m.state === "string" ? m.state : m.state ? JSON.stringify(m.state).slice(0, 80) : "";
    const loops = Array.isArray(m.open_loops) ? m.open_loops.filter(Boolean).slice(0, 3).join("；") : "";
    const info = Array.isArray(m.new_info) ? m.new_info.filter(Boolean).slice(0, 3).join("；") : "";
    const facts = Array.isArray(m.must_carry) ? m.must_carry.filter(Boolean).slice(0, 4).join("；") : "";
    const parts = [
      happened ? `事:${happened}` : "",
      state ? `态:${state}` : "",
      info ? `新:${info}` : "",
      loops ? `钩:${loops}` : "",
      facts ? `必继:${facts}` : "",
    ].filter(Boolean);
    return `- 【${title}】${parts.join(" | ") || JSON.stringify(m).slice(0, 100)}`;
  }

  function normalizeLoopSummary(raw) {
    if (raw && typeof raw === "object") {
      return String(raw.summary || raw.text || raw.loop || raw.name || "").trim();
    }
    return String(raw || "").trim();
  }

  function normalizeLoopKey(raw) {
    return normalizeLoopSummary(raw)
      .toLowerCase()
      .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()《》【】\[\]—_-]/g, "")
      .slice(0, 80);
  }

  function stableLoopId(summary) {
    const text = normalizeLoopKey(summary) || "loop";
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `loop_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function loopEventId(raw, summary) {
    if (raw && typeof raw === "object") {
      return String(raw.loop_id || raw.loopId || raw.id || "").trim() || stableLoopId(summary);
    }
    return stableLoopId(summary);
  }

  function loopEvidence(raw) {
    if (!raw || typeof raw !== "object") return "";
    return String(raw.evidence || raw.note || raw.reason || "").trim().slice(0, 160);
  }

  function findLoopRecord(records, raw, summary) {
    const requestedId = raw && typeof raw === "object" ? String(raw.loop_id || raw.loopId || raw.id || "").trim() : "";
    if (requestedId) {
      const byId = records.find((x) => x.id === requestedId);
      if (byId) return byId;
    }
    const key = normalizeLoopKey(summary);
    return records.find((x) => normalizeLoopKey(x.summary) === key) || null;
  }

  function applyLoopEvent(records, raw, status, meta = {}) {
    const summary = normalizeLoopSummary(raw);
    if (!summary) return null;
    let rec = findLoopRecord(records, raw, summary);
    const now = Date.now();
    if (!rec) {
      rec = {
        id: loopEventId(raw, summary),
        type:
          raw && typeof raw === "object"
            ? String(raw.type || raw.kind || "plot")
            : "plot",
        summary,
        status: status === "resolved" || status === "abandoned" ? status : "open",
        openedChapter: meta.chapter || "",
        openedTaskId: meta.taskId || "",
        openedOrder: Number(meta.order) || 0,
        lastChapter: meta.chapter || "",
        lastTaskId: meta.taskId || "",
        lastOrder: Number(meta.order) || 0,
        target: raw && typeof raw === "object" ? String(raw.target || raw.payoff_around || "") : "",
        evidence: loopEvidence(raw),
        resolutionEvidence: "",
        reopenCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      records.push(rec);
    } else {
      if ((status === "open" || status === "deferred") && ["resolved", "abandoned"].includes(rec.status)) {
        rec.reopenCount = (Number(rec.reopenCount) || 0) + 1;
      }
      rec.summary = summary || rec.summary;
      if (raw && typeof raw === "object" && (raw.type || raw.kind)) {
        rec.type = String(raw.type || raw.kind);
      }
      rec.status = status;
      rec.lastChapter = meta.chapter || rec.lastChapter || "";
      rec.lastTaskId = meta.taskId || rec.lastTaskId || "";
      rec.lastOrder = Number(meta.order) || rec.lastOrder || 0;
      if (raw && typeof raw === "object" && (raw.target || raw.payoff_around)) {
        rec.target = String(raw.target || raw.payoff_around);
      }
      if (loopEvidence(raw)) rec.evidence = loopEvidence(raw);
      rec.updatedAt = now;
    }
    if (status === "resolved" || status === "abandoned") {
      rec.status = status;
      rec.resolvedChapter = meta.chapter || rec.resolvedChapter || "";
      rec.resolvedTaskId = meta.taskId || rec.resolvedTaskId || "";
      rec.resolvedOrder = Number(meta.order) || rec.resolvedOrder || 0;
      rec.resolutionEvidence = loopEvidence(raw) || rec.resolutionEvidence || "";
    }
    return rec;
  }

  function applyDigestLoopEvents(records, digest, meta = {}) {
    const d = digest && typeof digest === "object" ? digest : {};
    const eventMeta = {
      chapter: meta.chapter || d.chapter || "",
      taskId: meta.taskId || d.taskId || "",
      order: meta.order || d.order || 0,
    };
    // 兼容旧摘要：open_loops 表示本章结束时仍开放，但不因“缺席”自动关闭。
    for (const raw of Array.isArray(d.open_loops) ? d.open_loops : []) {
      const found = findLoopRecord(records, raw, normalizeLoopSummary(raw));
      applyLoopEvent(records, raw, found?.status === "deferred" ? "deferred" : "open", eventMeta);
    }
    for (const raw of Array.isArray(d.opened_loops) ? d.opened_loops : []) {
      applyLoopEvent(records, raw, "open", eventMeta);
    }
    for (const raw of Array.isArray(d.advanced_loops) ? d.advanced_loops : []) {
      applyLoopEvent(records, raw, "open", eventMeta);
    }
    for (const raw of Array.isArray(d.deferred_loops) ? d.deferred_loops : []) {
      applyLoopEvent(records, raw, "deferred", eventMeta);
    }
    for (const raw of Array.isArray(d.resolved_loops) ? d.resolved_loops : []) {
      applyLoopEvent(records, raw, "resolved", eventMeta);
    }
    for (const raw of Array.isArray(d.abandoned_loops) ? d.abandoned_loops : []) {
      applyLoopEvent(records, raw, "abandoned", eventMeta);
    }
    return records;
  }

  function rebuildPlotLoopsFromMemory(project) {
    const records = [];
    for (const d of project.memoryRoll || []) applyDigestLoopEvents(records, d);
    project.plotLoops = records;
    project.continuityMeta = { ...(project.continuityMeta || {}), loopSchema: 1, loopsMigratedAt: Date.now() };
    return records;
  }

  function ensurePlotLoops(project) {
    if (
      Array.isArray(project.plotLoops) &&
      (project.plotLoops.length > 0 || project.continuityMeta?.loopSchema === 1)
    ) {
      project.continuityMeta = {
        ...(project.continuityMeta || {}),
        loopSchema: 1,
      };
      return project.plotLoops;
    }
    if (project.continuityMeta?.loopSchema !== 1) {
      return rebuildPlotLoopsFromMemory(project);
    }
    project.plotLoops = [];
    return project.plotLoops;
  }

  function mergePlotLoops(project, digest, meta = {}) {
    const records = ensurePlotLoops(project);
    applyDigestLoopEvents(records, digest, meta);
    project.plotLoops = records;
    project.continuityMeta = { ...(project.continuityMeta || {}), loopSchema: 1, loopsUpdatedAt: Date.now() };
    return records;
  }

  function getActivePlotLoops(project, task = null, limit = 16) {
    const records = ensurePlotLoops(project).filter((x) => x && ["open", "deferred"].includes(x.status));
    const query = [task?.chapter_title, task?.goal, task?.conflict, ...(task?.beats || []), ...(task?.must_include || [])]
      .filter(Boolean)
      .join(" ");
    const scored = records.map((rec) => {
      const summary = String(rec.summary || "");
      let relevance = 0;
      if (query && summary && (query.includes(summary) || summary.includes(query))) relevance += 8;
      for (const token of summary.match(/[\u4e00-\u9fff]{2,4}|[a-z0-9_]+/gi) || []) {
        if (query.includes(token)) relevance += 1;
      }
      return { rec, relevance };
    });
    scored.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        (Number(b.rec.lastOrder) || 0) - (Number(a.rec.lastOrder) || 0) ||
        (Number(b.rec.updatedAt) || 0) - (Number(a.rec.updatedAt) || 0)
    );
    return scored.slice(0, limit).map((x) => x.rec);
  }

  function normalizeIssueSummary(raw) {
    if (raw && typeof raw === "object") {
      return String(raw.summary || raw.warning || raw.text || raw.message || "").trim();
    }
    return String(raw || "").trim();
  }

  function stableIssueId(raw) {
    return stableLoopId(normalizeIssueSummary(raw)).replace(/^loop_/, "issue_");
  }

  function issueIdFromEvent(raw) {
    if (raw && typeof raw === "object") {
      return String(raw.issue_id || raw.issueId || raw.id || "").trim() || stableIssueId(raw);
    }
    return stableIssueId(raw);
  }

  function findContinuityIssue(records, raw) {
    const id = raw && typeof raw === "object" ? String(raw.issue_id || raw.issueId || raw.id || "").trim() : "";
    if (id) {
      const byId = records.find((x) => x.id === id);
      if (byId) return byId;
    }
    const key = normalizeLoopKey(normalizeIssueSummary(raw));
    return records.find((x) => normalizeLoopKey(x.summary) === key) || null;
  }

  function applyContinuityIssueEvents(records, digest, meta = {}) {
    const d = digest && typeof digest === "object" ? digest : {};
    const eventMeta = {
      chapter: meta.chapter || d.chapter || "",
      taskId: meta.taskId || d.taskId || "",
      order: Number(meta.order || d.order) || 0,
    };
    for (const raw of Array.isArray(d.continuity_warnings) ? d.continuity_warnings : []) {
      const summary = normalizeIssueSummary(raw);
      if (!summary) continue;
      let rec = findContinuityIssue(records, raw);
      const requestedSeverity = raw && typeof raw === "object" ? String(raw.severity || "major") : "major";
      const severity = ["blocker", "major", "minor", "info"].includes(requestedSeverity)
        ? requestedSeverity
        : "major";
      if (!rec) {
        rec = {
          id: issueIdFromEvent(raw),
          type: raw && typeof raw === "object" ? String(raw.type || "general") : "general",
          severity,
          summary,
          entity: raw && typeof raw === "object" ? String(raw.entity || "") : "",
          evidence: raw && typeof raw === "object" ? String(raw.evidence || "").slice(0, 180) : "",
          expected: raw && typeof raw === "object" ? String(raw.expected || "").slice(0, 180) : "",
          suggestion: raw && typeof raw === "object" ? String(raw.suggestion || "").slice(0, 180) : "",
          status: "open",
          firstChapter: eventMeta.chapter,
          firstTaskId: eventMeta.taskId,
          firstOrder: eventMeta.order,
          lastChapter: eventMeta.chapter,
          lastTaskId: eventMeta.taskId,
          lastOrder: eventMeta.order,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        records.push(rec);
      } else {
        rec.type = raw?.type || rec.type;
        rec.severity = severity;
        rec.summary = summary;
        rec.entity = raw?.entity || rec.entity;
        rec.evidence = raw?.evidence || rec.evidence;
        rec.expected = raw?.expected || rec.expected;
        rec.suggestion = raw?.suggestion || rec.suggestion;
        rec.status = "open";
        rec.lastChapter = eventMeta.chapter || rec.lastChapter;
        rec.lastTaskId = eventMeta.taskId || rec.lastTaskId;
        rec.lastOrder = eventMeta.order || rec.lastOrder;
        rec.updatedAt = Date.now();
      }
    }
    for (const [field, status] of [
      ["handled_warnings", "handled"],
      ["ignored_warnings", "ignored"],
    ]) {
      for (const raw of Array.isArray(d[field]) ? d[field] : []) {
        const rec = findContinuityIssue(records, raw);
        if (!rec) continue;
        rec.status = status;
        rec.resolution = raw && typeof raw === "object" ? String(raw.resolution || raw.reason || "") : "";
        rec.resolvedChapter = eventMeta.chapter;
        rec.resolvedTaskId = eventMeta.taskId;
        rec.resolvedOrder = eventMeta.order;
        rec.updatedAt = Date.now();
      }
    }
    return records;
  }

  function rebuildContinuityIssuesFromMemory(project) {
    const records = [];
    for (const d of project.memoryRoll || []) applyContinuityIssueEvents(records, d);
    project.continuityIssues = records;
    project.continuityMeta = { ...(project.continuityMeta || {}), issueSchema: 1, issuesMigratedAt: Date.now() };
    return records;
  }

  function ensureContinuityIssues(project) {
    if (
      Array.isArray(project.continuityIssues) &&
      (project.continuityIssues.length > 0 || project.continuityMeta?.issueSchema === 1)
    ) {
      project.continuityMeta = {
        ...(project.continuityMeta || {}),
        issueSchema: 1,
      };
      return project.continuityIssues;
    }
    if (project.continuityMeta?.issueSchema !== 1) {
      return rebuildContinuityIssuesFromMemory(project);
    }
    project.continuityIssues = [];
    return project.continuityIssues;
  }

  function mergeContinuityIssues(project, digest, meta = {}) {
    const records = ensureContinuityIssues(project);
    applyContinuityIssueEvents(records, digest, meta);
    project.continuityIssues = records;
    project.continuityMeta = { ...(project.continuityMeta || {}), issueSchema: 1, issuesUpdatedAt: Date.now() };
    return records;
  }

  function getActiveContinuityIssues(project, limit = 8) {
    const rank = { blocker: 0, major: 1, minor: 2, info: 3 };
    return ensureContinuityIssues(project)
      .filter((x) => x?.status === "open")
      .sort(
        (a, b) =>
          (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) ||
          (Number(b.lastOrder) || 0) - (Number(a.lastOrder) || 0) ||
          (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      )
      .slice(0, limit);
  }

  function buildContinuityWarningBlock(project, limit = 8) {
    const issues = getActiveContinuityIssues(project, limit);
    if (!issues.length) return "";
    return `【连续性风险·写前必须规避】\n${issues
      .map(
        (x, i) =>
          `${i + 1}. [${x.id} ${x.severity}/${x.type}] ${x.summary}${x.suggestion ? `｜建议:${x.suggestion}` : ""}`
      )
      .join("\n")}`;
  }

  const ENTITY_STATE_FIELDS = [
    "type",
    "location",
    "condition",
    "power",
    "status",
    "faction",
    "possessions",
    "relationships",
    "notes",
  ];

  function applyEntityStateDigest(project, digest, meta = {}) {
    project.entityStates = project.entityStates && typeof project.entityStates === "object" ? project.entityStates : {};
    project.timelineEvents = Array.isArray(project.timelineEvents) ? project.timelineEvents : [];
    const d = digest && typeof digest === "object" ? digest : {};
    const eventMeta = {
      chapter: meta.chapter || d.chapter || "",
      taskId: meta.taskId || d.taskId || "",
      order: Number(meta.order || d.order) || 0,
    };
    for (const raw of Array.isArray(d.entity_states) ? d.entity_states : []) {
      if (!raw || typeof raw !== "object") continue;
      const entity = String(raw.entity || raw.name || "").trim();
      if (!entity) continue;
      const prev = project.entityStates[entity] || { entity, history: [] };
      const before = {};
      const next = { ...prev, entity, history: Array.isArray(prev.history) ? prev.history.slice() : [] };
      let changed = false;
      for (const field of ENTITY_STATE_FIELDS) {
        if (raw[field] === undefined || raw[field] === null || raw[field] === "") continue;
        before[field] = prev[field];
        const value = Array.isArray(raw[field]) ? [...raw[field]] : raw[field];
        if (JSON.stringify(prev[field]) !== JSON.stringify(value)) changed = true;
        next[field] = value;
      }
      if (changed && prev.lastChapter) {
        next.history.push({
          ...before,
          chapter: prev.lastChapter,
          taskId: prev.lastTaskId || "",
          order: prev.lastOrder || 0,
          replacedAt: Date.now(),
        });
        if (next.history.length > 30) next.history = next.history.slice(-30);
      }
      next.lastChapter = eventMeta.chapter || prev.lastChapter || "";
      next.lastTaskId = eventMeta.taskId || prev.lastTaskId || "";
      next.lastOrder = eventMeta.order || prev.lastOrder || 0;
      next.evidence = String(raw.evidence || prev.evidence || "").slice(0, 180);
      next.updatedAt = Date.now();
      project.entityStates[entity] = next;
    }
    for (const raw of Array.isArray(d.timeline_events) ? d.timeline_events : []) {
      if (!raw || typeof raw !== "object") continue;
      const event = String(raw.event || raw.summary || "").trim();
      if (!event) continue;
      const id =
        String(raw.id || raw.event_id || "").trim() ||
        stableLoopId(`${eventMeta.order}|${raw.time || ""}|${event}`).replace(/^loop_/, "event_");
      const row = {
        id,
        time: String(raw.time || "").slice(0, 80),
        event: event.slice(0, 180),
        location: String(raw.location || "").slice(0, 100),
        entities: Array.isArray(raw.entities) ? raw.entities.slice(0, 12) : [],
        evidence: String(raw.evidence || "").slice(0, 180),
        chapter: eventMeta.chapter,
        taskId: eventMeta.taskId,
        order: eventMeta.order,
        updatedAt: Date.now(),
      };
      const existing = project.timelineEvents.findIndex((x) => x.id === id);
      if (existing >= 0) project.timelineEvents[existing] = row;
      else project.timelineEvents.push(row);
    }
    if (project.timelineEvents.length > 240) project.timelineEvents = project.timelineEvents.slice(-240);
  }

  function rebuildEntityStatesFromMemory(project) {
    project.entityStates = {};
    project.timelineEvents = [];
    for (const digest of project.memoryRoll || []) applyEntityStateDigest(project, digest);
    project.continuityMeta = { ...(project.continuityMeta || {}), entitySchema: 1, entitiesMigratedAt: Date.now() };
    return project.entityStates;
  }

  function ensureEntityStates(project) {
    if (
      project.entityStates &&
      typeof project.entityStates === "object" &&
      !Array.isArray(project.entityStates) &&
      (Object.keys(project.entityStates).length > 0 || project.continuityMeta?.entitySchema === 1)
    ) {
      project.continuityMeta = {
        ...(project.continuityMeta || {}),
        entitySchema: 1,
      };
      return project.entityStates;
    }
    if (project.continuityMeta?.entitySchema !== 1) {
      rebuildEntityStatesFromMemory(project);
      return project.entityStates;
    }
    project.entityStates = {};
    return project.entityStates;
  }

  function mergeEntityStates(project, digest, meta = {}) {
    ensureEntityStates(project);
    applyEntityStateDigest(project, digest, meta);
    project.continuityMeta = { ...(project.continuityMeta || {}), entitySchema: 1, entitiesUpdatedAt: Date.now() };
    return project.entityStates;
  }

  function buildEntityStateBlock(project, task = null, limit = 12) {
    const states = Object.values(ensureEntityStates(project) || {});
    if (!states.length) return "";
    const query = [task?.chapter_title, task?.goal, task?.conflict, task?.pov, ...(task?.beats || []), ...(task?.must_include || [])]
      .filter(Boolean)
      .join(" ");
    states.sort((a, b) => {
      const ar = query.includes(a.entity) ? 1 : 0;
      const br = query.includes(b.entity) ? 1 : 0;
      return br - ar || (Number(b.lastOrder) || 0) - (Number(a.lastOrder) || 0);
    });
    return `【人物/实体动态状态·以最近证据为准】\n${states
      .slice(0, limit)
      .map((x) => {
        const parts = [
          x.location ? `位置:${x.location}` : "",
          x.condition ? `状态:${x.condition}` : "",
          x.power ? `能力:${x.power}` : "",
          x.status ? `身份状态:${x.status}` : "",
          x.faction ? `阵营:${x.faction}` : "",
          x.possessions?.length ? `持有:${x.possessions.join("、")}` : "",
        ].filter(Boolean);
        return `- ${x.entity}｜${parts.join("｜") || x.notes || "—"}（#${x.lastOrder || "?"}）`;
      })
      .join("\n")}`;
  }

  function buildTimelineBlock(project, task = null, limit = 8) {
    ensureEntityStates(project);
    const events = (project.timelineEvents || []).slice();
    if (!events.length) return "";
    const query = [task?.goal, task?.conflict, task?.pov, ...(task?.beats || [])].filter(Boolean).join(" ");
    events.sort((a, b) => {
      const ar = (a.entities || []).some((x) => query.includes(x)) ? 1 : 0;
      const br = (b.entities || []).some((x) => query.includes(x)) ? 1 : 0;
      return br - ar || (Number(b.order) || 0) - (Number(a.order) || 0);
    });
    return `【近期时间线·不得倒置】\n${events
      .slice(0, limit)
      .map((x) => `- #${x.order || "?"} ${x.time || "时间未明"}｜${x.event}${x.location ? `｜${x.location}` : ""}`)
      .join("\n")}`;
  }

  function buildUncoveredBeatBlock(project, task) {
    const Craft = window.NOVEL_CRAFT;
    const prev = findPrevWrittenChapter(project, task);
    if (!prev || !Craft) return "";
    const coverage =
      typeof Craft.scoreBeatCoverage === "function"
        ? Craft.scoreBeatCoverage(prev.body, prev.beatPlan)
        : prev.craftScore?.beatCoverage;
    if (!coverage?.missing?.length) return "";
    return typeof Craft.buildUncoveredBeatHint === "function" ? Craft.buildUncoveredBeatHint(coverage) : "";
  }

  function buildStyleVoiceBlock(project, task = null) {
    const style = project.styleBible && typeof project.styleBible === "object" ? project.styleBible : {};
    const query = [task?.goal, task?.conflict, task?.pov, ...(task?.beats || []), ...(task?.must_include || [])]
      .filter(Boolean)
      .join(" ");
    const nodes = project.graph?.nodes || [];
    const voices = [];
    const seen = new Set();
    const pushVoice = (node) => {
      if (!node?.label || !node.voice || seen.has(node.label)) return;
      seen.add(node.label);
      voices.push(`${node.label}:${node.voice}${node.arc ? `（弧光:${node.arc}）` : ""}`);
    };
    nodes.filter((node) => task?.pov && node.label === task.pov).forEach(pushVoice);
    nodes.filter((node) => node.role === "protagonist" || node.role === "heroine").forEach(pushVoice);
    nodes.filter((node) => node.label && query.includes(node.label)).forEach(pushVoice);
    nodes.filter((node) => node.voice).forEach(pushVoice);
    voices.splice(6);
    const lines = [
      "【风格圣经·保持一致】",
      style.pov ? `叙述视角:${style.pov}` : "",
      style.tense ? `时态:${style.tense}` : "",
      style.pacing ? `节奏:${style.pacing}` : project.tone ? `基调:${project.tone}` : "",
      style.dialogue ? `对白:${style.dialogue}` : "",
      style.punctuation ? `标点:${style.punctuation}` : "",
      style.rules?.length ? `规则:${style.rules.slice(0, 8).join("；")}` : "",
      style.forbiddenPhrases?.length ? `禁用表达:${style.forbiddenPhrases.slice(0, 12).join("；")}` : "",
      voices.length ? `人物声线:${voices.join("；")}` : "",
      style.examples?.length
        ? `风格样例（只模仿节奏，不复制内容）:${style.examples.slice(0, 2).map((x) => truncate(x, 180)).join(" / ")}`
        : "",
    ].filter(Boolean);
    return lines.length > 1 ? lines.join("\n") : "";
  }

  /** 从全部摘要收集未收回钩子（越新越优先，去重） */
  function collectOpenLoops(memory, limit = 16) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(memory) ? memory : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const loops = Array.isArray(m?.open_loops) ? m.open_loops : [];
      for (const raw of loops) {
        const s = String(raw || "").trim();
        if (!s) continue;
        const key = s.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** 从摘要收集必须延续的事实 */
  function collectMustCarry(memory, limit = 20) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(memory) ? memory : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const bags = [
        ...(Array.isArray(m?.must_carry) ? m.must_carry : []),
        ...(Array.isArray(m?.new_info) ? m.new_info : []),
      ];
      for (const raw of bags) {
        const s = String(raw || "").trim();
        if (!s || s.length < 2) continue;
        const key = s.slice(0, 36);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /**
   * 确定性合并 storyState（不额外调模型，省反代额度）。
   * digest 为最新一章摘要 JSON。
   */
  function mergeStoryState(project, digest) {
    const prev = project.storyState && typeof project.storyState === "object" ? project.storyState : {};
    const d = digest && typeof digest === "object" ? digest : {};
    mergePlotLoops(project, d, { chapter: d.chapter, taskId: d.taskId, order: d.order });
    mergeContinuityIssues(project, d, { chapter: d.chapter, taskId: d.taskId, order: d.order });
    const openLoops = getActivePlotLoops(project, null, 20).map((x) => x.summary);
    const facts = collectMustCarry([...(project.memoryRoll || []), d], 24);
    const stateStr =
      typeof d.state === "string"
        ? d.state
        : d.state && typeof d.state === "object"
          ? Object.entries(d.state)
              .map(([k, v]) => `${k}:${v}`)
              .join("；")
          : prev.protagonistState || "";

    project.storyState = {
      updatedAt: Date.now(),
      lastChapter: d.chapter || d.title || prev.lastChapter || "",
      chapterCount: writtenChapters(project).length,
      protagonistState: stateStr || prev.protagonistState || "",
      openLoops,
      establishedFacts: facts,
      recentHook: Array.isArray(d.open_loops) && d.open_loops[0] ? d.open_loops[0] : prev.recentHook || "",
      endingNote: d.ending_hook_status || d.hook_left || prev.endingNote || "",
      powerOrSystem: d.power_or_system || d.system_state || prev.powerOrSystem || "",
      location: d.location || prev.location || "",
      timeline: d.timeline || prev.timeline || "",
    };
    return project.storyState;
  }

  function rebuildStoryStateFromMemory(project) {
    ensurePlotLoops(project);
    ensureContinuityIssues(project);
    project.storyState = {
      updatedAt: Date.now(),
      lastChapter: "",
      chapterCount: writtenChapters(project).length,
      protagonistState: "",
      openLoops: [],
      establishedFacts: [],
      recentHook: "",
      endingNote: "",
      powerOrSystem: "",
      location: "",
      timeline: "",
    };
    for (const d of project.memoryRoll || []) {
      mergeStoryState(project, d);
    }
    return project.storyState;
  }

  /** 按章序猜测当前卷 */
  function findVolumeForOrder(project, order) {
    const vols = project.spine?.volumes || [];
    if (!vols.length) return null;
    let acc = 0;
    for (const v of vols) {
      const n = Number(v.chapters || v.chapter_count || v.count) || 0;
      if (n > 0) {
        if (order > acc && order <= acc + n) return v;
        acc += n;
      }
    }
    // 无 chapters 数字时：按 volume_id 匹配任务
    const task = (project.tasks || []).find((t) => Number(t.order) === order);
    if (task?.volume_id) {
      return vols.find((v) => v.id === task.volume_id) || null;
    }
    return vols[0];
  }

  function buildStorylineBlock(project, task) {
    const tasks = (project.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const curOrder = Number(task?.order) || 0;
    const prevTask = tasks.filter((t) => (t.order || 0) < curOrder).pop();
    const nextTasks = tasks.filter((t) => (t.order || 0) > curOrder).slice(0, 2);
    const vol = findVolumeForOrder(project, curOrder);
    const sl = project.storyline || {};
    const logs = (sl.chapterLogs || []).slice(-4);

    const lines = [
      "【故事线位置·写前确认】",
      `当前任务：${task?.id || "?"}「${task?.chapter_title || task?.title || ""}」序${curOrder}`,
      vol ? `所在卷：${vol.title || vol.id || ""}｜焦点:${vol.focus || vol.climax || ""}` : "",
      sl.positionSummary ? `截至上章位置：${sl.positionSummary}` : "",
      sl.lastSummary ? `上章概要：${sl.lastSummary}` : "",
      sl.nextDirection
        ? `上章给出的推进方向：${sl.nextDirection}（本章应承接此方向，除非任务卡明确改线）`
        : "",
      prevTask
        ? `上一任务卡：${prevTask.id} ${prevTask.chapter_title || ""}｜目标:${prevTask.goal || ""}｜钩:${prevTask.hook_end || ""}`
        : "上一任务卡：（开篇）",
      `本章任务卡目标：${task?.goal || ""}`,
      nextTasks.length
        ? `后续方向预告：${nextTasks
            .map((t) => `${t.id} ${t.chapter_title || ""}（${t.goal || ""}）`)
            .join(" → ")}`
        : "后续方向预告：（本卷任务将尽）",
      logs.length
        ? `近线轨迹：${logs.map((l) => `#${l.order || "?"} ${l.position || l.summary || ""}`).join(" ｜ ")}`
        : "",
    ].filter(Boolean);
    return lines.join("\n");
  }

  function buildProgressBlock(project, task) {
    const tasks = (project.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const done = tasks.filter((t) => t.status === "done" || t.status === "digested" || t.status === "written");
    const written = writtenChapters(project);
    const curOrder = Number(task?.order) || written.length + 1;
    const total = project.targetChapters || tasks.length || "?";

    const recentDone = done
      .filter((t) => (t.order || 0) < curOrder)
      .slice(-6)
      .map((t) => `${t.id || "t?"}#${t.order || "?"}:${t.chapter_title || t.title || ""}✓`)
      .join("；");

    const nextTask = tasks.find((t) => (t.order || 0) > curOrder);
    const vol = findVolumeForOrder(project, curOrder);

    const spineActs = (project.spine?.spine || project.spine?.acts || [])
      .slice(0, 4)
      .map((a) => `${a.act || a.name || ""}:${a.goal || a.end_state || ""}`)
      .filter(Boolean)
      .join(" / ");

    const lines = [
      `【故事进度】已写${written.length}章 / 规划约${total}章；当前任务 ${task?.id || "?"} 序${curOrder}`,
      recentDone ? `【已完成近线】${recentDone}` : "【已完成近线】（尚无）",
      `【本章写完后通向】${
        nextTask ? `${nextTask.chapter_title || nextTask.id}（${nextTask.goal || "未填目标"}）` : "卷内后续（未规划下一卡）"
      }`,
      vol ? `【本卷焦点】${vol.title || vol.id || ""}｜${vol.focus || vol.climax || ""}` : "",
      spineActs ? `【主线脊柱】${truncate(spineActs, 280)}` : "",
      project.cast_summary ? `【人物总述】${truncate(project.cast_summary, 160)}` : "",
    ].filter(Boolean);

    return lines.join("\n");
  }

  function normalizeFactKey(key, entity, attr) {
    let k = String(key || "").trim();
    if (!k && entity) k = `${entity}.${attr || "设定"}`;
    return k.replace(/\s+/g, "").replace(/．/g, ".");
  }

  const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

  function parseChineseInteger(raw) {
    const text = String(raw || "");
    if (!text || !/^[零〇一二两三四五六七八九十百千万亿]+$/.test(text)) return null;
    let total = 0;
    let section = 0;
    let digit = 0;
    for (const ch of text) {
      if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
        digit = CN_DIGITS[ch];
        continue;
      }
      const unit = CN_UNITS[ch];
      if (!unit) return null;
      if (unit < 10000) {
        section += (digit || 1) * unit;
      } else {
        section += digit;
        total += section * unit;
        section = 0;
      }
      digit = 0;
    }
    return total + section + digit;
  }

  function normalizeComparableText(value) {
    return String(value ?? "")
      .trim()
      .replace(/[,，\s_]/g, "")
      .replace(/[．。]/g, ".")
      .toLowerCase();
  }

  function normalizeNumericAffix(value) {
    return String(value || "")
      .replace(/[：:=·.\-—]/g, "")
      .replace(/^(约|大约|近|当前|已有|共)/, "")
      .replace(/^(名|位)$/, "人");
  }

  function parseComparableNumber(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return null;
    let match = normalized.match(/^(.*?)([-+]?\d+(?:\.\d+)?)(亿|万|千|百)?(.*)$/);
    let number;
    let magnitude = "";
    let prefix = "";
    let suffix = "";
    if (match) {
      prefix = match[1] || "";
      number = Number(match[2]);
      magnitude = match[3] || "";
      suffix = match[4] || "";
    } else {
      match = normalized.match(/^(.*?)([零〇一二两三四五六七八九十百千万亿]+)(.*)$/);
      if (!match) return null;
      prefix = match[1] || "";
      number = parseChineseInteger(match[2]);
      suffix = match[3] || "";
    }
    if (!Number.isFinite(number)) return null;
    const factor = magnitude ? CN_UNITS[magnitude] || 1 : 1;
    return {
      number: number * factor,
      prefix: normalizeNumericAffix(prefix),
      suffix: normalizeNumericAffix(suffix),
      normalized,
    };
  }

  function compatibleNumericAffix(a, b) {
    if (a === b) return true;
    // 同一 Canon key 已提供属性语义；允许人口量词有/无及同义写法。
    const optionalCounters = new Set(["人", "名", "位"]);
    if (!a && optionalCounters.has(b)) return true;
    if (!b && optionalCounters.has(a)) return true;
    return optionalCounters.has(a) && optionalCounters.has(b);
  }

  /**
   * Canon 值比较：数值按数值与单位比较，文本只接受规范化后的精确相等。
   * 返回原因供冲突日志和测试使用；严禁 substring 相等。
   */
  function compareCanonValues(a, b) {
    const na = normalizeComparableText(a);
    const nb = normalizeComparableText(b);
    if (!na || !nb) return { equal: false, reason: "empty_value" };
    if (na === nb) return { equal: true, reason: "exact" };

    const pa = parseComparableNumber(na);
    const pb = parseComparableNumber(nb);
    if (pa && pb) {
      if (pa.number !== pb.number) {
        return { equal: false, reason: "numeric_mismatch", left: pa, right: pb };
      }
      if (!compatibleNumericAffix(pa.prefix, pb.prefix) || !compatibleNumericAffix(pa.suffix, pb.suffix)) {
        return { equal: false, reason: "unit_mismatch", left: pa, right: pb };
      }
      return { equal: true, reason: "numeric_equal", left: pa, right: pb };
    }
    if (!!pa !== !!pb) return { equal: false, reason: "type_mismatch" };
    return { equal: false, reason: "text_mismatch" };
  }

  /**
   * 合并细节设定文档（canon）。
   * 已锁定事实：同 key 新值冲突时保留旧值并记 conflicts（粉丝数 50万 不会被写成 100万）。
   */
  function mergeCanonFacts(project, incoming, meta = {}) {
    if (!project.detailCanon || typeof project.detailCanon !== "object") {
      project.detailCanon = { updatedAt: 0, facts: [], conflicts: [] };
    }
    const canon = project.detailCanon;
    canon.facts = Array.isArray(canon.facts) ? canon.facts : [];
    canon.conflicts = Array.isArray(canon.conflicts) ? canon.conflicts : [];
    const byKey = new Map(canon.facts.map((f) => [normalizeFactKey(f.key), f]));
    let added = 0;
    let conflicts = 0;

    for (const raw of incoming || []) {
      if (!raw || typeof raw !== "object") continue;
      const key = normalizeFactKey(raw.key, raw.entity, raw.attr || raw.field);
      const value = String(raw.value ?? raw.val ?? "").trim();
      if (!key || !value) continue;
      const existing = byKey.get(key);
      const chapter = meta.chapter || raw.chapter || "";
      const taskId = meta.taskId || raw.taskId || "";

      if (!existing) {
        const fact = {
          id: `f_${key}`.slice(0, 64),
          key,
          value,
          entity: raw.entity || key.split(".")[0] || "",
          category: raw.category || "other",
          firstChapter: chapter,
          firstTaskId: taskId,
          lastChapter: chapter,
          locked: raw.dynamic === true ? false : raw.locked !== false,
          dynamic: raw.dynamic === true,
          history: [],
          evidence: String(raw.evidence || "").slice(0, 40),
          status: "active",
        };
        canon.facts.push(fact);
        byKey.set(key, fact);
        added++;
      } else if (compareCanonValues(existing.value, value).equal) {
        existing.lastChapter = chapter || existing.lastChapter;
        if (!existing.evidence && raw.evidence) existing.evidence = String(raw.evidence).slice(0, 40);
      } else if (existing.dynamic === true || raw.dynamic === true) {
        existing.history = Array.isArray(existing.history) ? existing.history : [];
        existing.history.push({
          value: existing.value,
          chapter: existing.lastChapter || existing.firstChapter || "",
          taskId: existing.lastTaskId || existing.firstTaskId || "",
          replacedAt: Date.now(),
        });
        if (existing.history.length > 40) existing.history = existing.history.slice(-40);
        existing.value = value;
        existing.dynamic = true;
        existing.locked = false;
        existing.lastChapter = chapter || existing.lastChapter;
        existing.lastTaskId = taskId || existing.lastTaskId;
        existing.evidence = String(raw.evidence || existing.evidence || "").slice(0, 40);
      } else if (existing.locked !== false) {
        const comparison = compareCanonValues(existing.value, value);
        canon.conflicts.push({
          key,
          kept: existing.value,
          attempted: value,
          reason: comparison.reason,
          chapter,
          taskId,
          t: Date.now(),
        });
        if (canon.conflicts.length > 80) canon.conflicts = canon.conflicts.slice(-80);
        conflicts++;
      } else {
        existing.value = value;
        existing.lastChapter = chapter;
      }
    }
    canon.updatedAt = Date.now();
    return { added, conflicts, total: canon.facts.length };
  }

  function selectCanonFacts(project, task = null, limit) {
    const max = limit || window.NOVEL_DEFAULTS?.canonMaxFactsInPrompt || 36;
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

  function buildCanonBlock(project, limit, task = null) {
    const selected = selectCanonFacts(project, task, limit);
    const facts = selected.facts;
    if (!facts.length) {
      return "【细节设定文档】（尚无锁定细节；本章写出的数字/称谓/粉丝数等将在章后入库并锁定）";
    }
    const lines = facts.map((f) => {
      const lock = f.locked === false ? "" : "🔒";
      const dynamic = f.dynamic === true ? "↻" : "";
      return `- ${lock}${dynamic}${f.key} = ${f.value}${f.entity && !f.key.includes(f.entity) ? `（${f.entity}）` : ""}`;
    });
    const more = selected.omitted ? `\n…另有 ${selected.omitted} 条已锁定细节未展开（已按本章任务相关性选择）` : "";
    const conf = (project.detailCanon?.conflicts || []).slice(-3);
    const confLine = conf.length
      ? `\n【细节冲突已拒】${conf.map((c) => `${c.key}保持${c.kept}≠试写${c.attempted}`).join("；")}`
      : "";
    return `【细节设定文档·已锁定不可擅自改写】
规则：粉丝数、年龄、官职、药名品阶、地名、人数等以本文档为准；禁止把「50万」写成「100万」。若剧情必须变化，只能写「对外宣称/谣传/增长后的新值」并在章后作为新 key（如 王大锤.粉丝数.更新）或作者手动改档。
${lines.join("\n")}${more}${confLine}`;
  }

  function updateStorylineTrack(project, task, handoff, chapter) {
    const tasks = (project.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const order = Number(task?.order || chapter?.order) || 0;
    const next = tasks.find((t) => (t.order || 0) > order);
    const vol = findVolumeForOrder(project, order);
    const summary =
      (handoff && (handoff.summary || handoff.chapter_summary)) ||
      (Array.isArray(handoff?.happened) ? handoff.happened.slice(0, 4).join("；") : "") ||
      "";
    const position =
      (handoff && (handoff.position || handoff.storyline_position)) ||
      `${vol?.title || "本卷"}·第${order}章·${task?.chapter_title || chapter?.title || ""}`;
    const nextDirection =
      (handoff && (handoff.next_direction || handoff.nextDirection)) ||
      (next ? `下一任务 ${next.id}：${next.goal || next.chapter_title || ""}` : "本卷收束或待规划");

    const logEntry = {
      taskId: task?.id || chapter?.taskId || "",
      order,
      chapter: chapter?.title || task?.chapter_title || handoff?.chapter || "",
      summary: String(summary).slice(0, 120),
      position: String(position).slice(0, 80),
      nextDirection: String(nextDirection).slice(0, 120),
      t: Date.now(),
    };

    const prev = project.storyline && typeof project.storyline === "object" ? project.storyline : {};
    const chapterLogs = Array.isArray(prev.chapterLogs) ? prev.chapterLogs.slice() : [];
    const same = chapterLogs.findIndex((l) => l.taskId && l.taskId === logEntry.taskId);
    if (same >= 0) chapterLogs[same] = logEntry;
    else chapterLogs.push(logEntry);
    if (chapterLogs.length > 80) chapterLogs.splice(0, chapterLogs.length - 80);

    project.storyline = {
      updatedAt: Date.now(),
      currentTaskId: task?.id || prev.currentTaskId || "",
      currentOrder: order,
      volumeId: vol?.id || prev.volumeId || "",
      volumeTitle: vol?.title || prev.volumeTitle || "",
      positionSummary: logEntry.position,
      lastSummary: logEntry.summary,
      nextDirection: logEntry.nextDirection,
      nextTaskId: next?.id || "",
      nextTaskGoal: next?.goal || next?.chapter_title || "",
      chapterLogs,
    };
    return project.storyline;
  }

  function mergeAppearanceLog(project, appeared, meta = {}) {
    project.appearanceLog = Array.isArray(project.appearanceLog) ? project.appearanceLog : [];
    const entry = {
      chapter: meta.chapter || "",
      taskId: meta.taskId || "",
      order: meta.order || 0,
      characters: Array.isArray(appeared?.characters) ? appeared.characters : appeared?.people || [],
      locations: Array.isArray(appeared?.locations) ? appeared.locations : [],
      items: Array.isArray(appeared?.items) ? appeared.items : [],
      factions: Array.isArray(appeared?.factions) ? appeared.factions : [],
      t: Date.now(),
    };
    const idx = project.appearanceLog.findIndex(
      (a) => (entry.taskId && a.taskId === entry.taskId) || (entry.chapter && a.chapter === entry.chapter)
    );
    if (idx >= 0) project.appearanceLog[idx] = entry;
    else project.appearanceLog.push(entry);
    if (project.appearanceLog.length > 60) project.appearanceLog = project.appearanceLog.slice(-60);
    return entry;
  }

  function buildAppearanceBlock(project, limit = 8) {
    const logs = (project.appearanceLog || []).slice(-limit);
    if (!logs.length) return "";
    const lines = logs.map((a) => {
      const who = (a.characters || []).slice(0, 6).join("、") || "—";
      const where = (a.locations || []).slice(0, 4).join("、");
      return `- #${a.order || "?"} ${a.chapter || a.taskId || ""}｜人:${who}${where ? `｜地:${where}` : ""}`;
    });
    return `【出场记录】\n${lines.join("\n")}`;
  }

  /** 生成给人看的细节设定 Markdown */
  function formatCanonMarkdown(project) {
    const facts = project.detailCanon?.facts || [];
    const sl = project.storyline || {};
    const lines = [
      `# 细节设定文档 · ${project.title || ""}`,
      "",
      `> 由写章管线自动交接；🔒 表示已锁定，后文不得无故改写。更新于 ${new Date(project.detailCanon?.updatedAt || Date.now()).toISOString()}`,
      "",
      "## 故事线",
      "",
      `- 位置：${sl.positionSummary || "—"}`,
      `- 上章概要：${sl.lastSummary || "—"}`,
      `- 推进方向：${sl.nextDirection || "—"}`,
      `- 下一任务：${sl.nextTaskId || ""} ${sl.nextTaskGoal || ""}`,
      "",
      "## 锁定细节",
      "",
    ];
    if (!facts.length) lines.push("（暂无）", "");
    else {
      const byCat = {};
      for (const f of facts) {
        const c = f.category || "other";
        (byCat[c] = byCat[c] || []).push(f);
      }
      for (const [cat, list] of Object.entries(byCat)) {
        lines.push(`### ${cat}`, "");
        for (const f of list) {
          lines.push(`- **${f.key}** = ${f.value}  （首见:${f.firstChapter || "?"}）`);
        }
        lines.push("");
      }
    }
    const conf = project.detailCanon?.conflicts || [];
    if (conf.length) {
      lines.push("## 曾拒冲突", "");
      for (const c of conf.slice(-20)) {
        lines.push(`- ${c.key}: 保持「${c.kept}」，本章试写「${c.attempted}」（${c.chapter || ""}）`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  function buildStoryStateBlock(project) {
    let st = project.storyState;
    if (!st || typeof st !== "object" || !(st.openLoops?.length || st.establishedFacts?.length || st.protagonistState)) {
      st = rebuildStoryStateFromMemory(project);
    }
    const activeLoops = getActivePlotLoops(project, null, 12);
    const loopValues = activeLoops.length ? activeLoops.map((x) => x.summary) : st.openLoops || [];
    const loops = loopValues.slice(0, 12).map((x, i) => `${i + 1}.${x}`).join("；");
    const facts = (st.establishedFacts || []).slice(0, 14).map((x, i) => `${i + 1}.${x}`).join("；");
    return [
      "【当前故事状态·写前必读】",
      st.lastChapter ? `最近完成章：${st.lastChapter}` : "",
      st.protagonistState ? `主角状态：${st.protagonistState}` : "",
      st.powerOrSystem ? `能力/系统：${st.powerOrSystem}` : "",
      st.location ? `所在：${st.location}` : "",
      st.timeline ? `时间线：${st.timeline}` : "",
      st.endingNote ? `上章钩子落地情况：${st.endingNote}` : "",
      facts ? `【已确立事实·不得推翻】${facts}` : "",
      loops ? `【未收回钩子·应推进或故意延后并交代】${loops}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildPrevChapterBlock(project, task, tailChars) {
    const prev = findPrevWrittenChapter(project, task);
    if (!prev || !String(prev.body || "").trim()) {
      return "【上章衔接】这是开篇或尚无上章正文。从本章任务开头写，不要预支后文高潮。";
    }
    const body = String(prev.body);
    const n = Math.max(800, tailChars || 1800);
    const tail = body.length > n ? body.slice(-n) : body;
    const omitted = body.length > n ? `（上章全文${body.length}字，仅附文末${tail.length}字供衔接）` : "";
    return `【上章《${prev.title || prev.taskId || "未名"}》文末·必须连贯衔接${omitted}】
硬性：
1. 不得无视上章已发生的情节与结果；不得把已完成的高潮再写一遍当第一次。
2. 若上章末已有异象/进化/揭秘，本章应「承接后果」，而不是「重新触发同一事件」。
3. 时间、地点、人物位置从上章末自然过渡。
---
${tail}`;
  }

  function buildForeshadowBlock(project, task) {
    const fs = project.spine?.foreshadow || project.foreshadow || [];
    if (!Array.isArray(fs) || !fs.length) return "";
    const order = Number(task?.order) || 0;
    const relevant = fs
      .filter((f) => {
        const pay = String(f.payoff_around || f.payoff || "");
        const num = parseInt(pay.replace(/\D/g, ""), 10);
        if (!num) return true;
        // 回收章附近或未到的伏笔都提示
        return num >= order - 2;
      })
      .slice(0, 6)
      .map((f) => `${f.id || ""}:${f.seed || f.hint || ""}→${f.payoff_around || f.payoff || "?"}`)
      .join("；");
    return relevant ? `【伏笔账】${relevant}` : "";
  }

  /**
   * 为写章/续写装配 user 包（已含各区块，system 另传）。
   */
  function packForWrite(project, task, opts = {}) {
    const budget = opts.budget || window.NOVEL_DEFAULTS?.contextBudgetChars || 16000;
    const tokenBudget =
      opts.tokenBudget || window.NOVEL_DEFAULTS?.contextBudgetTokens || Math.max(4000, Math.ceil(budget * 0.8));
    const tailN = opts.bodyTailChars || window.NOVEL_DEFAULTS?.bodyTailChars || 2800;
    const prevTailN = opts.prevChapterTailChars || window.NOVEL_DEFAULTS?.prevChapterTailChars || 1800;
    const memDepth = opts.memoryDepth || window.NOVEL_DEFAULTS?.memoryDepth || 12;
    let effectiveRagPack = opts.ragPack || null;

    const locks = project.locks || {};
    const graph = project.graph || { nodes: [], edges: [] };
    const memory = project.memoryRoll || [];
    // 当前章：优先 task 对应章，其次 active
    const chapter =
      (project.chapters || []).find((c) => c.taskId === task?.id) ||
      (project.chapters || []).find((c) => c.id === project.activeChapterId);

    const blocks = [];

    // 1. 锁定主线（最高优先）
    const lockBlock = [
      `【锁定主线】${locks.logline || project.spine?.logline || project.pitch || "（未设）"}`,
      locks.forbidden?.length ? `【全局禁区】${locks.forbidden.join("；")}` : "",
      locks.mustHonor?.length ? `【必须兑现】${locks.mustHonor.join("；")}` : "",
      project.authorForbidden ? `【作者禁区】${project.authorForbidden}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    blocks.push({ k: "lock", t: lockBlock, keep: true });

    // 2. 故事线位置 + 推进方向（显式确认「我在哪、下一刀砍哪」）
    blocks.push({ k: "storyline", t: buildStorylineBlock(project, task), keep: true });

    // 3. 故事进度 + 任务线派发
    blocks.push({ k: "progress", t: buildProgressBlock(project, task), keep: true });

    // 4. 细节设定文档（粉丝数/专名等硬锁定）
    blocks.push({
      k: "canon",
      t: buildCanonBlock(project, opts.canonMaxFacts || window.NOVEL_DEFAULTS?.canonMaxFactsInPrompt, task),
      keep: true,
    });

    // 4b. 上一轮检测出的未处理风险必须真正回流，不能只存不用。
    const warningBlock = buildContinuityWarningBlock(project);
    if (warningBlock) blocks.push({ k: "warnings", t: warningBlock, keep: true });

    // 5. 滚动故事状态（事实/钩子/能力）
    blocks.push({ k: "story", t: buildStoryStateBlock(project), keep: true });

    const entityBlock = buildEntityStateBlock(project, task);
    if (entityBlock) blocks.push({ k: "entity", t: entityBlock, keep: true });
    const timelineBlock = buildTimelineBlock(project, task);
    if (timelineBlock) blocks.push({ k: "timeline", t: timelineBlock });
    const styleBlock = buildStyleVoiceBlock(project, task);
    if (styleBlock) blocks.push({ k: "style", t: styleBlock, keep: true });

    // 6. 上章文末衔接（写新章时的生命线）
    blocks.push({ k: "prev", t: buildPrevChapterBlock(project, task, prevTailN), keep: true });

    // 6b. RAG 检索块（混合检索命中）
    if (effectiveRagPack?.promptBlock) {
      blocks.push({ k: "rag", t: effectiveRagPack.promptBlock, keep: true });
    } else if (window.NOVEL_RAG && opts.autoRag !== false) {
      try {
        const live = window.NOVEL_RAG.retrieveForChapter(project, task, {
          topK: opts.ragTopK || window.NOVEL_DEFAULTS?.ragTopK || 8,
          maxChars: opts.ragMaxChars || window.NOVEL_DEFAULTS?.ragMaxChars || 2800,
        });
        if (live?.promptBlock) {
          effectiveRagPack = live;
          blocks.push({ k: "rag", t: live.promptBlock, keep: true });
        }
      } catch (_) {
        /* ignore */
      }
    }

    // 6c. 出场记录
    const appBlock = buildAppearanceBlock(project);
    if (appBlock) blocks.push({ k: "appear", t: appBlock });

    // 7. 人物关系压缩
    const cast = `【人物】${summarizeNodes(graph.nodes)}\n【关系】${summarizeEdges(graph.edges)}`;
    blocks.push({ k: "cast", t: cast });

    // 8. 世界观
    const world = project.world;
    let worldLine = "";
    if (world && typeof world === "object") {
      const factions = (world.factions || [])
        .slice(0, 5)
        .map((f) => (typeof f === "string" ? f : f.name || f.id))
        .filter(Boolean)
        .join("、");
      worldLine = `【世界】${world.era || ""}｜${world.power_system || ""}｜规则:${(world.rules || []).slice(0, 5).join("、")}${
        factions ? `｜势力:${factions}` : ""
      }`;
    } else if (typeof world === "string") {
      worldLine = `【世界】${truncate(world, 500)}`;
    }
    if (worldLine) blocks.push({ k: "world", t: worldLine });

    // 9. 滚动摘要（富字段）
    const memSlice = memory.slice(-memDepth);
    const memLines = memSlice.map((m, i) => formatDigestLine(m, memory.length - memSlice.length + i)).join("\n");
    if (memLines) {
      blocks.push({ k: "memory", t: `【滚动摘要·近${memSlice.length}章】\n${memLines}` });
    }

    // 10. 开放钩子单独强调（即使 memory 被裁也尽量留）
    const loops = getActivePlotLoops(project, task, 12);
    if (loops.length) {
      blocks.push({
        k: "loops",
        t: `【未收回钩子清单】\n${loops
          .map((x, i) => `${i + 1}. [${x.id}] ${x.summary}${x.status === "deferred" ? "（延后）" : ""}`)
          .join("\n")}`,
        keep: true,
      });
    }

    // 11. 伏笔
    const fs = buildForeshadowBlock(project, task);
    if (fs) blocks.push({ k: "foreshadow", t: fs });

    // 12. 本章任务卡（核心）
    if (task) {
      const taskBlock = `【本章任务 ${task.id || ""} · 必须完成】
标题：${task.chapter_title || chapter?.title || ""}
目标：${task.goal || ""}
冲突：${task.conflict || ""}
节拍：${(task.beats || []).join(" → ")}
必须包含：${(task.must_include || []).join("；") || "无"}
禁止：${(task.must_not || []).join("；") || "无"}
章末钩子：${task.hook_end || ""}
视角：${task.pov || ""}
字数目标：${task.word_target || opts.wordTarget || window.NOVEL_DEFAULTS?.chapterTargetWords || 2000}`;
      blocks.push({ k: "task", t: taskBlock, keep: true });
    }

    const Craft = window.NOVEL_CRAFT;
    const beatPlan = opts.beatPlan || chapter?.beatPlan || task?.beatPlan;
    const beatBlock = Craft?.buildBeatBlock?.(beatPlan);
    if (beatBlock) blocks.push({ k: "beat", t: beatBlock, keep: true });
    const openingHint = Craft?.buildOpeningHint?.(
      opts.recentKinds || Craft.recentOpeningKinds?.(project, task, 3)
    );
    if (openingHint) blocks.push({ k: "opening", t: openingHint, keep: true });
    const debtHint = buildUncoveredBeatBlock(project, task);
    if (debtHint) blocks.push({ k: "debt", t: debtHint, keep: true });

    // 13. 本章已写正文尾（仅续写时）
    const body = chapter?.body || "";
    if (body.trim()) {
      const tail = body.length > tailN ? body.slice(-tailN) : body;
      const prefix = body.length > tailN ? "【本章前文已省略，以下为文末续写点】\n" : "【本章已写，请续写勿重复】\n";
      blocks.push({ k: "body", t: prefix + tail, keep: true });
    } else {
      blocks.push({ k: "body", t: "【本章尚空】请从场景开头撰写；必须先承接【上章衔接】与【故事线位置】再进入本章任务。" });
    }

    // 14. 作者本轮指令
    if (opts.instruction) {
      blocks.push({ k: "instr", t: `【作者本轮指令·优先服从】\n${opts.instruction}`, keep: true });
    }

    // 预算裁剪：高优先级先装；keep 块尽量硬保
    const priority = [
      "lock",
      "task",
      "beat",
      "opening",
      "debt",
      "instr",
      "storyline",
      "canon",
      "warnings",
      "style",
      "rag",
      "progress",
      "story",
      "entity",
      "timeline",
      "prev",
      "loops",
      "body",
      "appear",
      "memory",
      "cast",
      "world",
      "foreshadow",
    ];
    let packed = "";
    const used = new Set();
    const truncated = [];
    const omitted = [];
    const hardKeep = new Set([
      "body",
      "task",
      "beat",
      "opening",
      "debt",
      "instr",
      "lock",
      "prev",
      "story",
      "entity",
      "style",
      "storyline",
      "canon",
      "warnings",
      "rag",
    ]);
    const minimumChars = {
      lock: 250,
      task: 550,
      beat: 400,
      opening: 120,
      debt: 180,
      instr: 250,
      storyline: 450,
      canon: 650,
      warnings: 250,
      rag: 500,
      story: 450,
      entity: 450,
      style: 350,
      prev: 650,
      body: 350,
    };
    const orderedBlocks = priority.map((key) => blocks.find((x) => x.k === key)).filter(Boolean);
    for (let blockIndex = 0; blockIndex < orderedBlocks.length; blockIndex++) {
      const b = orderedBlocks[blockIndex];
      const key = b.k;
      const sep = packed ? "\n\n" : "";
      const futureRequired = orderedBlocks.slice(blockIndex + 1).filter((x) => hardKeep.has(x.k));
      let reservedChars = 0;
      let reservedTokens = 0;
      for (const future of futureRequired) {
        const minChars = Math.min(String(future.t || "").length, minimumChars[future.k] || 220);
        const minText = String(future.t || "").slice(0, minChars);
        reservedChars += minText.length + 2;
        reservedTokens += estimateTokens(minText) + 1;
      }
      const availableChars = Math.max(0, budget - estimate(packed) - sep.length - reservedChars);
      const availableTokens = Math.max(0, tokenBudget - estimateTokens(packed) - estimateTokens(sep) - reservedTokens);
      const full = String(b.t || "");
      if (full.length <= availableChars && estimateTokens(full) <= availableTokens) {
        packed += sep + full;
        used.add(key);
        continue;
      }
      if (b.keep || hardKeep.has(key)) {
        const fragment = clipToDualBudget(full, availableChars, availableTokens);
        if (fragment) {
          packed += sep + fragment;
          used.add(key);
          truncated.push({ key, originalChars: full.length, usedChars: fragment.length });
        } else {
          omitted.push(key);
        }
      } else {
        omitted.push(key);
      }
    }

    // 末尾追加连贯性纪律（短，几乎总装得下）
    const discipline =
      window.NOVEL_CRAFT?.buildDiscipline?.(openingHint) ||
      `【连贯性纪律】
1. 先确认【故事线位置】与【推进方向】，再落笔；数字/粉丝数/官职等以【细节设定文档】与【RAG检索】为准，禁止无交代改写。
2. RAG 命中的既有正文/设定若与任务卡冲突，以「已写正文+锁定细节」为更高优先级，任务卡只决定本章推进。
3. 已确立事实不得无故推翻；能力/药方按状态递进，禁止每章「第一次终极进化」。
4. 上章高潮只写后果与余波，禁止重演。
5. 只输出正文，不要大纲、不要分析、不要自我解释。`;
    if (
      estimate(packed) + estimate(discipline) + 4 <= budget &&
      estimateTokens(packed) + estimateTokens(discipline) + 1 <= tokenBudget
    ) {
      packed = packed + "\n\n" + discipline;
      used.add("discipline");
    }

    const canonSelection = selectCanonFacts(
      project,
      task,
      opts.canonMaxFacts || window.NOVEL_DEFAULTS?.canonMaxFactsInPrompt
    );
    return {
      user: packed,
      meta: {
        budget,
        tokenBudget,
        used: [...used],
        chars: estimate(packed),
        tokens: estimateTokens(packed),
        truncated,
        omitted,
        blocks: blocks.map((b) => ({
          key: b.k,
          originalChars: String(b.t || "").length,
          originalTokens: estimateTokens(b.t || ""),
          used: used.has(b.k),
          truncated: truncated.some((x) => x.key === b.k),
        })),
        canon: {
          selected: canonSelection.facts.map((f) => f.key),
          omitted: canonSelection.omitted,
          total: canonSelection.total,
        },
        rag: effectiveRagPack
          ? {
              mode: effectiveRagPack.mode || "bm25",
              indexSize: effectiveRagPack.indexSize || 0,
              queries: effectiveRagPack.queries || [],
              hits: (effectiveRagPack.hits || []).map((h) => ({
                id: h.id,
                score: h.score,
                type: h.meta?.type || "doc",
                chapter: h.meta?.chapter || "",
              })),
              embedError: effectiveRagPack.embedError || "",
            }
          : { mode: opts.autoRag === false ? "not_requested" : "unavailable", indexSize: 0, queries: [], hits: [] },
        stale: {
          currentChapterHandoff: chapter?.handoffStatus || (chapter?.body?.trim() ? "unknown" : "empty"),
          previousChapterHandoff: findPrevWrittenChapter(project, task)?.handoffStatus || "unknown",
        },
        wordTarget: task?.word_target || opts.wordTarget || window.NOVEL_DEFAULTS?.chapterTargetWords || 2000,
        tone: project.tone || project.stylePreset || "",
        prevChapterId: findPrevWrittenChapter(project, task)?.id || null,
        memoryUsed: memSlice.length,
      },
    };
  }

  function recordContextManifest(project, task, chapter, packed) {
    const meta = packed?.meta || {};
    const row = {
      id: `ctx_${Date.now()}_${task?.id || chapter?.id || "manual"}`,
      at: Date.now(),
      taskId: task?.id || chapter?.taskId || "",
      chapterId: chapter?.id || "",
      chapter: chapter?.title || task?.chapter_title || "",
      chars: meta.chars || 0,
      budget: meta.budget || 0,
      tokens: meta.tokens || 0,
      tokenBudget: meta.tokenBudget || 0,
      used: meta.used || [],
      truncated: meta.truncated || [],
      omitted: meta.omitted || [],
      blocks: meta.blocks || [],
      canon: meta.canon || {},
      rag: meta.rag || {},
      stale: meta.stale || {},
    };
    project.contextManifests = Array.isArray(project.contextManifests) ? project.contextManifests : [];
    project.contextManifests.push(row);
    if (project.contextManifests.length > 100) project.contextManifests = project.contextManifests.slice(-100);
    project._lastContextManifest = row;
    return row;
  }

  function packForDigest(project, chapter, task) {
    const prev = findPrevWrittenChapter(project, task);
    const facts = (project.detailCanon?.facts || []).slice(0, 24);
    return {
      title: chapter?.title || "",
      body: chapter?.body || "",
      task,
      prevTitle: prev?.title || "",
      prevTail: prev?.body ? String(prev.body).slice(-1200) : "",
      storyState: project.storyState || null,
      storyline: project.storyline || null,
      openLoops: getActivePlotLoops(project, task, 10),
      activeWarnings: getActiveContinuityIssues(project, 8),
      existingCanon: facts.map((f) => `${f.key}=${f.value}`),
    };
  }

  function packForContinuityReview(project, chapter, task, opts = {}) {
    const P = window.NOVEL_PROMPTS;
    const loops = getActivePlotLoops(project, task, 12);
    const warnings = getActiveContinuityIssues(project, 8);
    const taskBlock = `【本章任务】
标题:${task?.chapter_title || chapter?.title || ""}
目标:${task?.goal || ""}
冲突:${task?.conflict || ""}
节拍:${(task?.beats || []).join(" → ")}
必须包含:${(task?.must_include || []).join("；") || "无"}
禁止:${(task?.must_not || []).join("；") || "无"}
章末钩子:${task?.hook_end || ""}
POV:${task?.pov || ""}`;
    const contextSections = [
      taskBlock,
      buildStorylineBlock(project, task),
      buildCanonBlock(project, opts.canonMaxFacts || 48, task),
      buildStoryStateBlock(project),
      buildEntityStateBlock(project, task),
      buildTimelineBlock(project, task),
      buildStyleVoiceBlock(project, task),
      buildPrevChapterBlock(project, task, opts.prevChapterTailChars || 2200),
      loops.length
        ? `【写前开放钩子】\n${loops.map((x) => `[${x.id}] ${x.summary}`).join("\n")}`
        : "",
      warnings.length
        ? `【写前连续性风险】\n${warnings.map((x) => `[${x.id}] ${x.summary}`).join("\n")}`
        : "",
    ].filter(Boolean);
    const budget = opts.budget || 15000;
    const tokenBudget = opts.tokenBudget || 11500;
    const bodyBudget = Math.min(
      opts.bodyChars || 8500,
      Math.floor(budget * 0.58),
      Math.max(1800, Math.floor(tokenBudget * 0.54))
    );
    const contextBudget = Math.max(2400, budget - bodyBudget - 80);
    const contextTokenBudget = Math.max(1800, Math.floor(tokenBudget * 0.42));
    const contextText = clipToDualBudget(contextSections.join("\n\n"), contextBudget, contextTokenBudget);
    const bodyText = P.sampleNarrativeText(chapter?.body || "", bodyBudget);
    const raw = `${contextText}\n\n【待审查本章正文】\n${bodyText}`;
    const user = clipToDualBudget(raw, budget, tokenBudget);
    return {
      user,
      meta: {
        chars: user.length,
        tokens: estimateTokens(user),
        budget,
        tokenBudget,
      },
    };
  }

  /**
   * A3：统一走 NOVEL_NARRATIVE.mergeGraphs（边键含 chapter，与全书分析一致）。
   * 若叙事模块未加载，回退到 chapter-aware 本地实现。
   */
  function mergeGraph(base, delta) {
    const N = window.NOVEL_NARRATIVE;
    if (N && typeof N.mergeGraphs === "function") {
      return N.mergeGraphs(base || { nodes: [], edges: [] }, delta || { nodes: [], edges: [] });
    }
    const g = {
      nodes: [...(base?.nodes || [])].map((n) => ({ ...n, aliases: [...(n.aliases || [])] })),
      edges: [...(base?.edges || [])].map((e) => ({ ...e })),
    };
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const n of delta?.nodes || []) {
      if (!n?.id && !n?.label) continue;
      const nid = n.id || `n_${(n.label || "x").replace(/\s+/g, "")}`;
      let hit = byId.get(nid);
      if (!hit) {
        for (const ex of g.nodes) {
          const names = [ex.label, ...(ex.aliases || [])];
          if (names.includes(n.label) || (n.aliases || []).some((a) => names.includes(a))) {
            hit = ex;
            break;
          }
        }
      }
      if (hit) {
        hit.aliases = unique([...(hit.aliases || []), ...(n.aliases || []), n.label].filter(Boolean));
        hit.sect = hit.sect || n.sect;
        hit.note = hit.note || n.note;
        hit.role = hit.role || n.role;
        hit.chapter = hit.chapter || n.chapter;
      } else {
        g.nodes.push({ ...n, id: nid });
        byId.set(nid, g.nodes[g.nodes.length - 1]);
      }
    }
    const undirected = new Set(["同门", "结盟", "敌对", "情侣", "夫妻", "兄弟", "朋友", "竞争", "合作"]);
    function ekey(e) {
      const rel = e.relationship || e.label || "";
      let s = String(e.source || "");
      let t = String(e.target || "");
      const ch = typeof e.chapter === "string" ? e.chapter : "";
      if (undirected.has(rel) || e.directed === false) {
        if (s > t) [s, t] = [t, s];
      }
      return `${s}|${t}|${rel}|${ch}`;
    }
    const eMap = new Map(g.edges.map((e) => [ekey(e), e]));
    for (const e of delta?.edges || []) {
      if (!e?.source || !e?.target) continue;
      const rel = e.relationship || e.label;
      if (!rel) continue;
      const normalized = {
        ...e,
        relationship: rel,
        chapter: typeof e.chapter === "string" ? e.chapter : "",
        occurrence: e.occurrence || 1,
      };
      const k = ekey(normalized);
      if (eMap.has(k)) {
        const old = eMap.get(k);
        old.occurrence = (old.occurrence || 1) + (normalized.occurrence || 1);
        if (normalized.note && !old.note) old.note = normalized.note;
        if (normalized.evidence && !old.evidence) old.evidence = normalized.evidence;
      } else {
        g.edges.push(normalized);
        eMap.set(k, normalized);
      }
    }
    g.stats = {
      characters: g.nodes.filter((n) => n.type === "character" || !n.type).length,
      relationships: g.edges.length,
    };
    return g;
  }

  function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
  }

  function graphToMermaid(graph, limit = 24) {
    const nodes = (graph?.nodes || []).slice(0, limit);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (graph?.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target)).slice(0, 40);
    const lines = ["graph LR"];
    for (const n of nodes) {
      const label = (n.label || n.id).replace(/"/g, "");
      lines.push(`  ${n.id}["${label}"]`);
    }
    for (const e of edges) {
      const rel = (e.relationship || "").replace(/"/g, "");
      lines.push(`  ${e.source} -->|"${rel}"| ${e.target}`);
    }
    return lines.join("\n");
  }

  return {
    packForWrite,
    packForDigest,
    packForContinuityReview,
    mergeGraph,
    mergeStoryState,
    rebuildStoryStateFromMemory,
    mergeCanonFacts,
    compareCanonValues,
    updateStorylineTrack,
    mergeAppearanceLog,
    buildCanonBlock,
    selectCanonFacts,
    buildStorylineBlock,
    buildAppearanceBlock,
    formatCanonMarkdown,
    findPrevWrittenChapter,
    findVolumeForOrder,
    collectOpenLoops,
    mergePlotLoops,
    rebuildPlotLoopsFromMemory,
    getActivePlotLoops,
    stableLoopId,
    mergeContinuityIssues,
    rebuildContinuityIssuesFromMemory,
    getActiveContinuityIssues,
    buildContinuityWarningBlock,
    mergeEntityStates,
    rebuildEntityStatesFromMemory,
    buildEntityStateBlock,
    buildTimelineBlock,
    buildStyleVoiceBlock,
    collectMustCarry,
    buildProgressBlock,
    buildStoryStateBlock,
    buildPrevChapterBlock,
    graphToMermaid,
    estimate,
    estimateTokens,
    clipToDualBudget,
    recordContextManifest,
    truncate,
    summarizeNodes,
    summarizeEdges,
  };
})();
