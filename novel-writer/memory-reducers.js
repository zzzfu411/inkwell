/** Deterministic reducers for plot loops, continuity issues, entity state and rolling story state. */
window.NOVEL_MEMORY_REDUCERS = (() => {
  function create({ writtenChapters } = {}) {
    if (typeof writtenChapters !== "function") {
      throw new TypeError("memory reducers require writtenChapters");
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
        .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()《》【】\u005b\u005d—_-]/g, "")
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

    return {
      stableLoopId,
      ensurePlotLoops,
      mergePlotLoops,
      rebuildPlotLoopsFromMemory,
      getActivePlotLoops,
      ensureContinuityIssues,
      mergeContinuityIssues,
      rebuildContinuityIssuesFromMemory,
      getActiveContinuityIssues,
      buildContinuityWarningBlock,
      ensureEntityStates,
      mergeEntityStates,
      rebuildEntityStatesFromMemory,
      collectOpenLoops,
      collectMustCarry,
      mergeStoryState,
      rebuildStoryStateFromMemory,
    };
  }

  return { create };
})();
