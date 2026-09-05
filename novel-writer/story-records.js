/**
 * 故事记录（Canon / 伏笔 / 连续性）的纯视图模型。
 *
 * 这里只做取数：合并来源、贴标签、筛选、排序、统计。
 * 不碰 DOM，不读全局配置，好让 app.js 只负责把视图模型画成 HTML。
 * 排序规则是作者能感知的行为，必须可单测。
 */
(function () {
  const TYPE_LABELS = Object.freeze({
    number: "数值",
    name: "称谓",
    system: "能力 / 系统",
    item: "物件",
    location: "地点",
    relationship: "关系",
    character: "人物",
    world: "世界观",
    plot: "情节",
    promise: "承诺",
    mystery: "谜团",
    conflict: "冲突记录",
    general: "综合",
    chronology: "时间顺序",
    geography: "空间位置",
    identity: "身份",
    knowledge: "信息知情",
    state: "人物状态",
    other: "其他",
  });

  const STATUS_LABELS = Object.freeze({
    active: "有效",
    locked: "已锁定",
    dynamic: "动态更新",
    unlocked: "未锁定",
    superseded: "已取代",
    rejected: "冲突已拒",
    open: "待处理",
    deferred: "已延后",
    resolved: "已回收",
    abandoned: "已放弃",
    handled: "已处理",
    ignored: "已忽略",
    blocker: "阻断",
    major: "高风险",
    minor: "提醒",
    info: "信息",
  });

  const CANON_EVIDENCE_FIELDS = Object.freeze(["firstChapter", "lastChapter", "chapter"]);
  const LOOP_EVIDENCE_FIELDS = Object.freeze(["openedChapter", "lastChapter", "resolvedChapter"]);
  const CONTINUITY_EVIDENCE_FIELDS = Object.freeze(["firstChapter", "lastChapter", "resolvedChapter"]);

  const LOOP_STATUS_RANK = Object.freeze({ open: 0, deferred: 1, resolved: 2, abandoned: 3 });
  const ISSUE_STATUS_RANK = Object.freeze({ open: 0, handled: 1, ignored: 2 });
  const SEVERITY_RANK = Object.freeze({ blocker: 0, major: 1, minor: 2, info: 3 });

  const RENDER_LIMIT = 100;

  function label(value, fallback = "其他") {
    const key = String(value || "").trim();
    return TYPE_LABELS[key] || STATUS_LABELS[key] || key || fallback;
  }

  function text(value) {
    return String(value || "").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeCssToken(value, fallback = "major") {
    const token = text(value);
    return /^[a-z][a-z0-9_-]*$/i.test(token) ? token : fallback;
  }

  function rank(table, key) {
    return table[key] ?? 9;
  }

  /** 证据章节可能记在首现/末现/回收三个字段上，合起来显示一条链。 */
  function evidenceText(record, fields) {
    const values = fields.map((field) => text(record?.[field])).filter(Boolean);
    return [...new Set(values)].join(" → ");
  }

  function matchesEvidence(record, query, fields) {
    const needle = text(query).toLocaleLowerCase("zh-CN");
    if (!needle) return true;
    return fields.some((field) =>
      String(record?.[field] || "")
        .toLocaleLowerCase("zh-CN")
        .includes(needle)
    );
  }

  /** 类型下拉的选项按中文名排序，保证同一本书每次打开顺序一致。 */
  function typeOptions(values) {
    return [...new Set((values || []).map((value) => text(value)).filter(Boolean))].sort((a, b) =>
      label(a).localeCompare(label(b), "zh-CN")
    );
  }

  function canonLockState(record) {
    if (record?._recordKind === "conflict") return "rejected";
    if (record?.status === "superseded") return "superseded";
    if (record?.dynamic === true) return "dynamic";
    return record?.locked === false ? "unlocked" : "locked";
  }

  function view(records, visible, evidenceFields) {
    return {
      records,
      visible: visible.slice(0, RENDER_LIMIT),
      total: records.length,
      matched: visible.length,
      truncated: Math.max(0, visible.length - RENDER_LIMIT),
      stats: `${visible.length} / ${records.length} 条`,
      evidenceFields,
    };
  }

  /**
   * Canon 面板同时展示锁定事实和被拒冲突：冲突排在事实之后，各自按时间倒序。
   */
  function buildCanonRecords(project, filters = {}) {
    const facts = (project?.detailCanon?.facts || []).map((fact) => ({ ...fact, _recordKind: "fact" }));
    const conflicts = (project?.detailCanon?.conflicts || []).map((conflict) => ({
      ...conflict,
      _recordKind: "conflict",
      category: "conflict",
      status: "rejected",
    }));
    const records = [...facts, ...conflicts];
    const type = text(filters.type);
    const lock = text(filters.lock);
    const visible = records
      .filter((record) => !type || String(record.category || "other") === type)
      .filter((record) => !lock || canonLockState(record) === lock)
      .filter((record) => matchesEvidence(record, filters.evidence, CANON_EVIDENCE_FIELDS))
      .sort((a, b) => {
        if (a._recordKind !== b._recordKind) return a._recordKind === "fact" ? -1 : 1;
        return (Number(b.t) || 0) - (Number(a.t) || 0);
      });
    return {
      ...view(records, visible, CANON_EVIDENCE_FIELDS),
      types: typeOptions(records.map((record) => record.category || "other")),
    };
  }

  /**
   * 伏笔按「还要不要作者动手」排序：待处理和延后在前，已回收和放弃沉底。
   * _sourceIndex 保留在原数组的位置，供「标记已回收」原地改写。
   */
  function buildLoopRecords(project, filters = {}) {
    const records = (project?.plotLoops || []).map((loop, index) => ({
      ...loop,
      _sourceIndex: index,
      type: String(loop.type || loop.kind || "plot"),
      status: String(loop.status || "open"),
    }));
    const type = text(filters.type);
    const status = text(filters.status);
    const visible = records
      .filter((loop) => !type || loop.type === type)
      .filter((loop) => !status || loop.status === status)
      .filter((loop) => matchesEvidence(loop, filters.evidence, LOOP_EVIDENCE_FIELDS))
      .sort(
        (a, b) =>
          rank(LOOP_STATUS_RANK, a.status) - rank(LOOP_STATUS_RANK, b.status) ||
          (Number(b.lastOrder) || 0) - (Number(a.lastOrder) || 0)
      );
    return {
      ...view(records, visible, LOOP_EVIDENCE_FIELDS),
      types: typeOptions(records.map((loop) => loop.type)),
    };
  }

  /** 连续性风险先按待处理，再按严重度，最后按章节倒序。 */
  function buildContinuityRecords(project, filters = {}) {
    const records = (project?.continuityIssues || []).map((issue, index) => ({
      ...issue,
      _sourceIndex: index,
      type: String(issue.type || "general"),
      status: String(issue.status || "open"),
      severity: String(issue.severity || "major"),
    }));
    const type = text(filters.type);
    const status = text(filters.status);
    const severity = text(filters.severity);
    const visible = records
      .filter((issue) => !type || issue.type === type)
      .filter((issue) => !status || issue.status === status)
      .filter((issue) => !severity || issue.severity === severity)
      .filter((issue) => matchesEvidence(issue, filters.evidence, CONTINUITY_EVIDENCE_FIELDS))
      .sort(
        (a, b) =>
          rank(ISSUE_STATUS_RANK, a.status) - rank(ISSUE_STATUS_RANK, b.status) ||
          rank(SEVERITY_RANK, a.severity) - rank(SEVERITY_RANK, b.severity) ||
          (Number(b.lastOrder) || 0) - (Number(a.lastOrder) || 0)
      );
    return {
      ...view(records, visible, CONTINUITY_EVIDENCE_FIELDS),
      types: typeOptions(records.map((issue) => issue.type)),
    };
  }

  function renderCanonHtml(model) {
    return (model?.visible || [])
      .map((record) => {
        const category = String(record.category || "other");
        const lockState = canonLockState(record);
        const chapter = evidenceText(record, model.evidenceFields || CANON_EVIDENCE_FIELDS) || "未记录";
        if (record._recordKind === "conflict") {
          return `<article class="story-record is-warning">
            <header><span class="record-badge">${escapeHtml(label(category))}</span><span class="record-badge status-${escapeHtml(lockState)}">${escapeHtml(label(lockState))}</span></header>
            <h4>${escapeHtml(record.key || "未命名设定")}</h4>
            <p class="story-record-value"><del>${escapeHtml(record.attempted || "未知试写值")}</del><span aria-hidden="true"> → </span><strong>${escapeHtml(record.kept || "未知锁定值")}</strong></p>
            <dl><div><dt>证据章节</dt><dd>${escapeHtml(chapter)}</dd></div><div><dt>拒绝原因</dt><dd>${escapeHtml(record.reason || "与锁定设定不一致")}</dd></div></dl>
          </article>`;
        }
        const history = Array.isArray(record.history) ? record.history : [];
        return `<article class="story-record">
          <header><span class="record-badge">${escapeHtml(label(category))}</span><span class="record-badge status-${escapeHtml(lockState)}">${escapeHtml(label(lockState))}</span></header>
          <h4>${escapeHtml(record.key || "未命名设定")}</h4>
          <p class="story-record-value">${escapeHtml(record.value || "未填写")}</p>
          <dl>
            <div><dt>证据章节</dt><dd>${escapeHtml(chapter)}</dd></div>
            ${record.entity ? `<div><dt>关联实体</dt><dd>${escapeHtml(record.entity)}</dd></div>` : ""}
            <div><dt>正文证据</dt><dd>${escapeHtml(record.evidence || "未保存摘录")}</dd></div>
            ${history.length ? `<div><dt>变更记录</dt><dd>${history.length} 次，最近来自 ${escapeHtml(history.at(-1)?.chapter || "未知章节")}</dd></div>` : ""}
          </dl>
        </article>`;
      })
      .join("");
  }

  function renderLoopHtml(model) {
    return (model?.visible || [])
      .map((loop) => {
        const chapter = evidenceText(loop, model.evidenceFields || LOOP_EVIDENCE_FIELDS) || "未记录";
        const actionable = ["open", "deferred"].includes(loop.status);
        return `<article class="story-record" data-record-status="${escapeHtml(loop.status)}">
          <header><span class="record-badge">${escapeHtml(label(loop.type))}</span><span class="record-badge status-${escapeHtml(loop.status)}">${escapeHtml(label(loop.status))}</span></header>
          <h4>${escapeHtml(loop.summary || "未命名伏笔")}</h4>
          <dl>
            <div><dt>证据章节</dt><dd>${escapeHtml(chapter)}</dd></div>
            <div><dt>正文证据</dt><dd>${escapeHtml(loop.evidence || "未保存摘录")}</dd></div>
            <div><dt>预计回收</dt><dd>${escapeHtml(loop.target || "待安排")}</dd></div>
            ${loop.resolutionEvidence ? `<div><dt>回收证据</dt><dd>${escapeHtml(loop.resolutionEvidence)}</dd></div>` : ""}
          </dl>
          ${actionable ? `<footer><button type="button" class="btn xs" data-loop-action="resolved" data-loop-index="${loop._sourceIndex}">标记已回收</button><button type="button" class="btn ghost xs" data-loop-action="deferred" data-loop-index="${loop._sourceIndex}">延后</button></footer>` : ""}
        </article>`;
      })
      .join("");
  }

  function renderContinuityHtml(model) {
    return (model?.visible || [])
      .map((issue) => {
        const chapter = evidenceText(issue, model.evidenceFields || CONTINUITY_EVIDENCE_FIELDS) || "未记录";
        const severity = safeCssToken(issue.severity, "major");
        return `<article class="story-record continuity-card severity-${escapeHtml(severity)}" data-record-status="${escapeHtml(issue.status)}">
          <header><span class="record-badge">${escapeHtml(label(issue.type))}</span><span class="record-badge status-${escapeHtml(issue.status)}">${escapeHtml(label(issue.status))}</span><span class="severity-label">${escapeHtml(label(issue.severity))}</span></header>
          <h4>${escapeHtml(issue.summary || "未命名风险")}</h4>
          <dl>
            <div><dt>证据章节</dt><dd>${escapeHtml(chapter)}</dd></div>
            <div><dt>正文证据</dt><dd>${escapeHtml(issue.evidence || "未保存摘录")}</dd></div>
            <div><dt>Canon 证据</dt><dd>${escapeHtml(issue.expected || "未关联 Canon")}</dd></div>
            <div><dt>处理建议</dt><dd>${escapeHtml(issue.suggestion || "由作者核对并决定")}</dd></div>
            ${issue.resolution ? `<div><dt>处理记录</dt><dd>${escapeHtml(issue.resolution)}</dd></div>` : ""}
          </dl>
          ${issue.status === "open" ? `<footer><button type="button" class="btn xs" data-issue-action="handled" data-issue-index="${issue._sourceIndex}">已处理</button><button type="button" class="btn ghost xs" data-issue-action="ignored" data-issue-index="${issue._sourceIndex}">忽略</button></footer>` : ""}
        </article>`;
      })
      .join("");
  }

  function buildStorySummary(project) {
    const spine = project?.spine?.spine || [];
    const storyline = project?.storyline || {};
    const logs = (storyline.chapterLogs || []).slice(-6);
    const memory = project?.memoryRoll || [];
    const storyState = project?.storyState || {};
    const stateLines = [
      storyState.lastChapter ? `最近章：${storyState.lastChapter}` : "",
      storyState.protagonistState ? `主角：${storyState.protagonistState}` : "",
      storyState.powerOrSystem ? `能力：${storyState.powerOrSystem}` : "",
      storyState.location ? `地点：${storyState.location}` : "",
      (storyState.openLoops || []).length
        ? `未收回钩子：${(storyState.openLoops || []).slice(0, 6).join("；")}`
        : "",
      (storyState.establishedFacts || []).length
        ? `已确立事实：${(storyState.establishedFacts || []).slice(0, 6).join("；")}`
        : "",
    ].filter(Boolean);
    const memoryLines = memory.slice(-10).map((item) => {
      if (typeof item === "string") return item;
      const bits = [
        item.summary || (item.happened || []).join("，"),
        item.next_direction ? `向:${item.next_direction}` : "",
        item.state ? `态:${item.state}` : "",
        (item.open_loops || []).length ? `钩:${(item.open_loops || []).slice(0, 2).join("/")}` : "",
      ].filter(Boolean);
      return `· ${item.chapter || ""} ${bits.join(" | ")}`;
    });
    const entityStates = Object.values(project?.entityStates || {}).slice(0, 12);
    const timeline = (project?.timelineEvents || []).slice(-6);
    return {
      spineText:
        spine.map((act) => `Act${act.act} ${act.name}\n  目标:${act.goal}\n  禁止:${act.forbidden || "-"}`).join("\n\n") ||
        "尚无脊柱",
      storylineText:
        [
          storyline.positionSummary ? `位置：${storyline.positionSummary}` : "",
          storyline.lastSummary ? `上章：${storyline.lastSummary}` : "",
          storyline.nextDirection ? `推进：${storyline.nextDirection}` : "",
          storyline.nextTaskId ? `下一任务：${storyline.nextTaskId} ${storyline.nextTaskGoal || ""}` : "",
          logs.length
            ? "轨迹：\n" + logs.map((item) => `· #${item.order} ${item.summary || item.position || ""}`).join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n") || "尚无故事线（写完一章并摘要后生成）",
      memoryText:
        [
          stateLines.length ? "【故事状态】\n" + stateLines.join("\n") : "",
          memoryLines.length ? "【滚动摘要】\n" + memoryLines.join("\n") : "",
        ]
          .filter(Boolean)
          .join("\n\n") || "尚无滚动摘要（写章后自动生成；将注入下一章上下文）",
      entityStateText: [
        entityStates.length
          ? entityStates
              .map((item) => `· ${item.entity}｜${item.location || "位置?"}｜${item.condition || item.status || "状态?"}`)
              .join("\n")
          : "尚无实体状态",
        timeline.length
          ? "时间线：\n" + timeline.map((item) => `· #${item.order || "?"} ${item.time || ""} ${item.event}`).join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  window.NOVEL_STORY_RECORDS = {
    TYPE_LABELS,
    STATUS_LABELS,
    RENDER_LIMIT,
    label,
    evidenceText,
    matchesEvidence,
    typeOptions,
    canonLockState,
    buildCanonRecords,
    buildLoopRecords,
    buildContinuityRecords,
    renderCanonHtml,
    renderLoopHtml,
    renderContinuityHtml,
    buildStorySummary,
  };
})();
