/**
 * Writing inspector helpers: beat plan editor and pace label.
 */
window.NOVEL_WRITE_UI = (() => {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderBeatPlan(host, plan, pace, coverage) {
    if (!host) return;
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    const missing = new Set((coverage?.missing || []).map((item) => Number(item.index)));
    const hasCoverage = coverage && Number(coverage.total) > 0;
    const rows =
      scenes.length > 0
        ? scenes
            .map((scene, index) => {
              const klass = hasCoverage ? (missing.has(index) ? "beat-gap" : "beat-covered") : "";
              return `<li data-scene-index="${index}" class="${klass}">
          <label>地点<input type="text" data-beat-field="place" value="${escapeHtml(scene.place || "")}" /></label>
          <label>动作<input type="text" data-beat-field="action" value="${escapeHtml(scene.action || "")}" /></label>
          <label>转折<input type="text" data-beat-field="turn" value="${escapeHtml(scene.turn || "")}" /></label>
          <label>感官<input type="text" data-beat-field="sensory" value="${escapeHtml(scene.sensory || "")}" /></label>
        </li>`;
            })
            .join("")
        : `<li class="beat-empty">尚未铺细纲。生成前会按「${escapeHtml(pace?.label || "推进")}」自动规划，也可先点「重出细纲」。</li>`;
    host.innerHTML = rows;
  }

  function renderCraftHint(el, score) {
    if (!el) return;
    const coverage = score?.beatCoverage;
    if (!coverage || !coverage.total) return;
    const dialogue = Math.round((Number(score.dialogueRate) || 0) * 100);
    el.textContent = `场面落地 ${coverage.covered}/${coverage.total} · 对白 ${dialogue}%`;
  }

  function collectBeatPlan(host, base = {}) {
    if (!host) return window.NOVEL_CRAFT?.normalizeBeatPlan?.(base) || base;
    const scenes = [...host.querySelectorAll("[data-scene-index]")].map((row) => {
      const read = (name) => row.querySelector(`[data-beat-field="${name}"]`)?.value?.trim() || "";
      return {
        place: read("place"),
        action: read("action"),
        turn: read("turn"),
        sensory: read("sensory"),
      };
    }).filter((scene) => scene.place || scene.action);
    return (
      window.NOVEL_CRAFT?.normalizeBeatPlan?.({
        ...base,
        scenes,
      }) || { ...base, scenes }
    );
  }

  /** 只采集写作/设定表单，不解释或修改领域状态。 */
  function captureProjectForm(getElementById, options = {}) {
    const byId = typeof getElementById === "function" ? getElementById : () => null;
    const value = (id) => byId(id)?.value;
    const lockLogline = byId("lockLogline");
    const graphJson = byId("graphJson");
    return {
      ideaInput: value("ideaInput"),
      authorNote: value("authorNote"),
      targetChapters: value("targetChapters"),
      locks: lockLogline
        ? {
            logline: lockLogline.value,
            forbidden: value("lockForbidden"),
            mustHonor: value("lockMust"),
            world: Boolean(byId("lockWorld")?.checked),
            cast: Boolean(byId("lockCast")?.checked),
            spine: Boolean(byId("lockSpine")?.checked),
            style: {
              pov: value("stylePov"),
              tense: value("styleTense"),
              pacing: value("stylePacing"),
              dialogue: value("styleDialogue"),
              rules: value("styleRules"),
              forbiddenPhrases: value("styleForbidden"),
              examples: value("styleExamples"),
            },
          }
        : undefined,
      graphJson: graphJson && options.graphReady ? graphJson.value : undefined,
    };
  }

  function handoffPresentation(chapter, productionState) {
    if (!chapter?.body?.trim()) {
      return { label: "无正文", state: "empty", tone: "neutral", detail: "本章没有正文，暂时无需交接" };
    }
    if (
      productionState?.isQualityBlocked?.(chapter) ??
      ["needs_revision", "quality-blocked"].includes(
        String(chapter.production?.status || chapter.production?.stage || "")
      )
    ) {
      return {
        label: "待修订",
        state: "stale",
        tone: "warning",
        detail: "正文尚未通过叙事质量闸门，修订通过后才会交接记忆",
      };
    }
    if (chapter.handoffStatus === "done") {
      return { label: "已交接", state: "done", tone: "success", detail: "摘要、关系与故事记忆已经更新" };
    }
    if (chapter.handoffStatus === "running") {
      return { label: "交接中", state: "running", tone: "warning", detail: "正在更新摘要、关系与故事记忆" };
    }
    const reason = String(chapter.handoffError || "").trim();
    const pendingReason = /尚未|等待|待重新|编辑后|重写后|修订后|手工合并|覆盖外部/.test(reason);
    if (reason && !pendingReason) {
      return { label: "交接失败", state: "failed", tone: "danger", detail: reason };
    }
    return {
      label: "待交接",
      state: "stale",
      tone: "warning",
      detail: reason || "正文已有修改，等待更新摘要、关系与故事记忆",
    };
  }

  function handoffStatusSuffix(chapter, pendingLabel, productionState) {
    const state = handoffPresentation(chapter, productionState).state;
    if (state === "done") return { suffix: "记忆已交接", kind: "" };
    if (state === "failed") return { suffix: "交接失败，待重试", kind: "warn" };
    return { suffix: pendingLabel, kind: "warn" };
  }

  function chapterSavePresentation(project, state = {}) {
    if (!project) return { label: "待确认", state: "idle", tone: "neutral", detail: "尚未载入作品" };
    if (state.readOnlyReason) {
      return {
        label: "只读保护",
        state: "readonly",
        tone: "danger",
        detail: state.readOnlyReason.message,
      };
    }
    if (state.hasPendingConflict) {
      return { label: "保存冲突", state: "conflict", tone: "danger", detail: "磁盘与当前稿均已保留，请先处理保存冲突" };
    }
    if (!state.vaultOnline || !project.slug) {
      return { label: "仅缓存", state: "cached", tone: "warning", detail: "本地书库未连接，当前修改只保存在浏览器缓存" };
    }
    if (project._dirty === true || state.activeDirty) {
      return { label: "未存盘", state: "dirty", tone: "warning", detail: "修改已进入恢复缓存，正在等待写入本地书库" };
    }
    return { label: "已存盘", state: "saved", tone: "success", detail: "当前作品已安全写入本地书库" };
  }

  function contextMeterText(packed, chapter, productionSummary) {
    const meta = packed?.meta || {};
    const handoff = !chapter?.body?.trim()
      ? "无正文"
      : chapter.handoffStatus === "done"
        ? "已交接"
        : `待交接${chapter.handoffError ? `：${chapter.handoffError}` : ""}`;
    const truncated = meta.truncated?.length
      ? `\n裁剪: ${meta.truncated.map((item) => item.key).join(", ")}`
      : "";
    const omitted = meta.omitted?.length ? `\n省略: ${meta.omitted.join(", ")}` : "";
    const rag = `\nRAG: ${meta.rag?.mode || "—"} / ${meta.rag?.hits?.length || 0} 命中`;
    const production = productionSummary?.scenes
      ? `\n生产引擎: ${productionSummary.status} · 场面 ${productionSummary.completedScenes}/${productionSummary.scenes} · 质量 ${productionSummary.overall ? `${productionSummary.overall}/10` : "待评估"}`
      : "";
    return `约 ${meta.chars} / ${meta.budget} 字符；${meta.tokens} / ${meta.tokenBudget} tokens\n使用块: ${(meta.used || []).join(", ")}${truncated}${omitted}${rag}${production}\n章后记忆: ${handoff}`;
  }

  /**
   * 写章台展示适配器。所有外部状态均由 deps 注入；本模块不发网络请求、
   * 不写缓存，也不改变小说领域状态。
   */
  function createPresenter(deps = {}) {
    const byId = deps.getElementById || (() => null);
    const query = deps.querySelector || (() => null);
    const uiShell = deps.uiShell;
    const productionState = deps.productionState;

    function renderWritingWelcome(project, chapter) {
      const welcome = byId("writingWelcome");
      const editor = byId("manuscript");
      const composer = query("#view-write .compose-bar");
      const empty = !chapter;
      if (welcome) welcome.hidden = !empty;
      if (editor) editor.hidden = empty;
      if (composer) composer.hidden = empty;
      query("#view-write .stage")?.classList.toggle("is-welcome", empty);
      if (!empty) return;
      const title = byId("writingWelcomeTitle");
      if (title) {
        title.textContent = project?.slug || project?.title
          ? `开始《${project.title || "未命名作品"}》的第一章`
          : "让第一句话落在纸上";
      }
      const hint = byId("writingWelcomeHint");
      if (hint) {
        hint.textContent = project?.tasks?.length
          ? "故事任务已经就绪。建立章节后，可以按任务写作，也可以完全由你手写。"
          : "先建立一个章节。之后每次回来，Inkwell 都会把你带回上次停笔的位置。";
      }
    }

    function renderChapterList(project, chapters, options = {}) {
      const list = byId("chapterList");
      if (!list) return 0;
      const countWords = options.countWords || ((value) => String(value || "").length);
      let total = 0;
      const rows = (chapters || []).map((chapter) => {
        const count = countWords(chapter.body);
        total += count;
        const writing = options.writingChapterId && chapter.id === options.writingChapterId;
        const active = chapter.id === project.activeChapterId;
        const handoffLabel =
          chapter.handoffStatus === "done"
            ? "已交接"
            : chapter.body?.trim() && chapter.handoffStatus !== "done"
              ? "待交接"
              : "";
        const state = writing
          ? `<span class="chapter-state writing">生成中</span>`
          : handoffLabel
            ? `<span class="chapter-state ${chapter.handoffStatus === "done" ? "done" : "stale"}">${handoffLabel}</span>`
            : "";
        return `<li><button type="button" class="chap${active ? " active" : ""}${writing ? " writing" : ""}" aria-current="${active}" data-chapter-id="${escapeHtml(chapter.id)}"${options.locked ? " disabled" : ""}><span class="chap-title">${escapeHtml(chapter.title)}</span>${state}<span class="chap-meta">${count} 字</span></button></li>`;
      });
      list.innerHTML = rows.length
        ? rows.join("")
        : `<li class="empty-state compact"><span class="empty-kicker">还没有章节</span><strong>从新章节开始正文。</strong><button type="button" class="btn ghost" data-chapter-action="new">新建章节</button></li>`;
      list.onclick = (event) => {
        const button = event.target?.closest?.("[data-chapter-id]");
        if (!button) return;
        event.preventDefault();
        options.onSelect?.(button.dataset.chapterId);
      };
      return total;
    }

    function savePresentation(project) {
      return chapterSavePresentation(project, {
        readOnlyReason: deps.getReadOnlyReason?.(project),
        hasPendingConflict: deps.hasPendingConflict?.(project),
        vaultOnline: deps.isVaultOnline?.(),
        activeDirty: deps.isActiveProject?.(project) && deps.isDirty?.(),
      });
    }

    function renderChapterHeaderState(project, chapter, prepared = {}) {
      const saveState = savePresentation(project);
      const handoffState = prepared.handoff || handoffPresentation(chapter, productionState);
      const saveButton = byId("btnSaveChapter");
      const saveLabel = byId("chapterSaveState");
      if (saveLabel) saveLabel.textContent = saveState.label;
      if (saveButton) {
        saveButton.dataset.state = saveState.state;
        saveButton.dataset.tone = saveState.tone;
        saveButton.title = saveState.detail;
        saveButton.setAttribute("aria-label", `保存本章。当前状态：${saveState.label}。${saveState.detail}`);
        saveButton.disabled = deps.isGenerationLocked?.() || Boolean(deps.getReadOnlyReason?.(project));
      }
      const handoffButton = byId("chapterHandoffStatus");
      const handoffLabel = byId("chapterHandoffState");
      if (handoffLabel) handoffLabel.textContent = handoffState.label;
      if (handoffButton) {
        handoffButton.dataset.state = handoffState.state;
        handoffButton.dataset.tone = handoffState.tone;
        handoffButton.title = handoffState.detail;
        handoffButton.setAttribute(
          "aria-label",
          `章后交接：${handoffState.label}。${handoffState.detail}。打开故事记忆检查器`
        );
      }
    }

    function renderProductionQuality(chapter) {
      const box = byId("productionQuality");
      if (!box) return;
      const production = chapter?.production;
      const review = production?.qualityReview || chapter?.qualityReview;
      if (!production && !review) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const status = String(production?.status || review?.verdict || "pending");
      const labels = {
        accepted: "已通过",
        done: "已通过",
        accepted_pending_handoff: "正文通过 · 待交接",
        needs_revision: "待修订",
        revising: "救稿中",
        failed: "生产失败",
        blocked: "质量阻断",
        pass: "已通过",
        revise: "待修订",
        fail: "未通过",
      };
      const statusEl = byId("productionQualityStatus");
      if (statusEl) {
        statusEl.textContent = labels[status] || status;
        statusEl.dataset.tone = /通过|accepted|done/.test(status)
          ? "success"
          : /失败|阻断|needs|revise|fail/.test(status)
            ? "warning"
            : "neutral";
      }
      const local = review?.local || production?.localMetrics || {};
      const overall = Number(review?.overall);
      const meta = byId("productionQualityMeta");
      if (meta) {
        const scenes = production?.contract?.scenes?.length || production?.scenes?.length || 0;
        const coverage = Number(local?.beatCoverage?.rate);
        const bits = [
          Number.isFinite(overall) && overall > 0 ? `综合 ${overall.toFixed(1)}/10` : "尚无综合分",
          scenes ? `${scenes} 场` : "",
          Number.isFinite(coverage) ? `场面落地 ${Math.round(coverage * 100)}%` : "",
          production?.revisions ? `救稿 ${production.revisions} 次` : "",
        ].filter(Boolean);
        meta.textContent = bits.join(" · ") || "分场完成后显示因果、人物主动性和钩子验收。";
      }
      const scores = byId("productionQualityScores");
      if (scores) {
        const source = review?.scores || {};
        const fields = [
          ["因果", "causalProgression"],
          ["主动性", "characterAgency"],
          ["场面", "sceneCompletion"],
          ["视角", "povConsistency"],
          ["张力", "tension"],
          ["钩子", "hook"],
        ];
        scores.innerHTML = fields
          .map(([label, key]) => {
            const value = Number(source[key]);
            return `<div><span>${label}</span><strong>${Number.isFinite(value) && value > 0 ? `${Math.round(value * 10) / 10}` : "—"}</strong></div>`;
          })
          .join("");
      }
      const issues = byId("productionQualityIssues");
      if (issues) {
        const rows = Array.isArray(review?.issues) ? review.issues.slice(0, 5) : [];
        issues.innerHTML = rows.length
          ? rows
              .map(
                (issue) =>
                  `<li><b>${escapeHtml(issue.severity || "提醒")}</b><span>${escapeHtml(issue.summary || "待检查")}</span>${issue.fix ? `<small>${escapeHtml(issue.fix)}</small>` : ""}</li>`
              )
              .join("")
          : `<li class="quality-empty">${status === "needs_revision" ? "暂无可显示的修订建议，请重试生产。" : "没有需要显示的问题。"}</li>`;
      }
    }

    function renderWritingInspector(project, task, chapter, packed) {
      if (!project) return;
      const risks = uiShell?.continuityStats?.(project.continuityIssues || []) || {
        total: 0,
        high: 0,
        tone: "success",
      };
      const assessment = continuityPresentation(chapter, deps.textSignature);
      const severityOrder = { blocker: 0, major: 1, minor: 2, info: 3 };
      const activeIssues = (project.continuityIssues || [])
        .filter((issue) => issue?.status === "open")
        .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));
      const openLoops = (project.plotLoops || []).filter((loop) => ["open", "deferred"].includes(loop?.status));
      const handoffState = handoffPresentation(chapter, productionState);
      const handoff = handoffState.label;
      const pov = task?.pov || task?.viewpoint || project.styleBible?.pov || "未设定";
      const health = uiShell?.contextHealth?.(packed?.meta || {}, project) || {
        percent: 0,
        state: "healthy",
        label: "待评估",
      };
      const healthLabel = !chapter
        ? "待评估"
        : health.state === "healthy"
          ? health.percent
            ? `健康 · ${health.percent}%`
            : "健康"
          : health.label;
      const ribbonValues = {
        ribbonTask: task?.id || "未绑定",
        ribbonPov: pov,
        ribbonLoops: String(openLoops.length),
        ribbonIssues: risks.high ? `${risks.high} 高风险` : risks.total ? `${risks.total} 条提醒` : assessment.label,
        ribbonHealth: healthLabel,
      };
      for (const [id, value] of Object.entries(ribbonValues)) {
        const el = byId(id);
        if (el) el.textContent = value;
      }
      const issueButton = byId("ribbonIssues")?.closest("button");
      if (issueButton) {
        issueButton.dataset.tone = risks.total ? risks.tone : assessment.tone;
        issueButton.setAttribute("aria-label", `连续性：${ribbonValues.ribbonIssues}，打开检查器`);
      }
      const healthButton = byId("ribbonHealth")?.closest("button");
      if (healthButton) {
        healthButton.dataset.tone = health.state === "healthy" ? "success" : health.state === "blocked" ? "danger" : "warning";
        healthButton.setAttribute("aria-label", `上下文健康：${healthLabel}，打开故事记忆检查器`);
      }
      renderChapterHeaderState(project, chapter, { handoff: handoffState });
      renderProductionQuality(chapter);

      const continuityCount = byId("continuityCount");
      if (continuityCount) continuityCount.textContent = String(activeIssues.length);
      const issueList = byId("continuityInspector");
      if (issueList) {
        issueList.innerHTML = activeIssues.length
          ? activeIssues
              .map(
                (issue) => `<article class="continuity-card severity-${escapeHtml(issue.severity || "major")}" data-issue-id="${escapeHtml(issue.id || "")}">
              <header><span class="severity-label">${escapeHtml(issue.severity || "major")}</span><span>${escapeHtml(issue.type || "general")}</span></header>
              <h4>${escapeHtml(issue.summary || "未命名风险")}</h4>
              ${issue.evidence ? `<dl><div><dt>正文证据</dt><dd>${escapeHtml(issue.evidence)}</dd></div></dl>` : ""}
              ${issue.expected ? `<dl><div><dt>Canon 证据</dt><dd>${escapeHtml(issue.expected)}</dd></div></dl>` : ""}
              ${issue.suggestion ? `<p class="issue-suggestion"><strong>建议</strong>${escapeHtml(issue.suggestion)}</p>` : ""}
              <footer>
                <button type="button" class="btn ghost xs" data-issue-action="handled">已处理</button>
                <button type="button" class="btn ghost xs" data-issue-action="ignored">忽略</button>
                ${issue.evidence ? `<button type="button" class="btn xs" data-issue-action="repair">局部修复</button>` : ""}
              </footer>
            </article>`
              )
              .join("")
          : `<div class="empty-state compact ${assessment.tone === "success" ? "success-state" : ""}"><span class="empty-kicker">${escapeHtml(assessment.label)}</span><strong>${escapeHtml(assessment.detail)}</strong></div>`;
      }

      const healthBox = byId("contextHealth");
      if (healthBox) healthBox.dataset.state = health.state;
      const contextHealthLabel = byId("contextHealthLabel");
      if (contextHealthLabel) contextHealthLabel.textContent = health.label;
      const contextHealthBar = byId("contextHealthBar");
      if (contextHealthBar) contextHealthBar.style.width = `${health.percent}%`;
      const contextHealthGrid = byId("contextHealthGrid");
      if (contextHealthGrid) {
        contextHealthGrid.innerHTML = [
          ["预算", `${health.percent}%`],
          ["Canon", `${health.canonCount} 条`],
          ["RAG", health.ragLabel || `${health.ragMode} / ${health.ragHits} 命中`],
          ["裁剪", health.truncated.length ? `${health.truncated.length} 块` : "无"],
          ["交接", handoff],
        ]
          .map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
          .join("");
      }

      const memory = byId("memoryInspector");
      if (memory) {
        const states = Object.values(project.entityStates || {}).slice(0, 6);
        const timeline = (project.timelineEvents || []).slice(-5).reverse();
        const canon = (project.detailCanon?.facts || []).slice(-6);
        memory.innerHTML = `
        <section class="memory-section"><h4>人物状态</h4>${states.length ? `<ul>${states.map((item) => `<li><strong>${escapeHtml(item.entity || "未命名")}</strong><span>${escapeHtml(item.location || item.condition || item.status || "状态待更新")}</span></li>`).join("")}</ul>` : `<p>章后交接后显示人物状态。</p>`}</section>
        <section class="memory-section"><h4>时间线</h4>${timeline.length ? `<ol>${timeline.map((item) => `<li><span>${escapeHtml(item.chapter || `#${item.order || "?"}`)}</span>${escapeHtml(item.event || item.time || "")}</li>`).join("")}</ol>` : `<p>尚无时间线事件。</p>`}</section>
        <section class="memory-section"><h4>开放伏笔</h4>${openLoops.length ? `<ul>${openLoops.slice(0, 6).map((item) => `<li><strong>${escapeHtml(item.summary || "未命名伏笔")}</strong><span>${escapeHtml(item.target || "待安排回收")}</span></li>`).join("")}</ul>` : `<p>当前没有开放伏笔。</p>`}</section>
        <section class="memory-section"><h4>相关 Canon</h4>${canon.length ? `<ul>${canon.map((item) => `<li><strong>${escapeHtml(item.key || "设定")}</strong><span>${escapeHtml(item.value || "")}</span></li>`).join("")}</ul>` : `<p>尚无锁定 Canon。</p>`}</section>`;
      }
    }

    return {
      renderWritingWelcome,
      renderChapterList,
      renderChapterHeaderState,
      renderProductionQuality,
      renderWritingInspector,
      chapterSavePresentation: savePresentation,
    };
  }

  function continuityPresentation(chapter, textSignature) {
    const review = chapter?.continuityReview;
    const state = (label, detail, tone = "neutral") => ({ label, detail, tone });
    if (!chapter?.body?.trim() || !review) return state("未审查", "本章尚未完成连续性审查。");
    if (typeof textSignature !== "function" || review.bodySig !== textSignature(chapter.body)) return state("审查已过期", "正文已变化，请重新审查。", "warning");
    if (review.status === "running") return state("审查中", "正在核对本章连续性。", "warning");
    if (review.status === "error") return state("审查失败", "本次未能完成核对，请重试审查。", "danger");
    if (review.status === "pass") return state("本章审查通过", "本次审查未发现连续性问题。", "success");
    if (["warn", "fail"].includes(review.status)) return state("审查有提醒", "请查看本章审查结果。", "warning");
    return state("未审查", "尚无可确认的审查结果。");
  }

  return {
    continuityPresentation,
    renderBeatPlan,
    collectBeatPlan,
    renderCraftHint,
    captureProjectForm,
    handoffPresentation,
    handoffStatusSuffix,
    chapterSavePresentation,
    contextMeterText,
    createPresenter,
  };
})();
