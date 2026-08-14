/** Inkwell UI state migration and presentation-only classifiers. */
(() => {
  "use strict";

  const SCHEMA_VERSION = 4;
  const SECTIONS = ["write", "story", "workspace", "analyze"];
  const STORY_MODES = ["pipeline", "control", "graph"];
  const INSPECTOR_TABS = ["task", "continuity", "memory"];
  const MODE_SECTION = {
    write: "write",
    pipeline: "story",
    control: "story",
    graph: "story",
    workspace: "workspace",
    analyze: "analyze",
  };

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  /**
   * 为异步保存提供单调修订号。
   * 旧请求只能清理它发出时捕获的修订；请求在途期间的新编辑会让 matches 返回 false。
   */
  function createRevisionTracker(keyOf = () => "default") {
    const revisions = new Map();
    const keyFor = (subject) => String(keyOf(subject) || "default");
    return {
      read(subject) {
        return revisions.get(keyFor(subject)) || 0;
      },
      bump(subject) {
        const key = keyFor(subject);
        const next = (revisions.get(key) || 0) + 1;
        revisions.set(key, next);
        return next;
      },
      matches(subject, revision) {
        return (revisions.get(keyFor(subject)) || 0) === Number(revision || 0);
      },
      clear(subject) {
        if (arguments.length) revisions.delete(keyFor(subject));
        else revisions.clear();
      },
    };
  }

  function isSuccessfulHttpStatus(status) {
    const value = Number(status);
    return Number.isInteger(value) && value >= 200 && value < 300;
  }

  function safeCssToken(value, fallback = "pending") {
    const token = String(value || "").trim();
    return /^[a-z][a-z0-9_-]*$/i.test(token) ? token : fallback;
  }

  const GENERATION_STAGE_PRESENTATIONS = Object.freeze({
    retrieve: { label: "装配写作记忆…", kind: "busy" },
    "retrieve-disabled": { label: "检索已关闭 · 装配基础记忆…", kind: "busy" },
    "retrieve-skip": { label: "装配基础写作记忆…", kind: "busy" },
    "retrieve-warning": { label: "记忆检索降级 · 继续装配…", kind: "warn" },
    "retrieve-blocked": { label: "故事记忆未就绪 · 已停止生成", kind: "err" },
    "prev-handoff": { label: "上一章记忆未交接 · 先补摘要…", kind: "busy" },
    planning: { label: "铺本章细纲…", kind: "busy" },
    writing: { label: "请求模型并生成正文…", kind: "busy" },
    reviewing: { label: "连续性审查中…", kind: "busy" },
    repairing: { label: "连续性局部修复中…", kind: "busy" },
    digesting: { label: "章后交接 · 提炼摘要…", kind: "busy" },
    graphing: { label: "章后交接 · 更新人物关系…", kind: "busy" },
    index: { label: "章后交接 · 更新故事索引…", kind: "busy" },
    done: { label: "完成 · 记忆已交接", kind: "" },
    "skip-done": { label: "本章已完成 · 无需重复生成", kind: "" },
  });

  function generationStagePresentation(stage) {
    const key = String(stage || "").trim().toLowerCase();
    const value = GENERATION_STAGE_PRESENTATIONS[key];
    return value ? { stage: key, ...value } : null;
  }

  const GENERATION_RAIL_STAGES = Object.freeze(["context", "model", "review", "handoff"]);

  /**
   * 状态条上的四段进度只有状态文案可依据，这里做反向映射。
   * 三种终态要分开：全绿（完成并已交接）、只绿前两段（正文已出但待交接）、
   * 以及失败——停止属于失败态，不能显示成完成。
   */
  function generationRailState(label, kind) {
    const text = String(label || "");
    // 从最靠后的阶段往前判：状态文案常带上一步的动词（「修订完成 · 交接失败」），
    // 先匹配写作阶段会把交接期的失败画在错误的格子上。
    let current = -1;
    if (/交接|摘要|关系|索引/.test(text)) current = 3;
    else if (/审查|修复|复检/.test(text)) current = 2;
    else if (/生成|写章|重写|修订|请求模型/.test(text)) current = 1;
    else if (/检索|装配|上下文|细纲/.test(text)) current = 0;
    const complete = /完成|已交接|连写结束/.test(text) && !/未完成|待/.test(text);
    const draftComplete = /(?:重写|修订)完成|正文已生成/.test(text) && /待.*交接/.test(text);
    const failed = kind === "err" || /失败|停止|错误/.test(text);
    const settled = complete || draftComplete || failed;
    if (current < 0 && !settled) return null;
    return {
      current,
      complete,
      draftComplete,
      failed,
      settled,
      hideAfterMs: settled ? (failed ? 2600 : 1600) : 0,
      stages: GENERATION_RAIL_STAGES.map((stage, index) => ({
        stage,
        // 正文已出但待交接时只绿前两段：审查属于交接的一部分，还没跑
        done: complete || (draftComplete ? index <= 1 : current >= 0 && index < current),
        active: !complete && !draftComplete && !failed && index === current,
        failed: failed && index === Math.max(current, 0),
      })),
    };
  }

  function sanitizeWritingPositions(input, limit = 24) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return Object.fromEntries(
      Object.entries(source)
        .map(([key, value]) => {
          const position = value && typeof value === "object" ? value : {};
          const start = Math.max(0, Math.floor(Number(position.selectionStart) || 0));
          const end = Math.max(start, Math.floor(Number(position.selectionEnd) || start));
          return [
            String(key),
            {
              selectionStart: start,
              selectionEnd: end,
              scrollTop: Math.max(0, Number(position.scrollTop) || 0),
              updatedAt: Math.max(0, Number(position.updatedAt) || 0),
            },
          ];
        })
        .filter(([key]) => key && key.length <= 240)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, Math.max(1, Number(limit) || 24))
    );
  }

  function writingPositionKey(project, chapter) {
    const book = String(project?.slug || project?.id || "").trim();
    const chapterId = String(chapter?.id || "").trim();
    return book && chapterId ? `${book}::${chapterId}` : "";
  }

  function chooseStartupChapter(project) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters.filter(Boolean) : [];
    if (!chapters.length) return null;
    const active = chapters.find((chapter) => chapter.id === project?.activeChapterId);
    if (active) return active;
    return chapters
      .slice()
      .sort(
        (a, b) =>
          (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
          (Number(b.order) || 0) - (Number(a.order) || 0)
      )[0];
  }

  function migrateUiState(input) {
    const source = input && typeof input === "object" ? input : {};
    const legacyMode = source.activeMode || source.mode || "";
    const mappedSection = MODE_SECTION[legacyMode];
    const activeSection = SECTIONS.includes(source.activeSection)
      ? source.activeSection
      : mappedSection || "workspace";
    const storyMode = STORY_MODES.includes(source.storyMode)
      ? source.storyMode
      : STORY_MODES.includes(legacyMode)
        ? legacyMode
        : "control";
    const panels = { ...(source.panels || {}) };
    const hadLegacyLibraryPanel = Object.prototype.hasOwnProperty.call(panels, "library");
    const libraryOpen = Object.prototype.hasOwnProperty.call(source, "libraryOpen")
      ? !!source.libraryOpen
      : hadLegacyLibraryPanel
        ? !panels.library
        : false;
    delete panels.library;
    const hasChosenSection = Object.prototype.hasOwnProperty.call(source, "hasChosenSection")
      ? !!source.hasChosenSection
      : !!legacyMode || (!!source.schemaVersion && SECTIONS.includes(source.activeSection));

    return {
      ...source,
      schemaVersion: SCHEMA_VERSION,
      activeSection,
      hasChosenSection,
      storyMode,
      inspectorTab: INSPECTOR_TABS.includes(source.inspectorTab) ? source.inspectorTab : "task",
      libraryOpen,
      focusMode: !!source.focusMode,
      panels,
      panelWidths: {
        chapters: clamp(source.panelWidths?.chapters, 190, 300, 220),
        inspector: clamp(source.panelWidths?.inspector, 280, 420, 320),
      },
      writingPositions: sanitizeWritingPositions(source.writingPositions),
    };
  }

  function primaryModeForState(uiState) {
    const state = migrateUiState(uiState);
    if (state.activeSection === "story") return state.storyMode;
    return state.activeSection;
  }

  function startupModeForState(uiState) {
    const state = migrateUiState(uiState);
    return state.hasChosenSection ? primaryModeForState(state) : "write";
  }

  function layoutForWidth(width) {
    const value = Number(width) || 0;
    return {
      inspector: value < 1200 ? "drawer" : "rail",
      chapters: value < 1050 ? "drawer" : "rail",
      compactTopbar: value < 1120,
    };
  }

  function continuityStats(issues) {
    const open = (Array.isArray(issues) ? issues : []).filter((issue) => issue?.status === "open");
    const counts = { blocker: 0, major: 0, minor: 0, info: 0, total: open.length };
    for (const issue of open) {
      const severity = Object.prototype.hasOwnProperty.call(counts, issue?.severity)
        ? issue.severity
        : "major";
      counts[severity] += 1;
    }
    counts.high = counts.blocker + counts.major;
    counts.tone = counts.blocker ? "danger" : counts.major ? "warning" : open.length ? "notice" : "success";
    return counts;
  }

  function contextHealth(meta, project) {
    const value = meta && typeof meta === "object" ? meta : {};
    const chars = Math.max(0, Number(value.chars) || 0);
    const charBudget = Math.max(0, Number(value.budget) || 0);
    const tokens = Math.max(0, Number(value.tokens) || 0);
    const tokenBudget = Math.max(0, Number(value.tokenBudget) || 0);
    const charRatio = charBudget ? chars / charBudget : 0;
    const tokenRatio = tokenBudget ? tokens / tokenBudget : 0;
    const ratio = Math.max(charRatio, tokenRatio);
    const truncated = Array.isArray(value.truncated) ? value.truncated : [];
    const omitted = Array.isArray(value.omitted) ? value.omitted : [];
    const metaRag = value.rag && typeof value.rag === "object" ? value.rag : null;
    const lastRag = project?._lastRag && typeof project._lastRag === "object" ? project._lastRag : null;
    const activeTaskId = String(project?.activeTaskId || "");
    const lastRagMatchesTask =
      !!lastRag &&
      (!lastRag.taskId || !activeTaskId || String(lastRag.taskId) === activeTaskId);
    const actionableLastMode = ["blocked", "failed", "stale"].includes(String(lastRag?.mode || ""));
    const rag = lastRagMatchesTask && actionableLastMode ? lastRag : metaRag || lastRag || {};
    const ragMode = String(rag.mode || "off");
    const ragHits = Array.isArray(rag.hits) ? rag.hits.length : Number(rag.hitCount) || 0;
    const canonCount = Number(value.canonCount) || project?.detailCanon?.facts?.length || 0;
    const retrievalAttempted = ["bm25", "hybrid", "bm25_fallback"].includes(ragMode);

    let ragLabel = `${ragMode} / ${ragHits} 命中`;
    if (ragMode === "blocked") ragLabel = "严格策略阻断";
    else if (ragMode === "failed") ragLabel = "检索失败 · 已降级";
    else if (ragMode === "stale" || rag.stale === true) ragLabel = "索引过期 · 待重建";
    else if (retrievalAttempted && ragHits === 0) ragLabel = "已检索 · 0 命中";
    else if (ragMode === "bm25_fallback" && rag.embedError) ragLabel = `本地检索 / ${ragHits} 命中`;
    else if (ragMode === "unavailable") ragLabel = "索引不可用";
    else if (ragMode === "not_requested") ragLabel = "本轮未请求";
    else if (ragMode === "off") ragLabel = "未启用";

    let state = "healthy";
    let label = "上下文健康";
    if (value.blocked || ragMode === "blocked") {
      state = "blocked";
      label = "严格策略已阻断";
    } else if (ragMode === "failed") {
      state = "degraded";
      label = "检索已降级";
    } else if (ragMode === "stale" || rag.stale === true) {
      state = "stale";
      label = "故事索引已过期";
    } else if (ragMode === "bm25_fallback" && rag.embedError) {
      state = "degraded";
      label = "向量检索已降级";
    } else if (retrievalAttempted && ragHits === 0) {
      state = "empty";
      label = "检索零命中";
    } else if (truncated.length || omitted.length) {
      state = "trimmed";
      label = "已按预算裁剪";
    } else if (ratio >= 0.9) {
      state = "warning";
      label = "接近预算上限";
    }

    return {
      state,
      label,
      ratio,
      percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
      chars,
      charBudget,
      tokens,
      tokenBudget,
      canonCount,
      ragMode,
      ragHits,
      ragLabel,
      truncated,
      omitted,
    };
  }

  function recoverConcatenatedStylePacing(pacing, dialogue) {
    const spoken = String(dialogue || "").trim();
    let next = String(pacing || "").trim();
    if (!spoken) return next;
    const suffix = `；${spoken}`;
    while (next.endsWith(suffix)) next = next.slice(0, -suffix.length).trimEnd();
    return next.trim();
  }

  const api = {
    SCHEMA_VERSION,
    SECTIONS,
    STORY_MODES,
    INSPECTOR_TABS,
    MODE_SECTION,
    migrateUiState,
    primaryModeForState,
    startupModeForState,
    chooseStartupChapter,
    sanitizeWritingPositions,
    writingPositionKey,
    layoutForWidth,
    continuityStats,
    contextHealth,
    createRevisionTracker,
    isSuccessfulHttpStatus,
    safeCssToken,
    generationStagePresentation,
    generationRailState,
    GENERATION_RAIL_STAGES,
    recoverConcatenatedStylePacing,
  };

  if (typeof window !== "undefined") window.NOVEL_UI_SHELL = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
