(() => {
  "use strict";

  const Composition = window.NOVEL_COMPOSITION_CONTRACT;
  if (!Composition?.assertBeforeEntrypoint) throw new Error("NOVEL_COMPOSITION_CONTRACT 未在 app.js 前加载");
  Composition.assertBeforeEntrypoint("app.js", window);

  const Store = window.NOVEL_STORE;
  const UiShell = window.NOVEL_UI_SHELL;
  const API = window.NOVEL_API;
  const Pipe = window.NOVEL_PIPELINE;
  const Ctx = window.NOVEL_CONTEXT;
  const Vault = window.NOVEL_VAULT;
  const Records = window.NOVEL_STORY_RECORDS;
  const GraphPanel = window.NOVEL_GRAPH_PANEL;
  const ComposerReview = window.NOVEL_COMPOSER_REVIEW;
  const TextMetrics = window.NOVEL_TEXT_METRICS;
  const ChapterState = window.NOVEL_CHAPTER_STATE;
  const ProjectMigrations = window.NOVEL_PROJECT_MIGRATIONS;
  const ProductionState = window.NOVEL_PRODUCTION_STATE;
  const ConflictCases = window.NOVEL_CONFLICT_USE_CASES;
  const PersistenceFactory = window.NOVEL_PERSISTENCE_USE_CASES;
  const WriteUseCasesFactory = window.NOVEL_WRITE_USE_CASES;
  const WriteUI = window.NOVEL_WRITE_UI;
  const DiagnosticsUI = window.NOVEL_DIAGNOSTICS_UI;
  const {
    projectFormEqual,
    formTextEqual,
  } = PersistenceFactory;

  const $ = (id) => document.getElementById(id);

  let state = { projects: [], activeId: null };
  let cfg = Store.loadCfg();
  let uiState = Store.loadUiState?.() || {};
  let cfgPersistTimer = null;
  let uiPersistTimer = null;
  let writingPositionTimer = null;
  let pendingWritingPosition = null;
  let suppressWritingPositionCapture = false;
  let graphSelectedNodeId = null;
  let graphSelectedProjectId = null;
  let writeContextCache = null;
  let craftRescoreTimer = null;
  let craftRescorePendingId = null;
  const CRAFT_RESCORE_DELAY_MS = 400;
  const THEMES = [
    { id: "soft-paper", label: "柔纸" },
    { id: "ink-night", label: "墨夜" },
    { id: "qing-jian", label: "青简" },
  ];

  const MODE_SECTION = {
    write: "write",
    pipeline: "story",
    control: "story",
    graph: "story",
    workspace: "workspace",
    analyze: "analyze",
  };

  function normalizeUiState(input) {
    return UiShell?.migrateUiState?.(input) || input || {};
  }

  uiState = normalizeUiState(uiState);

  /** 本地 + 磁盘双写客户端配置（Tauri WebView localStorage 不可靠） */
  function persistCfg(immediate) {
    try {
      Store.saveCfg(cfg);
    } catch (_) {}
    const run = async () => {
      if (!vaultOnline || typeof Vault.putSettings !== "function") return;
      try {
        await Vault.putSettings({ clientCfg: { ...cfg }, replaceClientCfg: true });
      } catch (e) {
        console.warn("persistCfg disk", e);
      }
    };
    if (immediate) return run();
    clearTimeout(cfgPersistTimer);
    cfgPersistTimer = setTimeout(run, 200);
    return Promise.resolve();
  }

  function persistUiState(immediate) {
    try {
      Store.saveUiState?.(uiState);
    } catch (_) {}
    const run = async () => {
      if (!vaultOnline || typeof Vault.putSettings !== "function") return;
      try {
        await Vault.putSettings({ uiState: { ...uiState } });
      } catch (e) {
        console.warn("persistUiState disk", e);
      }
    };
    if (immediate) return run();
    clearTimeout(uiPersistTimer);
    uiPersistTimer = setTimeout(run, 200);
    return Promise.resolve();
  }

  function activeChapter(p = project()) {
    return p?.chapters?.find((chapter) => chapter.id === p.activeChapterId) || null;
  }

  function captureWritingPosition(immediate = false) {
    if (suppressWritingPositionCapture) return;
    const editor = $("manuscript");
    const p = project();
    const chapter = activeChapter(p);
    const key = UiShell?.writingPositionKey?.(p, chapter);
    if (!editor || !key) return;
    uiState.writingPositions = UiShell?.sanitizeWritingPositions?.({
      ...(uiState.writingPositions || {}),
      [key]: {
        selectionStart: editor.selectionStart,
        selectionEnd: editor.selectionEnd,
        scrollTop: editor.scrollTop,
        updatedAt: Date.now(),
      },
    }) || uiState.writingPositions || {};
    if (immediate) {
      clearTimeout(writingPositionTimer);
      writingPositionTimer = null;
      persistUiState(false);
      return;
    }
    clearTimeout(writingPositionTimer);
    writingPositionTimer = setTimeout(() => persistUiState(false), 240);
  }

  function queueWritingPositionRestore(p, chapter) {
    const editor = $("manuscript");
    const key = UiShell?.writingPositionKey?.(p, chapter);
    const position = key ? uiState.writingPositions?.[key] : null;
    if (!editor || !position) {
      pendingWritingPosition = null;
      return;
    }
    pendingWritingPosition = { key, position };
    requestAnimationFrame(() => {
      if (!pendingWritingPosition || pendingWritingPosition.key !== key) return;
      const max = editor.value.length;
      const start = Math.min(max, Math.max(0, Number(position.selectionStart) || 0));
      const end = Math.min(max, Math.max(start, Number(position.selectionEnd) || start));
      suppressWritingPositionCapture = true;
      editor.setSelectionRange(start, end);
      editor.scrollTop = Math.max(0, Number(position.scrollTop) || 0);
      suppressWritingPositionCapture = false;
      pendingWritingPosition = null;
    });
  }

  function applyTheme(themeId, persist) {
    const id = THEMES.some((t) => t.id === themeId) ? themeId : "soft-paper";
    document.documentElement.setAttribute("data-theme", id);
    cfg.theme = id;
    if (persist !== false) {
      persistCfg(false);
    }
    document.querySelectorAll(".theme-swatch").forEach((btn) => {
      const active = btn.dataset.theme === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    });
    // 同步 WebView / 系统标题栏观感（能调则调）
    try {
      const dark = id === "ink-night";
      document.querySelector('meta[name="color-scheme"]')?.setAttribute(
        "content",
        dark ? "dark" : "light"
      );
    } catch (_) {}
  }

  // 尽早套主题，减少白闪（随后 boot 会从磁盘覆盖）
  applyTheme(cfg.theme || window.NOVEL_DEFAULTS?.theme || "soft-paper", false);

  /* ── 侧栏折叠 ── */
  const PANEL_IDS = ["wsFiles", "writeChapters", "writeTask", "controlSide", "pipeSide", "graphSide", "analyzeSide"];

  function setPanelCollapsed(id, collapsed, persist) {
    const el = document.querySelector(`[data-panel="${id}"]`);
    if (!el) return;
    el.classList.toggle("is-collapsed", !!collapsed);
    if (id === "wsFiles") {
      document.querySelector("#view-workspace .ws-layout")?.classList.toggle("side-collapsed", !!collapsed);
    }
    if (id === "writeChapters" || id === "writeTask") {
      const ws = document.querySelector("#view-write .workspace");
      if (ws) {
        ws.classList.toggle("left-collapsed", document.querySelector('[data-panel="writeChapters"]')?.classList.contains("is-collapsed"));
        ws.classList.toggle("right-collapsed", document.querySelector('[data-panel="writeTask"]')?.classList.contains("is-collapsed"));
      }
    }
    const btn = el.querySelector(".panel-collapse-btn");
    if (btn) {
      btn.title = collapsed ? "展开侧栏" : "折叠侧栏";
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.textContent = collapsed ? "»" : "«";
      if (id === "writeTask" || id === "controlSide" || id === "pipeSide" || id === "graphSide" || id === "analyzeSide") {
        btn.textContent = collapsed ? "«" : "»";
      }
    }
    uiState.panels = uiState.panels || {};
    uiState.panels[id] = !!collapsed;
    if (persist !== false) persistUiState(false);
  }

  function initCollapsiblePanels() {
    document.querySelectorAll("[data-panel]").forEach((el) => {
      const id = el.getAttribute("data-panel");
      if (!id) return;
      let btn = el.querySelector(".panel-collapse-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn ghost xs panel-collapse-btn";
        btn.setAttribute("aria-label", "折叠侧栏");
        btn.textContent = "«";
        const actions = el.querySelector(".panel-head-actions, .ws-side-actions");
        const head = el.querySelector(".library-head, .ws-side-head, .rail-head, .panel-side-head");
        if (actions) actions.appendChild(btn);
        else if (head) head.appendChild(btn);
        else {
          const bar = document.createElement("div");
          bar.className = "panel-side-head";
          bar.innerHTML = `<h2 class="panel-side-title">${el.getAttribute("data-panel-title") || "面板"}</h2>`;
          bar.appendChild(btn);
          el.insertBefore(bar, el.firstChild);
        }
      }
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPanelCollapsed(id, !el.classList.contains("is-collapsed"), true);
      };
      // 折叠后点击窄条展开
      el.addEventListener("click", (e) => {
        if (!el.classList.contains("is-collapsed")) return;
        if (e.target.closest(".panel-collapse-btn")) {
          e.preventDefault();
          e.stopPropagation();
          setPanelCollapsed(id, false, true);
          return;
        }
        setPanelCollapsed(id, false, true);
      });
    });
    const saved = uiState.panels || {};
    for (const id of PANEL_IDS) {
      if (saved[id]) setPanelCollapsed(id, true, false);
      else setPanelCollapsed(id, false, false);
    }
  }

  /**
   * 原生 details/summary 已有展开语义；显式同步 aria-expanded，保证 WebView、
   * 自动化工具和旧辅助技术都能读取同一状态。
   */
  function initDetailsAccessibility() {
    document.querySelectorAll("details").forEach((details) => {
      const summary = details.querySelector(":scope > summary");
      if (!summary || summary.dataset.expandedSync === "true") return;
      const sync = () => summary.setAttribute("aria-expanded", details.open ? "true" : "false");
      summary.dataset.expandedSync = "true";
      sync();
      details.addEventListener("toggle", sync);
    });
  }

  function setLibraryDrawer(open, persist) {
    const isOpen = !!open;
    const rail = $("libraryRail");
    const hadFocus = rail?.contains(document.activeElement);
    document.querySelector(".shell")?.classList.toggle("library-open", isOpen);
    rail?.setAttribute("aria-hidden", isOpen ? "false" : "true");
    if (rail) rail.inert = !isOpen;
    $("btnToggleLibrary")?.setAttribute("aria-expanded", isOpen ? "true" : "false");
    uiState.libraryOpen = isOpen;
    if (persist !== false) persistUiState(false);
    if (isOpen) {
      window.setTimeout(() => $("libFilter")?.focus(), 80);
    } else if (hadFocus) {
      $("btnToggleLibrary")?.focus();
    }
  }

  function syncModalBackgroundInert(activeModal) {
    const root = document.querySelector(".app");
    if (!root) return;
    const active =
      activeModal ||
      [$("settingsModal"), $("taskModal"), $("snapshotModal"), $("saveConflictModal")].find(
        (modal) => modal && !modal.hidden
      ) || null;
    [...root.children].forEach((child) => {
      if (child === active) return;
      if (active) {
        if (child.dataset.modalInertManaged !== "true") {
          child.dataset.modalInertManaged = "true";
          child.dataset.modalPrevInert = child.inert ? "true" : "false";
          child.dataset.modalPrevAriaPresent = child.hasAttribute("aria-hidden") ? "true" : "false";
          child.dataset.modalPrevAriaHidden = child.getAttribute("aria-hidden") || "";
        }
        child.inert = true;
        child.setAttribute("aria-hidden", "true");
      } else if (child.dataset.modalInertManaged === "true") {
        child.inert = child.dataset.modalPrevInert === "true";
        if (child.dataset.modalPrevAriaPresent === "true") {
          child.setAttribute("aria-hidden", child.dataset.modalPrevAriaHidden || "");
        } else {
          child.removeAttribute("aria-hidden");
        }
        delete child.dataset.modalInertManaged;
        delete child.dataset.modalPrevInert;
        delete child.dataset.modalPrevAriaPresent;
        delete child.dataset.modalPrevAriaHidden;
      }
    });
  }

  window.NOVEL_MODAL_A11Y = { sync: syncModalBackgroundInert };

  function syncResponsiveDrawerAccessibility() {
    const chapters = document.querySelector("#view-write .rail-left");
    const inspector = document.querySelector("#view-write .rail-right");
    const chaptersHidden = window.matchMedia("(max-width: 1049px)").matches && !document.body.classList.contains("chapters-open");
    const inspectorHidden = window.matchMedia("(max-width: 1199px)").matches && !document.body.classList.contains("inspector-open");
    for (const [drawer, hidden] of [[chapters, chaptersHidden], [inspector, inspectorHidden]]) {
      if (!drawer) continue;
      drawer.inert = hidden;
      if (hidden) drawer.setAttribute("aria-hidden", "true");
      else drawer.removeAttribute("aria-hidden");
    }
  }

  function setChapterDrawer(open, restoreFocus) {
    const active = !!open;
    const rail = document.querySelector("#view-write .rail-left");
    const hadFocus = rail?.contains(document.activeElement);
    document.body.classList.toggle("chapters-open", active);
    $("btnOpenChapters")?.setAttribute("aria-expanded", active ? "true" : "false");
    syncResponsiveDrawerAccessibility();
    if (active) window.setTimeout(() => $("chapterList")?.querySelector("button")?.focus(), 60);
    else if (hadFocus || restoreFocus) $("btnOpenChapters")?.focus();
  }

  function setInspectorDrawer(open, restoreFocus) {
    const active = !!open;
    const rail = document.querySelector("#view-write .rail-right");
    const hadFocus = rail?.contains(document.activeElement);
    document.body.classList.toggle("inspector-open", active);
    $("btnOpenInspector")?.setAttribute("aria-expanded", active ? "true" : "false");
    syncResponsiveDrawerAccessibility();
    if (active) window.setTimeout(() => document.querySelector(".inspector-tab.active")?.focus(), 60);
    else if (hadFocus || restoreFocus) $("btnOpenInspector")?.focus();
  }

  $("writeChaptersScrim")?.addEventListener("click", () => setChapterDrawer(false, true));
  $("writeTaskScrim")?.addEventListener("click", () => setInspectorDrawer(false, true));
  syncResponsiveDrawerAccessibility();
  window.addEventListener("resize", syncResponsiveDrawerAccessibility);

  let editingTaskId = null;
  /** 是否连上本地书库服务 */
  let vaultOnline = false;
  let vaultPath = "";
  /** @type {ReturnType<typeof setTimeout>|null} */
  let diskTimer = null;
  /** 当前磁盘保存 Promise；上下文切换必须等待它结束，不能把失败吞掉。 */
  let bootDone = false;
  /** 后一次 switchMode 作废仍在 await flush 的前一次，避免延迟切视图盖掉用户已经回到的写章台。 */
  let switchEpoch = 0;
  let dirty = false;
  const fallbackProjectRevisions = new Map();
  const projectSaveRevisions = UiShell?.createRevisionTracker?.(
    (item) => item?.id || item?.slug || "active-project"
  ) || {
    read(item) {
      return fallbackProjectRevisions.get(item?.id || item?.slug || "active-project") || 0;
    },
    bump(item) {
      const key = item?.id || item?.slug || "active-project";
      const next = (fallbackProjectRevisions.get(key) || 0) + 1;
      fallbackProjectRevisions.set(key, next);
      return next;
    },
    matches(item, revision) {
      return this.read(item) === Number(revision || 0);
    },
  };
  let generationHideTimer = null;
  let composerReviewState = null;
  let modalReturnFocus = null;
  /** 磁盘 book.json mtime，用于外部修改检测 */
  let diskMtime = 0;
  /** 用户拒绝重载时记录的磁盘 mtime，避免反复弹窗但仍可再次提示若继续变化 */
  let dismissedMtime = 0;
  let libraryBooks = [];
  let focusCheckBusy = false;
  /** 正在流式生成的章节 id（与 UI 选中解耦，防串章） */
  let writingChapterId = null;
  /** 生成锁：禁止切章/切书 */
  let genLocked = false;
  let streamPaintPendingId = null;
  let streamPaintRaf = 0;
  const CLIENT_VERSION = window.NOVEL_APP_VERSION || "0.19.0";
  const Ws = window.NOVEL_WORKSPACE;

  const WritingPresenter = WriteUI.createPresenter({
    getElementById: $,
    querySelector: (selector) => document.querySelector(selector),
    uiShell: UiShell,
    productionState: ProductionState,
    textSignature: (text) => Pipe.textSignature(text),
    getReadOnlyReason: (item) => projectReadOnlyReason(item),
    hasPendingConflict: (item) => projectHasPendingSaveConflict(item),
    isVaultOnline: () => vaultOnline,
    isActiveProject: (item) => project() === item,
    isDirty: () => dirty,
    isGenerationLocked: () => genLocked,
  });
  const renderWritingWelcome = (...args) => WritingPresenter.renderWritingWelcome(...args);
  const renderChapterHeaderState = (...args) => WritingPresenter.renderChapterHeaderState(...args);
  const renderWritingInspector = (...args) => WritingPresenter.renderWritingInspector(...args);
  const handoffPresentation = (chapter) => WriteUI.handoffPresentation(chapter, ProductionState);
  const handoffStatusSuffix = (chapter, pendingLabel) =>
    WriteUI.handoffStatusSuffix(chapter, pendingLabel, ProductionState);

  function project() {
    return state.projects.find((p) => p.id === state.activeId) || state.projects[0];
  }

  /** 后端已保护的外部章节冲突；队列和裁决事务由无 DOM 用例实例统一持有。 */
  const SaveConflicts = ConflictCases.create({
    getProjects: () => state.projects,
    getActiveProject: project,
    now: Date.now,
    savePending: (entries) => Store.savePendingConflicts?.(entries),
    loadPending: () => Store.loadPendingConflicts?.() || [],
    setStatus: setVaultStatus,
    saveRecovery: (item) => Store.saveRecovery?.(item),
    clearRecovery: (item) => Store.clearRecovery?.(item),
    saveCache: () => Store.saveAll(state),
    hideConflictModal: hideSaveConflictModal,
    readRevision: (item) => projectSaveRevisions.read(item),
    revisionMatches: (item, revision) => projectSaveRevisions.matches(item, revision),
    chapterBodiesDiverge: (left, right) => Vault.chapterBodiesDiverge?.(left, right),
    loadDiskSync: loadConflictDiskSync,
    reconcileSavedBook: (item, fresh, warnings) => Vault.reconcileSavedBook?.(item, fresh, warnings),
    pickLocalChapter: (queued, live, disk) =>
      Vault.pickLocalChapterForConflictDisplay?.(queued, live, disk),
    reloadBook: (slug) => Vault.reloadBook(slug),
    renderActive: () => {
      loadWriteView();
      loadControlView();
    },
    setActiveDirty: (item) => {
      if (project() === item) dirty = true;
    },
    openNextConflict: openNextSaveConflict,
    reconcileProductionChapter: (chapter, task) =>
      ProductionState?.reconcileChapter?.(chapter, {
        reason: "冲突裁决采用了磁盘正文，旧质量报告已失效",
        task,
      }),
    alignAfterBodyMutation: alignTaskAfterBodyMutation,
    invalidateAfterAuthorEdit: invalidateProductionAfterAuthorEdit,
    markHandoffStale: (chapter, task, reason) =>
      ChapterState.markHandoffStale(chapter, task, { reason }),
    renderAllActive: () => {
      renderAll();
      loadWriteView();
      loadControlView();
    },
    recomputeDirty: () => {
      dirty = (state.projects || []).some((item) => item?._dirty === true);
    },
    flushProject,
  });

  function normalizedTargetChapters(value) {
    if (typeof Pipe?.normalizeTargetChapters === "function") return Pipe.normalizeTargetChapters(value);
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(400, Math.max(8, Math.round(n))) : 20;
  }

  function bumpProjectRevision(p = project()) {
    invalidateWriteContext();
    return p ? projectSaveRevisions.bump(p) : 0;
  }

  /**
   * packForWrite 要跑检索、挑 canon、按双预算装配，是写章台最重的同步调用。
   * 一次生成里 loadWriteView 会被调用好几次，状态没变就不该重算。
   * 任何改动都会经 markDirty → bumpProjectRevision 把缓存作废，所以计量表不会说谎。
   */
  function invalidateWriteContext() {
    writeContextCache = null;
  }

  function writeContextSignature(p, task, chapter, instruction) {
    return [
      p?.id || "",
      task?.id || "",
      chapter?.id || "",
      chapter?.updatedAt ?? 0,
      (chapter?.body || "").length,
      instruction,
      cfg.contextBudgetChars,
      cfg.contextBudgetTokens,
      cfg.bodyTailChars,
      cfg.prevChapterTailChars,
      cfg.memoryDepth,
      cfg.ragEnabled !== false,
    ].join("\u0000");
  }

  function packWriteContext(p, task, chapter, instruction) {
    const signature = writeContextSignature(p, task, chapter, instruction);
    if (writeContextCache?.signature === signature) return writeContextCache.packed;
    const packed = Ctx.packForWrite(p, task, {
      instruction,
      budget: cfg.contextBudgetChars,
      tokenBudget: cfg.contextBudgetTokens,
      bodyTailChars: cfg.bodyTailChars,
      prevChapterTailChars: cfg.prevChapterTailChars,
      memoryDepth: cfg.memoryDepth,
      autoRag: cfg.ragEnabled !== false,
    });
    writeContextCache = { signature, packed };
    return packed;
  }

  /**
   * craft 打分要扫全章正文，逐键触发会让长章打字发涩。
   * 停手后再算一次；存盘或生成前由 flushCraftRescore 补齐，落盘的分数不会落后于正文。
   */
  function scheduleCraftRescore(chapterId) {
    if (!chapterId) return;
    craftRescorePendingId = chapterId;
    window.clearTimeout(craftRescoreTimer);
    craftRescoreTimer = window.setTimeout(() => runCraftRescore(true), CRAFT_RESCORE_DELAY_MS);
  }

  function runCraftRescore(repaintHint) {
    window.clearTimeout(craftRescoreTimer);
    craftRescoreTimer = null;
    const chapterId = craftRescorePendingId;
    craftRescorePendingId = null;
    if (!chapterId) return;
    const p = project();
    const ch = p?.chapters?.find((c) => c.id === chapterId);
    if (!ch) return;
    if (typeof Pipe.applyCraftSignals !== "function") {
      delete ch.craftScore;
      return;
    }
    const task = p.tasks?.find((t) => t.id === ch.taskId) || { order: ch.order };
    Pipe.applyCraftSignals(p, task, ch, ch.body);
    // 只重画提示条：细纲列表里有作者正在编辑的输入框，不能在这里重建
    if (repaintHint && p.activeChapterId === ch.id) paintCraftHint(ch);
  }

  function flushCraftRescore() {
    if (craftRescorePendingId) runCraftRescore(false);
  }

  function buildWritingFileHints(chapterId) {
    const hints = [];
    if (!chapterId) return hints;
    const p = project();
    const ch = p?.chapters?.find((c) => c.id === chapterId);
    if (!ch) return hints;
    if (ch._file) hints.push(String(ch._file));
    const title = String(ch.title || "").trim();
    if (title) {
      hints.push(`章节/${title}`);
      hints.push(`章节/${title}.md`);
      hints.push(title);
      // 常见落盘名：001-标题.md
      const order = ch.order != null ? String(ch.order).padStart(3, "0") : "";
      if (order) {
        hints.push(`章节/${order}-${title}.md`);
        hints.push(`${order}-${title}`);
      }
    }
    return hints;
  }

  function setGenLock(on, chapterId) {
    genLocked = !!on;
    writingChapterId = on ? chapterId || writingChapterId : null;
    const writingFileHints = genLocked ? buildWritingFileHints(writingChapterId) : [];
    window.__mogaoGen = {
      locked: genLocked,
      writingChapterId,
      writingFileHints,
    };
    document.body.classList.toggle("gen-locked", genLocked);
    document.querySelectorAll(".chap, .lib-main, #projectSelect, #btnNewProject, #btnImportSeed, #btnOpenVaultDir, #btnNewVaultDir, #btnSettingsOpenVault, #btnSettingsNewVault").forEach((el) => {
      if (!el) return;
      if (genLocked) el.setAttribute("disabled", "disabled");
      else el.removeAttribute("disabled");
    });
    // 工作区工具栏在生成中禁用变更
    document.querySelectorAll("#btnWsSave, #btnWsNewNote, #btnWsNewFolder, #btnWsRename, #btnWsDelete").forEach((el) => {
      if (!el) return;
      if (genLocked) el.setAttribute("disabled", "disabled");
      else el.removeAttribute("disabled");
    });
    // 工作区自己合并“生成锁”与“系统镜像”两类只读原因。
    Ws?.syncReadOnly?.({ announce: genLocked });
    // 写章台正文/标题只读，防止生成中串改
    const schemaReadOnly = Boolean(projectReadOnlyReason());
    const ms = $("manuscript");
    if (ms) ms.readOnly = genLocked || schemaReadOnly;
    const ct = $("chapterTitle");
    if (ct) ct.readOnly = genLocked || schemaReadOnly;
    for (const id of ["btnGenerate", "composeMode", "btnDigest", "btnSaveChapter"]) {
      const control = $(id);
      if (control) control.disabled = genLocked || schemaReadOnly;
    }
    if (genLocked && $("chapterMore")) $("chapterMore").open = false;
    if (genLocked) setAutoStatus(( $("autoStatus")?.textContent || "生成中") + " · 已锁定切章");
    // 侧栏在 lock 状态变化后重渲，给按钮 disabled
    if (typeof refreshLibrarySidebar === "function") {
      try {
        refreshLibrarySidebar();
      } catch (_) {}
    }
    const p = project();
    renderChapterHeaderState(p, p?.chapters?.find((chapter) => chapter.id === p.activeChapterId));
  }

  function guardGen(actionLabel) {
    if (!genLocked) return false;
    alert(`正在生成中，无法${actionLabel || "切换"}。请先点「停止」或等待完成。`);
    return true;
  }

  function projectReadOnlyReason(p = project()) {
    if (!p || !ProjectMigrations) return null;
    const compatibility = ProjectMigrations.compatibility?.(p);
    if (!compatibility?.readOnly) return null;
    return {
      kind: "schema",
      code: compatibility.code || "SCHEMA_VERSION_UNSUPPORTED",
      message: `${compatibility.reason}；当前作品已只读保护，请升级 Inkwell 后再编辑`,
    };
  }

  function guardProjectWritable(actionLabel = "修改作品") {
    const reason = projectReadOnlyReason();
    if (!reason) return false;
    setVaultStatus("格式版本较新 · 当前作品只读", "err");
    alert(`${reason.message}\n\n已阻止“${actionLabel}”，磁盘内容没有被覆盖。`);
    return true;
  }

  function setVaultStatus(text, kind) {
    const el = $("vaultStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "vault-status global-status" + (kind ? ` ${kind}` : "");
    el.title = vaultPath || text;
  }

  /** 顶栏显示绝对 vault 路径 */
  function updateVaultPathUI() {
    const full = $("vaultPathFull");
    const label = $("vaultPathLabel");
    const path = vaultPath || "";
    if (full) {
      full.textContent = path || (vaultOnline ? "（路径未知）" : "—");
      full.title = path || "";
    }
    if (label) {
      const p = project();
      label.textContent = vaultOnline
        ? p?.slug
          ? `books/${p.slug}`
          : path
            ? "本地书库"
            : "本地书库"
        : "未连接本地服务（仅浏览器缓存）";
      label.title = path || label.textContent;
    }
  }

  /** Tauri invoke（可选）；无桥或失败返回 null */
  async function tauriInvoke(cmd, args) {
    try {
      const core = window.__TAURI__?.core;
      if (core?.invoke) return await core.invoke(cmd, args || {});
      if (window.__TAURI__?.invoke) return await window.__TAURI__.invoke(cmd, args || {});
      if (window.__TAURI_INTERNALS__?.invoke) {
        return await window.__TAURI_INTERNALS__.invoke(cmd, args || {});
      }
    } catch (e) {
      console.warn("tauri invoke failed", cmd, e);
      throw e;
    }
    return null;
  }

  function isTauri() {
    return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  }

  /** 兼容旧调用：委托 vault-ui */
  function isVaultOpOk(res) {
    return window.NOVEL_VAULT_UI?.isVaultOpOk
      ? window.NOVEL_VAULT_UI.isVaultOpOk(res)
      : !!(res && res.ok !== false && !res.cancelled && !res.error);
  }

  /** 空库时自动建一本空白书（vault-ui / afterVaultSwitch / boot 共用） */
  async function ensureEmptyVaultBook() {
    if (state.projects?.length) return state.projects[0];
    try {
      const p = await Vault.createBook("新书", "");
      state = { projects: [p], activeId: p.id };
      Store.saveAll(state);
      Store.saveMeta({ activeId: p.id, activeSlug: p.slug, vaultPath });
      setVaultStatus(`已建空白书 · ${p.slug}`, "ok");
      return p;
    } catch (e) {
      console.warn("ensureEmptyVaultBook", e);
      setVaultStatus("空库建书失败: " + (e.message || e), "err");
      return null;
    }
  }

  /** 开/建库后清空状态并重新 boot 书库（供 vault-ui 调用） */
  async function afterVaultSwitch(res) {
    if (res?.vaultPath) vaultPath = res.vaultPath;
    else if (res?.path) vaultPath = res.path;
    else if (res?.vault) vaultPath = res.vault;
    vaultOnline = true;
    state = { projects: [], activeId: null };
    libraryBooks = [];
    SaveConflicts.reset();
    diskMtime = 0;
    dismissedMtime = 0;
    dirty = false;
    Store.saveAll(state);
    Store.saveMeta({ activeId: null, activeSlug: null, vaultPath });
    updateVaultPathUI();
    setVaultStatus("切换书库…", "busy");
    await bootFromVault(true);
    // force 空库会返回 ok=true + projects=[]，必须补建
    if (!state.projects?.length) {
      await ensureEmptyVaultBook();
    }
    await refreshLibraryFromServer();
    updateVaultPathUI();
    renderAll();
    loadPipelineView();
    loadControlView();
    loadWriteView();
    loadGraphView();
    const cur = project();
    if (cur?.slug) {
      try {
        const meta = await Vault.meta(cur.slug);
        diskMtime = meta.mtime || 0;
      } catch (_) {}
      Ws?.bindBook?.(cur.slug, { autoOpen: true });
    } else {
      Ws?.bindBook?.("", { autoOpen: false });
    }
    setVaultStatus(`书库 · ${(state.projects || []).length} 部`, "ok");
  }

  async function pickOpenVault() {
    return window.NOVEL_VAULT_UI?.pickOpenVault?.();
  }

  async function pickCreateVault() {
    return window.NOVEL_VAULT_UI?.pickCreateVault?.();
  }

  async function copyVaultPath() {
    return window.NOVEL_VAULT_UI?.copyVaultPath?.();
  }

  function markDirty() {
    if (projectReadOnlyReason()) {
      setVaultStatus("格式版本较新 · 当前作品只读", "err");
      return false;
    }
    dirty = true;
    const p = project();
    if (p) {
      bumpProjectRevision(p);
      p._dirty = true;
      Store.saveRecovery?.(p);
    }
    if (vaultOnline) setVaultStatus(`未存盘 · ${p?.slug || ""}`, "warn");
    renderChapterHeaderState(p, p?.chapters?.find((chapter) => chapter.id === p.activeChapterId));
    return true;
  }

  function markClean(extra, guard = {}) {
    const p = guard.project || project();
    if (p && guard.revision != null && !projectSaveRevisions.matches(p, guard.revision)) {
      p._dirty = true;
      Store.saveRecovery?.(p);
      Store.saveAll(state);
      dirty = true;
      if (project() === p) setVaultStatus(`较早版本已保存 · ${p.slug || ""} 仍有待存修改`, "warn");
      renderChapterHeaderState(p, p?.chapters?.find((chapter) => chapter.id === p.activeChapterId));
      return false;
    }
    if (p) {
      p._dirty = false;
      Store.clearRecovery?.(p);
      Store.saveAll(state);
    }
    dirty = (state.projects || []).some((item) => item?._dirty === true);
    if (extra && project() === p) setVaultStatus(extra, "ok");
    renderChapterHeaderState(p, p?.chapters?.find((chapter) => chapter.id === p.activeChapterId));
    return true;
  }

  function scheduleDiskSave(immediate = false) {
    const current = project();
    if (projectReadOnlyReason(current)) {
      setVaultStatus("格式版本较新 · 已阻止存盘", "err");
      return;
    }
    if (current) {
      current._dirty = true;
      Store.saveRecovery?.(current);
      Store.saveAll(state);
      renderChapterHeaderState(
        current,
        current?.chapters?.find((chapter) => chapter.id === current.activeChapterId)
      );
    }
    if (!vaultOnline) return;
    if (diskTimer) clearTimeout(diskTimer);
    const run = () => {
      diskTimer = null;
      flushToDisk().catch((e) => {
        console.error(e);
        setVaultStatus("存盘失败: " + (e.message || e), "err");
      });
    };
    if (immediate) run();
    else {
      const delay = Math.max(800, Math.min(5000, Number(cfg?.autosaveDelayMs) || 1200));
      diskTimer = setTimeout(run, delay);
    }
  }

  /** 上下文切换/整本保存前，工作区当前文件必须已经提交到磁盘。 */
  async function ensureWorkspaceSaved(actionLabel = "继续") {
    if (!Ws?.isDirty?.()) return true;
    const saved = await Ws.saveCurrent?.();
    if (!saved || Ws.isDirty?.()) {
      throw new Error(`${actionLabel}期间工作区又产生了新修改；已保留编辑内容，请再次保存后重试`);
    }
    return true;
  }

  /**
   * 工作区打开的 章节/*.md → 写回工程 chapters[].body
   * 按 _file / path / 文件名匹配，避免关窗 PUT book 用旧 body 盖掉 md。
   * @returns {boolean|null} true=已合并；false=章节路径但匹配失败；null=无需合并（非章节）
   */
  function mergeWorkspaceIntoProject(p) {
    const ed = document.getElementById("wsEditor");
    if (!p || !Ws || !ed) return null;
    return PersistenceFactory.mergeWorkspaceChapter(
      p,
      {
        slug: Ws.getSlug?.(),
        dirty: Ws.isDirty?.(),
        path: Ws.getOpenPath?.(),
        content: ed.value,
      },
      {
        chapterBodyFromMarkdown: window.NOVEL_CHAPTER_FORMAT?.chapterBodyFromMarkdown,
        onBodyChanged: (chapter) =>
          invalidateProductionAfterAuthorEdit(
            chapter,
            (p.tasks || []).find((task) => task.id === chapter.taskId),
            "工作区 Markdown 已修改正文，等待重新通过叙事质量闸门"
          ),
      }
    );
  }

  async function saveWorkspaceOnly(p, { announce = false } = {}) {
    const path = Ws?.getOpenPath?.();
    const editor = document.getElementById("wsEditor");
    if (!path || !editor || !p?.slug) return null;
    const snapshot = Ws?.captureSaveState?.() || {
      slug: p.slug,
      path,
      content: editor.value,
    };
    try {
      const result = await Vault.writeFile(p.slug, path, snapshot.content ?? editor.value, snapshot.expectedRevision);
      const cleaned = Ws?.markClean?.(snapshot, result) !== false;
      if (announce) {
        setVaultStatus(
          cleaned
            ? `已存文件（未匹配章节元数据）· ${path}`
            : `较早文件版本已保存 · ${path} 仍有未保存修改`,
          "warn"
        );
      }
      return result;
    } catch (error) {
      if (announce) setVaultStatus("存文件失败: " + (error.message || error), "err");
      throw error;
    }
  }

  function projectHasPendingSaveConflict(p) {
    return SaveConflicts.hasPending(p);
  }

  const Persistence = PersistenceFactory.create({
    isOnline: () => vaultOnline,
    getActiveProject: project,
    assertWritable: (item) => ProjectMigrations.assertWritable(item),
    ensureWorkspaceSaved,
    hasPendingConflict: projectHasPendingSaveConflict,
    openNextConflict: openNextSaveConflict,
    setStatus: setVaultStatus,
    mergeWorkspace: mergeWorkspaceIntoProject,
    saveWorkspaceOnly,
    syncActiveEditor: syncEditorToProject,
    readRevision: (item) => projectSaveRevisions.read(item),
    saveBook: (slug, item) => Vault.saveBook(slug, item),
    createBook: (title) => Vault.createBook(title || "新书", ""),
    loadBook: (slug) => Vault.loadBook(slug),
    resolveBookConflict: (local, disk) => window.NOVEL_VAULT_UI.resolveBookConflict(local, disk),
    renderActive: () => { loadControlView(); loadPipelineView(); loadWriteView(); loadGraphView(); },
    setDiskMtime: (value) => {
      diskMtime = value;
    },
    adoptBaselines: (item, result, warnings) =>
      Vault.adoptChapterBaselines?.(item, result, warnings),
    reconcileWarnings: reconcileSaveWarnings,
    markClean,
    refreshLibrary: refreshLibrarySidebar,
    bumpRevision: bumpProjectRevision,
    now: Date.now,
    saveRecovery: (item) => Store.saveRecovery?.(item),
    saveCache: () => Store.saveAll(state),
    getObservability: () => window.NOVEL_OBSERVABILITY,
  });

  const WriteCases = WriteUseCasesFactory.create({
    pipe: Pipe,
    productionState: ProductionState,
    getProductionEngine: () => window.NOVEL_PRODUCTION_ENGINE,
    uid: () => Store.uid(),
    persistCheckpoint: (item) => {
      Store.saveAll(state);
      Store.saveRecovery?.(item);
    },
    flushProject,
    getObservability: () => window.NOVEL_OBSERVABILITY,
  });

  function isWriteViewActive() {
    return !!document.getElementById("view-write")?.classList.contains("active");
  }

  function isWorkspaceViewActive() {
    return !!document.getElementById("view-workspace")?.classList.contains("active");
  }

  function workspaceChapterPathIsOpen(p) {
    if (!p?.slug || !Ws?.isDirty?.()) return false;
    if (String(Ws.getSlug?.() || "") !== String(p.slug)) return false;
    const wsPath = String(Ws.getOpenPath?.() || "").replace(/\\/g, "/");
    return wsPath === "章节" || wsPath.startsWith("章节/");
  }

  /** 采集静默采纳磁盘的闸门输入。写章台可见时应先 syncEditorToProject。 */
  function diskAdoptFlags(p) {
    let editorDesynced = false;
    if (isWriteViewActive()) {
      const ms = $("manuscript");
      const ch = p?.chapters?.find((chapter) => chapter.id === p.activeChapterId);
      if (ms && ch && String(ms.value || "") !== String(ch.body || "")) editorDesynced = true;
    }
    return {
      generating: !!(genLocked || window.__mogaoGen?.locked),
      dirty: !!(p?._dirty || (dirty && project() === p)),
      pendingConflict: projectHasPendingSaveConflict(p),
      editorDesynced,
      workspaceChapterDirty: workspaceChapterPathIsOpen(p),
      saveInFlight: Persistence.isSaving(),
    };
  }

  function dropProjectConflicts(p, extraSlugs = []) {
    return SaveConflicts.drop(p, extraSlugs);
  }

  function refreshConflictDiskSides(p, freshBook) {
    return SaveConflicts.refresh(p, freshBook);
  }

  function enqueueChapterConflictsIfDiverged(p, freshBook) {
    return SaveConflicts.enqueueDiverged(p, freshBook);
  }

  /**
   * 用磁盘书替换内存工程。silent 必须先过闸门；discard 是作者明确丢掉内存。
   * 打开另一本书走 switchToSlug，不走这里。
   */
  async function replaceMemoryWithDisk(p, fresh, { intent } = {}) {
    if (!p || !fresh) return { replaced: false };
    ProductionState?.reconcileProject?.(fresh, {
      reason: "采用磁盘正文后，旧质量报告已失效",
    });
    const wantSilent = intent !== "discard";
    if (wantSilent) {
      const verdict = Vault.classifyDiskAdopt(diskAdoptFlags(p));
      if (!verdict.ok) return { replaced: false, verdict };
    }
    const prevId = p.id;
    const prevSlug = p.slug;
    const prevActive = p.activeChapterId;
    const prevTask = p.activeTaskId;
    fresh.id = prevId;
    if (prevActive && (fresh.chapters || []).some((chapter) => chapter.id === prevActive)) {
      fresh.activeChapterId = prevActive;
    }
    if (prevTask) fresh.activeTaskId = prevTask;
    const idx = state.projects.findIndex((item) => item.id === prevId || item.slug === prevSlug);
    if (idx >= 0) state.projects[idx] = fresh;
    else state.projects.unshift(fresh);
    const replaced = idx >= 0 ? state.projects[idx] : state.projects[0];
    state.activeId = replaced.id;
    diskMtime = replaced._mtime || 0;
    dismissedMtime = 0;
    if (intent === "discard") {
      replaced._dirty = false;
      dirty = (state.projects || []).some((item) => item?._dirty === true);
      Store.clearRecovery?.(p);
      Store.clearRecovery?.(replaced);
      if (prevSlug && prevSlug !== replaced.slug) {
        Store.clearRecovery?.({ slug: prevSlug, id: prevId });
      }
      dropProjectConflicts(replaced, [prevSlug]);
      Store.saveAll(state);
      if (isWriteViewActive()) loadWriteView();
      if (isWorkspaceViewActive() || Ws?.getSlug?.() === prevSlug || Ws?.getSlug?.() === replaced.slug) {
        try {
          await Ws?.bindBook?.(replaced.slug, { autoOpen: isWorkspaceViewActive() });
        } catch (error) {
          console.warn("replaceMemoryWithDisk bindBook", error);
        }
      }
      setVaultStatus("已从磁盘重载 · 未存盘稿已丢弃", "ok");
      return { replaced: true, project: replaced };
    }
    Store.saveAll(state);
    return { replaced: true, project: replaced };
  }

  function persistSaveConflicts() {
    return SaveConflicts.persist();
  }

  /** 关窗同步 PUT 不能 await reload；XHR 仅留在浏览器适配器。 */
  function loadConflictDiskSync(p) {
    try {
      const gxhr = new XMLHttpRequest();
      gxhr.open("GET", `/api/books/${encodeURIComponent(p.slug)}`, false);
      applySyncAuth(gxhr);
      gxhr.send(null);
      if (UiShell?.isSuccessfulHttpStatus?.(gxhr.status)) {
        return JSON.parse(gxhr.responseText || "null");
      }
    } catch (_) {}
    return null;
  }

  function persistSyncSaveConflicts(p, warnings, saveRevision) {
    return SaveConflicts.persistSync(p, warnings, saveRevision);
  }

  /** 把持久化的本地一侧重新挂回刚从磁盘加载的作品，保持冲突的两份正文。 */
  function hydratePersistedConflictsForProject(p) {
    return SaveConflicts.hydrate(p);
  }

  function restorePersistedSaveConflicts() {
    return SaveConflicts.restore();
  }

  function hideSaveConflictModal() {
    const modal = $("saveConflictModal");
    if (modal) modal.hidden = true;
    syncModalBackgroundInert();
    modalReturnFocus?.focus?.();
    modalReturnFocus = null;
  }

  function closeSaveConflictModal({ keepPending = true } = {}) {
    const pending = SaveConflicts.closeActive({ keepPending });
    hideSaveConflictModal();
    if (keepPending && pending) {
      setVaultStatus(`保存冲突待处理 · ${pending.warning?.path || pending.slug}`, "warn");
    }
  }

  function openNextSaveConflict() {
    const view = SaveConflicts.activateNext();
    if (!view) return false;
    const { entry, localChapter, diskChapter, position, count } = view;
    $("saveConflictChapter").textContent = diskChapter.title || localChapter?.title || "未命名章节";
    $("saveConflictPath").textContent = entry.warning?.path || diskChapter._file || "";
    $("saveConflictQueue").textContent = count > 1 ? `${position + 1} / ${count}` : "1 个冲突";
    $("saveConflictLocal").textContent = localChapter?.body || "（内存中未找到对应章节）";
    $("saveConflictDisk").textContent = diskChapter.body || "（磁盘正文为空）";
    $("saveConflictMerge").value = localChapter?.body || diskChapter.body || "";
    $("btnConflictKeepLocal").disabled = !localChapter;
    modalReturnFocus = document.activeElement;
    $("saveConflictModal").hidden = false;
    syncModalBackgroundInert($("saveConflictModal"));
    window.setTimeout(() => $("saveConflictModal")?.querySelector(".modal")?.focus(), 0);
    return true;
  }

  async function reconcileSaveWarnings(
    p,
    warnings,
    submittedRevision = projectSaveRevisions.read(p)
  ) {
    return SaveConflicts.reconcileWarnings(p, warnings, submittedRevision);
  }

  async function resolveActiveSaveConflict(choice) {
    return SaveConflicts.resolve(choice, {
      mergeBody: choice === "merge" ? $("saveConflictMerge").value : "",
    });
  }

  async function flushToDisk() {
    return Persistence.flushCurrent();
  }

  /**
   * 落盘固定书对象（连写闭包 p），不经 project() 以免切书后写错本。
   * 与 flushToDisk 共用 Persistence 的单航班队列，禁止并发写盘。
   */
  async function flushProject(p) {
    return Persistence.flushProject(p);
  }

  /** 切换书库前的统一事务门禁：阻止生成中切换，并确保工作区与当前书均已落盘。 */
  async function prepareVaultSwitch() {
    if (guardGen("切换书库")) return false;
    try {
      const cur = project();
      // 新格式作品只读浏览时允许离开；不能为了“切换”先拿旧客户端回写它。
      if (projectReadOnlyReason(cur)) return true;
      await ensureWorkspaceSaved("切换书库");
      syncEditorToProject();
      if (vaultOnline && cur?.slug && !cur._stub) await flushToDisk();
      else Store.saveAll(state);
      return true;
    } catch (e) {
      console.error("prepareVaultSwitch", e);
      setVaultStatus("切库前存盘失败: " + (e.message || e), "err");
      alert("当前作品未能安全存盘，已取消切换书库。\n\n" + (e.message || e));
      return false;
    }
  }

  /** 同步 XHR 附加 token（beforeunload 路径不能用 async fetch） */
  function applySyncAuth(xhr) {
    const t =
      (Vault && typeof Vault.getToken === "function" && Vault.getToken()) ||
      String(window.__MOGAO_TOKEN || "").trim();
    if (t) xhr.setRequestHeader("X-Mogao-Token", t);
  }

  function assertSyncRequestSucceeded(xhr, label) {
    if (UiShell?.isSuccessfulHttpStatus?.(xhr?.status)) return;
    const status = Number(xhr?.status) || 0;
    throw new Error(`${label}失败（HTTP ${status || "无响应"}）`);
  }

  /** 桌面关窗同步钩子：WS dirty → merge chapter → PUT file；merge 失败则不 PUT book */
  window.__mogaoFlushSync = () => {
    try {
      if (Persistence.isSaving()) {
        console.warn("[inkwell] skip synchronous book save: async save in flight");
        return false;
      }
      const p = project();
      if (projectReadOnlyReason(p)) {
        console.warn("[inkwell] skip synchronous save: project schema is read-only");
        return false;
      }
      if (projectHasPendingSaveConflict(p)) {
        console.warn("[inkwell] skip synchronous book save: unresolved external conflict");
        return false;
      }
      let merged = null;
      let workspaceSnapshot = null;
      // A1：Ws dirty 且有 openPath：先 PUT file；章节路径 merge 失败则禁止整本 PUT
      if (Ws?.isDirty?.()) {
        const wsSlug = Ws.getSlug?.();
        const wsPath = Ws.getOpenPath?.();
        const ed = document.getElementById("wsEditor");
        if (!wsSlug || !wsPath || !ed) throw new Error("资料文件缺少可保存的书目或路径");
        workspaceSnapshot = Ws.captureSaveState?.() || {
          slug: wsSlug,
          path: wsPath,
          content: ed.value,
        };
        if (p) merged = mergeWorkspaceIntoProject(p);
        if (merged === true) {
          bumpProjectRevision(p);
          p._dirty = true;
          dirty = true;
          Store.saveRecovery?.(p);
        }
        const fxhr = new XMLHttpRequest();
        fxhr.open("PUT", `/api/books/${encodeURIComponent(wsSlug)}/file`, false);
        fxhr.setRequestHeader("Content-Type", "application/json");
        applySyncAuth(fxhr);
        fxhr.send(JSON.stringify({ path: wsPath, content: workspaceSnapshot.content, expectedRevision: workspaceSnapshot.expectedRevision }));
        assertSyncRequestSucceeded(fxhr, "资料文件同步保存");
        if (Ws.markClean?.(workspaceSnapshot, JSON.parse(fxhr.responseText || "{}")) === false) {
          throw new Error("资料文件保存期间出现了更新版本");
        }
      }
      syncEditorToProject();
      if (p && merged === null) merged = mergeWorkspaceIntoProject(p);
      Store.saveAll(state);
      // A1：章节 merge 失败时只信文件，不 PUT book（避免旧 body 盖 md）
      if (merged === false) {
        console.warn("[inkwell] skip PUT book: chapter file saved but not matched in project.chapters");
        return !Ws?.isDirty?.();
      }
      if (vaultOnline && p?.slug) {
        const saveRevision = projectSaveRevisions.read(p);
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/books/${encodeURIComponent(p.slug)}`, false);
        xhr.setRequestHeader("Content-Type", "application/json");
        applySyncAuth(xhr);
        xhr.send(JSON.stringify(Vault.prepareProjectForSave(p)));
        assertSyncRequestSucceeded(xhr, "作品同步保存");
        let saveResult = {};
        try {
          saveResult = JSON.parse(xhr.responseText || "{}") || {};
        } catch (_) {
          saveResult = {};
        }
        const warnings = Array.isArray(saveResult.saveWarnings) ? saveResult.saveWarnings : [];
        if (warnings.some((warning) => warning?.kind === "externalConflict" ||
          (warning?.kind === "preservedExternal" && p.chapters?.some((chapter) =>
            chapter.id === warning.chapterId || chapter._file === warning.path)))) {
          persistSyncSaveConflicts(p, warnings, saveRevision);
          persistSaveConflicts();
          return false;
        }
        if (saveResult.path) p._path = saveResult.path;
        if (saveResult.mtime) diskMtime = saveResult.mtime;
        Vault.adoptChapterBaselines?.(p, saveResult, warnings);
        markClean("", { project: p, revision: saveRevision });
      }
      return !Ws?.isDirty?.() && !(vaultOnline && dirty);
    } catch (e) {
      console.warn("flush sync", e);
      return false;
    }
  };

  const filterMigrateProjects = ProjectMigrations.filterMigratableProjects;

  function assertMigrationComplete(result, expected) {
    const migrated = Array.isArray(result?.migrated) ? result.migrated.length : 0;
    if (result?.ok === false || migrated !== expected) {
      throw new Error(`迁移不完整：请求 ${expected} 部，服务端确认 ${migrated} 部；原缓存已保留`);
    }
    return result;
  }

  /** 持久化：编辑器→内存→localStorage 缓存→（防抖）磁盘 vault */
  function save(opts = {}) {
    const p = project();
    if (projectReadOnlyReason(p)) return false;
    if (p) p.updatedAt = Date.now();
    if (!opts.skipEditorSync) syncEditorToProject();
    Store.saveAll(state);
    // 生成中避免整页重渲打断流式
    if (!opts.skipRender && !genLocked) renderAll();
    else if (!opts.skipRender && genLocked) {
      renderPipeLog();
      renderPlanPreview();
    }
    if (!opts.skipDisk) {
      // 系统保存不假装「用户未存盘」；仅排队写盘
      if (opts.userEdit) markDirty();
      else bumpProjectRevision(p);
      scheduleDiskSave(!!opts.immediateDisk);
    }
  }

  /** 仅缓存，不强制把编辑器写回（切章后编辑器已是新章）。仍会排队写盘。 */
  function persistOnly(opts = {}) {
    const p = project();
    if (p) p.updatedAt = Date.now();
    Store.saveAll(state);
    if (!opts.skipDisk) {
      if (opts.userEdit) markDirty();
      else bumpProjectRevision(p);
      scheduleDiskSave(!!opts.immediateDisk);
    }
  }

  function refreshLibrarySidebar() {
    const Lib = window.NOVEL_LIBRARY;
    if (!Lib) return;
    const active = project()?.slug;
    const model = Lib.buildSidebarModel(
      libraryBooks,
      state.projects,
      $("libFilter")?.value,
      vaultOnline
    );
    Lib.renderSidebarState(model);
    if (model.clearList) return;
    Lib.renderSidebar(model.books, active, {
      onSelect: async (slug) => {
        await switchToSlug(slug);
        setLibraryDrawer(false, true);
      },
      onOpen: (slug) => Vault.revealBook(slug).catch((e) => alert(e.message || e)),
      onRename: async (slug, title) => {
        const name = prompt("新书名", title || slug);
        if (name === null) return;
        const trimmed = String(name).trim();
        if (!trimmed) return;
        const renameFolder = confirm("是否同时修改文件夹名（slug）？");
        const idx = state.projects.findIndex((item) => item.slug === slug);
        const target = idx >= 0 ? state.projects[idx] : null;
        if (target && project() === target) syncEditorToProject();
        try {
          if (vaultOnline && target?.slug && !target._stub) await flushProject(target);
        } catch (e) {
          alert("改名前未能安全存盘，已取消。\n\n" + (e.message || e));
          return;
        }
        try {
          const saved = await Vault.renameBook(slug, {
            title: trimmed,
            renameFolder,
          });
          // rename 返回 { ok, slug, book, renamedFolder } 时取 book；只补丁元数据，不换 chapters
          const bookPayload = saved?.book && typeof saved.book === "object" ? saved.book : saved;
          const newSlug = saved?.slug || saved?.newSlug || bookPayload?.slug || slug;
          const renamedFolder = !!(saved?.renamedFolder || (renameFolder && newSlug !== slug));
          if (target) {
            const prevId = target.id;
            target.title = saved?.title || bookPayload?.title || trimmed;
            target.slug = newSlug;
            Vault.adoptDiskConcurrencyMeta?.(target, bookPayload);
            for (const entry of SaveConflicts.list()) {
              if (entry.slug === slug) entry.slug = newSlug;
              if (entry.projectId === prevId) entry.projectId = target.id;
            }
            persistSaveConflicts();
            if (state.activeId === prevId || project()?.slug === slug || project() === target) {
              state.activeId = prevId;
              if (bookPayload?._mtime) diskMtime = bookPayload._mtime;
            }
          }
          Store.saveAll(state);
          Store.saveMeta({
            activeId: state.activeId,
            activeSlug: project()?.slug || newSlug,
            vaultPath,
          });
          await refreshLibraryFromServer();
          renderAll();
          if (newSlug !== slug && project()?.slug === newSlug) {
            Ws?.bindBook?.(newSlug, { autoOpen: false });
          }
          if (renamedFolder && newSlug !== slug) {
            setVaultStatus(`新路径 books/${newSlug}`, "ok");
            alert(
              `文件夹已改为 books/${newSlug}，请使用新路径；旧书签/外部链接需更新`
            );
          }
        } catch (e) {
          alert("重命名失败: " + (e.message || e));
        }
      },
      onDelete: async (slug, title) => {
        if (guardGen("删除书目")) return;
        if (!confirm(`删除本地书夹「${title || slug}」？\n不可恢复（.history 一并删除）。`)) return;
        try {
          await Vault.deleteBook(slug);
          SaveConflicts.removeSlug(slug);
          state.projects = state.projects.filter((p) => p.slug !== slug);
          if (!state.projects.length) {
            if (confirm("书库已空。是否创建一本新的空白书？")) {
              const p = await Vault.createBook("新书", "");
              state.projects = [p];
              state.activeId = p.id;
            } else {
              state.activeId = null;
            }
          } else {
            state.activeId = state.projects[0].id;
          }
          Store.saveAll(state);
          await refreshLibraryFromServer();
          renderAll();
          if (state.activeId) {
            loadPipelineView();
            loadWriteView();
          }
        } catch (e) {
          alert("删除失败: " + (e.message || e));
        }
      },
    });
  }

  async function refreshLibraryFromServer() {
    if (!vaultOnline) return;
    try {
      const lib = await Vault.library();
      libraryBooks = lib.books || [];
      vaultPath = lib.vault || vaultPath;
      updateVaultPathUI();
      refreshLibrarySidebar();
      renderProjects();
    } catch (e) {
      console.warn(e);
    }
  }

  async function switchToSlug(slug) {
    if (!slug) return;
    if (guardGen("切换书目")) return;
    const cur = project();
    if (cur?.slug === slug && !cur._stub) return;
    try {
      await ensureWorkspaceSaved("切换书目");
    } catch (e) {
      setVaultStatus("切书前资料文件存盘失败: " + (e.message || e), "err");
      alert("当前资料文件未能安全存盘，已取消切换。\n\n" + (e.message || e));
      return;
    }
    syncEditorToProject();
    // 当前书若是完整书才 flush；stub 无意义
    if (cur?.slug && !cur._stub) {
      try {
        await flushToDisk();
      } catch (e) {
        setVaultStatus("切书前存盘失败: " + (e.message || e), "err");
        alert("当前作品未能安全存盘，已取消切换。\n\n" + (e.message || e));
        return;
      }
    }
    let target = state.projects.find((p) => p.slug === slug);
    if (!target || target._stub || vaultOnline) {
      try {
        const fresh = await Vault.loadBook(slug);
        if (target) {
          fresh.id = target.id;
          const idx = state.projects.findIndex((p) => p.id === target.id);
          // 打开另一本书：当前书已 flush 或取消，不是静默用磁盘盖未存盘稿。
          if (idx >= 0) state.projects[idx] = fresh;
          target = state.projects[idx];
        } else {
          if (!fresh.id) fresh.id = Store.uid();
          state.projects.push(fresh);
          target = fresh;
        }
        diskMtime = fresh._mtime || 0;
        dismissedMtime = 0;
      } catch (e) {
        if (!target) {
          alert("打开失败: " + (e.message || e));
          return;
        }
      }
    }
    hydratePersistedConflictsForProject(target);
    state.activeId = target.id;
    Store.saveAll(state);
    Store.saveMeta({ activeId: target.id, activeSlug: target.slug, vaultPath });
    dirty = projectHasPendingSaveConflict(target) || (state.projects || []).some((item) => item?._dirty === true);
    renderAll();
    loadPipelineView();
    loadControlView();
    loadWriteView();
    loadGraphView();
    refreshLibrarySidebar();
    if (document.getElementById("view-workspace")?.classList.contains("active")) {
      Ws?.bindBook?.(slug, { autoOpen: true });
    }
    if (projectHasPendingSaveConflict(target)) {
      setVaultStatus(`保存冲突待处理 · ${slug}`, "warn");
      openNextSaveConflict();
    } else {
      setVaultStatus(`当前 · ${slug}`, "ok");
    }
    setLibraryDrawer(false, true);
  }

  async function checkExternalChange() {
    if (!vaultOnline || focusCheckBusy || !bootDone || genLocked) return;
    const p = project();
    if (!p?.slug) return;
    focusCheckBusy = true;
    try {
      await Persistence.waitForIdle();
      const meta = await Vault.meta(p.slug);
      if (!meta?.mtime) return;
      if (!diskMtime) {
        diskMtime = meta.mtime;
        return;
      }
      if (meta.mtime <= diskMtime + 500) return;
      // 用户刚拒绝过同一版磁盘，不再烦；若 mtime 又变了则再问
      if (dismissedMtime && meta.mtime <= dismissedMtime + 500) return;

      if (isWriteViewActive()) syncEditorToProject();
      const flags = diskAdoptFlags(p);
      const verdict = Vault.classifyDiskAdopt(flags);

      if (!verdict.ok && (flags.pendingConflict || flags.dirty || flags.editorDesynced || flags.workspaceChapterDirty)) {
        if (!flags.pendingConflict) {
          const go = confirm(
            "磁盘与写章台正文不一致，将打开冲突裁决（不会静默丢字）。\n\n确定 = 对照两边正文\n取消 = 先留在写章台"
          );
          if (!go) {
            dismissedMtime = meta.mtime;
            setVaultStatus("保留内存稿 · 磁盘有更新", "warn");
            return;
          }
        }
        const fresh = await Vault.reloadBook(p.slug);
        refreshConflictDiskSides(p, fresh);
        const added = enqueueChapterConflictsIfDiverged(p, fresh);
        dismissedMtime = meta.mtime;
        if (added || projectHasPendingSaveConflict(p)) openNextSaveConflict();
        else setVaultStatus("磁盘可能已变 · 写章台未存盘正文仍保留", "warn");
        return;
      }

      if (!confirm("检测到外部修改，从磁盘重载？")) {
        dismissedMtime = meta.mtime;
        setVaultStatus("已跳过外部重载", "warn");
        return;
      }
      const fresh = await Vault.reloadBook(p.slug);
      const replaced = await replaceMemoryWithDisk(p, fresh, { intent: "silent" });
      if (!replaced.replaced) {
        setVaultStatus(replaced.verdict?.reason || "未从磁盘覆盖内存", "warn");
        return;
      }
      renderAll();
      loadWriteView();
      loadControlView();
      setVaultStatus("已从磁盘重载", "ok");
    } catch (e) {
      console.warn("focus check", e);
    } finally {
      focusCheckBusy = false;
    }
  }

  function syncEditorToProject() {
    const p = project();
    if (!p) return;
    const form = WriteUI.captureProjectForm($, {
      graphReady:
        p._graphFormReady || document.getElementById("view-graph")?.classList.contains("active"),
    });
    if (
      PersistenceFactory.applyProjectForm(p, form, {
        normalizeTargetChapters: normalizedTargetChapters,
        recoverStylePacing: UiShell?.recoverConcatenatedStylePacing,
      })
    ) {
      markDirty();
    }

    // 正文：写章台可见，或当前编辑器属于激活章时
    const writeActive = document.getElementById("view-write")?.classList.contains("active");
    if (!writeActive) return;
    // 生成锁定期：只允许把编辑器写回 writingChapter（若用户仍停在该章）
    const targetId = p.activeChapterId;
    if (genLocked && writingChapterId && targetId !== writingChapterId) return;
    const ch = p.chapters.find((c) => c.id === targetId);
    if (ch && $("manuscript")) {
      const nextTitle = $("chapterTitle").value.trim() || ch.title;
      const nextBody = $("manuscript").value;
      if (!formTextEqual(ch.title, nextTitle) || ch.body !== nextBody) {
        ch.title = nextTitle;
        ch.body = nextBody;
        ch.updatedAt = Date.now();
        markDirty();
      }
    }
    if (ch && $("beatSceneList") && window.NOVEL_WRITE_UI) {
      const nextPlan = window.NOVEL_WRITE_UI.collectBeatPlan($("beatSceneList"), ch.beatPlan || {});
      const prevNorm = window.NOVEL_CRAFT?.normalizeBeatPlan?.(ch.beatPlan || {}) || ch.beatPlan || {};
      const nextNorm = window.NOVEL_CRAFT?.normalizeBeatPlan?.(nextPlan) || nextPlan;
      if (!projectFormEqual(prevNorm, nextNorm)) {
        ch.beatPlan = nextPlan;
        markDirty();
      } else {
        ch.beatPlan = nextPlan;
      }
    }
    // 打分是防抖的：落盘或生成前必须补齐，不能让磁盘上的分数落后于正文
    flushCraftRescore();
  }

  /**
   * 切换章节：先把旧章从编辑器刷回，再换 active，再把新章灌进编辑器，最后落盘。
   * 旧逻辑是先改 activeChapterId 再 save()→sync，会把第 N 章正文写进点中的那一章。
   */
  function selectChapter(chapterId) {
    if (guardGen("切换章节")) return;
    const p = project();
    if (!p || !chapterId) return;
    if (chapterId === p.activeChapterId) {
      loadWriteView();
      return;
    }

    captureWritingPosition(true);

    // 1) 把编辑器内容写回「切换前」的那一章
    const prevId = p.activeChapterId;
    const prev = p.chapters.find((c) => c.id === prevId);
    if (prev && $("manuscript")) {
      prev.title = $("chapterTitle").value.trim() || prev.title;
      prev.body = $("manuscript").value;
      prev.updatedAt = Date.now();
    }

    // 2) 切换激活章 / 任务
    p.activeChapterId = chapterId;
    const ch = p.chapters.find((c) => c.id === chapterId);
    if (ch?.taskId) {
      const task = p.tasks.find((t) => t.id === ch.taskId);
      if (task) p.activeTaskId = task.id;
    }

    // 3) 先把新章灌进编辑器，再任何 save/sync 都不会串章
    if (ch && $("chapterTitle") && $("manuscript")) {
      $("chapterTitle").value = ch.title || "";
      $("manuscript").value = ch.body || "";
      $("chapterWords").textContent = `${words(ch.body)} 字`;
    }

    // 4) 落盘（跳过 editor sync，编辑器已是新章）
    persistOnly({ immediateDisk: true });
    loadWriteView();
  }

  function setStatus(t, kind) {
    const el = $("statusChip");
    if (!el) return;
    el.textContent = t;
    el.className = kind || "muted";
    el.dataset.tone = kind || "muted";
    updateGenerationProgress(t, kind);
  }

  function updateGenerationProgress(label, kind) {
    const progress = $("generationProgress");
    if (!progress) return;
    const rail = UiShell?.generationRailState?.(label, kind);
    if (!rail) return;
    window.clearTimeout(generationHideTimer);
    progress.hidden = false;
    const byStage = new Map(rail.stages.map((item) => [item.stage, item]));
    progress.querySelectorAll("[data-gen-stage]").forEach((node) => {
      const item = byStage.get(node.dataset.genStage);
      node.classList.toggle("done", Boolean(item?.done));
      node.classList.toggle("active", Boolean(item?.active));
      node.classList.toggle("failed", Boolean(item?.failed));
    });
    if (rail.settled) {
      generationHideTimer = window.setTimeout(() => {
        progress.hidden = true;
        progress.querySelectorAll("[data-gen-stage]").forEach((node) => {
          node.classList.remove("done", "active", "failed");
        });
      }, rail.hideAfterMs);
    }
  }

  function clearComposerReview() {
    composerReviewState = null;
    if ($("composerReview")) $("composerReview").hidden = true;
  }

  function captureComposerSnapshot(p, chapter, kind) {
    return ComposerReview.capture(p, chapter, kind);
  }

  function showComposerReview(snapshot, chapter, opts = {}) {
    if (!snapshot || !chapter || snapshot.chapterId !== chapter.id) return;
    composerReviewState = ComposerReview.seal(snapshot, chapter, opts);
    const view = ComposerReview.presentation(composerReviewState, words, opts);
    if ($("composerReviewKicker")) $("composerReviewKicker").textContent = view.kicker;
    if ($("composerReviewTitle")) $("composerReviewTitle").textContent = view.title;
    if ($("composerReviewMeta")) $("composerReviewMeta").textContent = view.meta;
    const undo = $("btnUndoComposerResult");
    if (undo) {
      undo.disabled = !view.canUndo;
      undo.title = view.undoTitle;
    }
    if ($("composerReview")) $("composerReview").hidden = false;
  }

  function syncComposerReviewForChapter(p, chapter) {
    if (!composerReviewState) return;
    if (!ComposerReview.stillApplies(composerReviewState, p, chapter)) clearComposerReview();
  }

  function undoComposerReview() {
    if (!composerReviewState?.canUndo || guardGen("撤销生成结果")) return;
    const p = project();
    const chapter = p?.chapters?.find((item) => item.id === composerReviewState.chapterId);
    if (!ComposerReview.canUndo(composerReviewState, p, chapter)) {
      clearComposerReview();
      setStatus("正文已继续修改 · 无法撤销旧结果", "warn");
      return;
    }
    ComposerReview.restore(
      composerReviewState,
      chapter,
      p.tasks?.find((task) => task.id === composerReviewState.taskId)
    );
    clearComposerReview();
    markDirty();
    Store.saveAll(state);
    scheduleDiskSave(true);
    loadWriteView();
    setStatus("已撤销本次 AI 结果", "muted");
    $("manuscript")?.focus();
  }

  function setInspectorTab(name, opts = {}) {
    const target = ["task", "continuity", "memory"].includes(name) ? name : "task";
    document.querySelectorAll(".inspector-tab").forEach((tab) => {
      const active = tab.dataset.inspectorTarget === target;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".inspector-panel").forEach((panel) => {
      const active = panel.id === `inspector-${target}`;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    uiState.inspectorTab = target;
    if (opts.open !== false) {
      document.body.classList.add("inspector-open");
      if (window.innerWidth >= 1200) setPanelCollapsed("writeTask", false, false);
    }
    if (opts.persist !== false) persistUiState(false);
    if (opts.focus) {
      document.querySelector(`.inspector-tab[data-inspector-target="${target}"]`)?.focus();
    }
  }

  function setSettingsTab(name, opts = {}) {
    const buttons = [...document.querySelectorAll(".settings-nav-item")];
    const target = buttons.find((button) => button.dataset.settingsTarget === name) || buttons[0];
    if (!target) return;
    const targetName = target.dataset.settingsTarget;
    buttons.forEach((button) => {
      const active = button === target;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
      const active = panel.dataset.settingsPanel === targetName;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    if (opts.focus) target.focus();
  }

  function moveRovingTab(current, selector, key, activate) {
    const tabs = [...document.querySelectorAll(selector)];
    if (!tabs.length) return;
    const index = Math.max(0, tabs.indexOf(current));
    let nextIndex;
    if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = tabs.length - 1;
    else {
      const delta = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
      nextIndex = (index + delta + tabs.length) % tabs.length;
    }
    const next = tabs[nextIndex];
    activate(next);
  }

  function setFocusMode(enabled, persist) {
    const active =
      !!enabled && !!document.getElementById("view-write")?.classList.contains("active");
    document.body.classList.toggle("focus-mode", active);
    const btn = $("btnFocusMode");
    if (btn) {
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.textContent = active ? "退出专注" : "专注";
    }
    uiState.focusMode = active;
    if (persist !== false) persistUiState(false);
  }

  function setAutoStatus(t) {
    const el = $("autoStatus");
    if (el) el.textContent = t;
  }

  function setChapterCycleStatus(scope, stage) {
    const rawStage = String(stage || "");
    setAutoStatus(scope ? `${scope}:${rawStage}` : rawStage);
    const presentation = UiShell?.generationStagePresentation?.(rawStage);
    if (presentation) setStatus(presentation.label, presentation.kind);
  }

  function words(text) {
    return TextMetrics.countWords(text);
  }

  function writeDeskHasPendingDiskFlush() {
    const p = project();
    return !!(dirty || p?._dirty || diskTimer);
  }

  async function switchMode(mode) {
    if (guardGen("切换模式")) return;
    if (mode !== "write" && document.body.classList.contains("focus-mode")) {
      setFocusMode(false, true);
    }
    // 离开工作区且有未保存文件
    const wasWs = document.getElementById("view-workspace")?.classList.contains("active");
    if (wasWs && mode !== "workspace" && Ws?.isDirty?.()) {
      if (!confirm("工作区有未保存的文件修改，切换将写入磁盘后继续。取消则留在工作区。\n（建议先 Ctrl+S）")) {
        return;
      }
      // U0-4：确认后先保存当前打开文件，避免切走再回丢稿
      try {
        await Ws.saveCurrent?.();
      } catch (e) {
        console.warn("switchMode saveCurrent", e);
        alert("资料文件保存失败，已取消切换工作区。\n\n" + (e.message || e));
        return;
      }
    }
    // 守卫/确认取消不得占用 epoch，否则会作废仍在冲刷的合法切换。
    const epoch = ++switchEpoch;
    const wasWrite = document.getElementById("view-write")?.classList.contains("active");
    // boot 时 HTML 默认 active 的写章台不是用户离开；有恢复冲突时整本 PUT 会 throw，把启动分区卡死在写章台。
    if (bootDone && wasWrite && mode !== "write") {
      captureWritingPosition(true);
      syncEditorToProject();
      try {
        const p = project();
        if (vaultOnline && p?.slug && !p._stub && writeDeskHasPendingDiskFlush()) {
          if (diskTimer) {
            clearTimeout(diskTimer);
            diskTimer = null;
          }
          await flushToDisk();
        } else {
          await Persistence.waitForIdle();
          Store.saveAll(state);
        }
      } catch (e) {
        setVaultStatus("切离写章台前存盘失败: " + (e.message || e), "err");
        alert("当前章节未能安全存盘，已取消切换。\n\n" + (e.message || e));
        return;
      }
      if (epoch !== switchEpoch) return;
    }
    if (epoch !== switchEpoch) return;
    const section = MODE_SECTION[mode] || mode;
    document.querySelectorAll(".mode").forEach((b) => {
      const active = (b.dataset.section || MODE_SECTION[b.dataset.mode] || b.dataset.mode) === section;
      b.classList.toggle("active", active);
      b.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll(".story-submode").forEach((b) => {
      const active = b.dataset.goMode === mode;
      b.classList.toggle("active", active);
      b.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${mode}`));
    uiState.activeSection = section;
    uiState.hasChosenSection = true;
    if (section === "story") uiState.storyMode = mode;
    persistUiState(false);
    if (mode === "workspace") {
      const p = project();
      const boundSlug = Ws?.getSlug?.() || "";
      const openPath = Ws?.getOpenPath?.() || "";
      // U0-4：同 slug 且已有 openPath → 不 rebind 清空编辑器，仅恢复 watch
      if (p?.slug && boundSlug === p.slug && openPath) {
        Ws?.startWatch?.();
      } else if (p?.slug && boundSlug === p.slug) {
        // 已 bind 同书但无打开文件：不清空树，只 watch
        Ws?.startWatch?.();
      } else {
        // slug 变化或未 bind 才 bindBook
        Ws?.bindBook?.(p?.slug || "", { autoOpen: !!p?.slug });
        Ws?.startWatch?.();
      }
    } else {
      Ws?.stopWatch?.();
    }
    // 从工作区进写章台：闸门通过才静默重载；失败则保留内存稿。
    if (mode === "write") {
      if (vaultOnline && wasWs) {
        await reloadActiveBookFromDisk({ silent: true });
        if (epoch !== switchEpoch) return;
      }
      loadWriteView();
    }
    if (mode === "control") loadControlView();
    if (mode === "graph") {
      loadGraphView();
      window.NOVEL_ANALYZE_UI?.onShow?.();
    }
    if (mode === "analyze") {
      window.NOVEL_ANALYZE_UI?.onShow?.();
    }
    if (mode === "pipeline") loadPipelineView();
  }

  /** 从磁盘 reload 当前书工程到内存。静默路径必须过 classifyDiskAdopt。 */
  async function reloadActiveBookFromDisk(opts = {}) {
    const cur = project();
    if (!cur?.slug || !vaultOnline) return null;
    try {
      if (isWriteViewActive()) syncEditorToProject();
      if (opts.intent === "discard") {
        const fresh = await Vault.reloadBook(cur.slug);
        const result = await replaceMemoryWithDisk(cur, fresh, { intent: "discard" });
        return result.replaced ? result.project : null;
      }
      await Persistence.waitForIdle();
      const flags = diskAdoptFlags(cur);
      const verdict = Vault.classifyDiskAdopt(flags);
      if (!verdict.ok) {
        setVaultStatus(verdict.reason, "warn");
        return null;
      }
      const fresh = await Vault.reloadBook(cur.slug);
      const result = await replaceMemoryWithDisk(cur, fresh, { intent: "silent" });
      if (!result.replaced) {
        setVaultStatus(result.verdict?.reason || verdict.reason, "warn");
        return null;
      }
      if (!opts.silent) setVaultStatus(`已重载 · ${cur.slug}`, "ok");
      return result.project;
    } catch (e) {
      console.warn("reloadActiveBookFromDisk", e);
      if (!opts.silent) setVaultStatus("重载失败: " + (e.message || e), "err");
      return null;
    }
  }

  function renderProjects() {
    const sel = $("projectSelect");
    if (!sel) return;
    sel.innerHTML = "";
    state.projects.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      const mark = p.slug ? "" : "（仅缓存）";
      o.textContent = `${p.title || "未命名"}${mark}`;
      if (p.id === state.activeId) o.selected = true;
      sel.appendChild(o);
    });
    updateVaultPathUI();
    const ver = $("appVersion");
    if (ver) ver.textContent = `v${window.NOVEL_APP_VERSION || "0.19.0"}`;
    refreshLibrarySidebar();
  }

  function renderPipeLog() {
    const p = project();
    const box = $("pipeLog");
    if (!box) return;
    const lines = (p.pipelineLog || []).slice(-40).map((x) => {
      const d = new Date(x.t);
      const ts = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d
        .getSeconds()
        .toString()
        .padStart(2, "0")}`;
      return `[${ts}] ${x.msg}`;
    });
    box.textContent = lines.join("\n") || "暂无日志";
    box.scrollTop = box.scrollHeight;
  }

  function renderPlanPreview() {
    const p = project();
    const el = $("planPreview");
    if (!el) return;
    if (!p.pitch && !p.world) {
      el.textContent = "尚未生成。填写意向后点「一键全自动策划」。";
      return;
    }
    const lines = [];
    const nameLocks = Pipe.collectAuthorNameLocks?.(p) || [];
    if (nameLocks.length) {
      lines.push(`【作者锁名】${nameLocks.map((x) => `${x.role === "heroine" ? "女主" : "男主"}=${x.name}`).join("、")}`);
    }
    lines.push(`【书名候选】${(p.title_candidates || []).join(" / ") || p.title}`);
    lines.push(`【卖点】${p.pitch || "—"}`);
    lines.push(`【类型】${p.genre || ""} ${p.sub_genre || ""}`);
    lines.push(`【钩子】${(p.hooks || []).join("；")}`);
    lines.push(`【文风】${p.tone || ""}`);
    lines.push(`【受众】${p.audience || ""}`);
    if (p.world) {
      lines.push(`【世界】${p.world.era || ""} | ${p.world.power_system || ""}`);
      lines.push(`【势力】${(p.world.factions || []).map((f) => f.name).join("、")}`);
    }
    lines.push(`【人物】${p.cast_summary || Ctx.summarizeNodes(p.graph?.nodes)}`);
    lines.push(`【主线】${p.locks?.logline || p.spine?.logline || "—"}`);
    lines.push(`【任务数】${(p.tasks || []).length}`);
    el.textContent = lines.join("\n");
  }

  function markSteps(active) {
    const p = project();
    const order = ["pitch", "world", "cast", "spine", "ready"];
    const doneUntil = { idea: -1, pitch: 0, world: 1, cast: 2, spine: 3, ready: 4, writing: 4, paused: 4 }[p.stage] ?? -1;
    document.querySelectorAll(".step").forEach((el) => {
      const i = order.indexOf(el.dataset.step);
      el.classList.remove("done", "running", "skip");
      if (el.dataset.step === active) el.classList.add("running");
      else if (i <= doneUntil) el.classList.add("done");
    });
  }

  function refreshAuthorNameHint() {
    const el = $("authorNameLockHint");
    if (!el || !Pipe.collectAuthorNameLocks) return;
    const current = project();
    const ideaEl = $("ideaInput");
    const noteEl = $("authorNote");
    const p = {
      // 控件存在时以控件为准；允许作者清空输入后提示立即消失，不回退到旧项目值。
      ideaInput: ideaEl ? ideaEl.value : current?.ideaInput || "",
      authorNote: noteEl ? noteEl.value : current?.authorNote || "",
    };
    const locks = Pipe.collectAuthorNameLocks(p);
    el.textContent = locks.length
      ? `将锁定人名：${locks.map((x) => `${x.role === "heroine" ? "女主" : "男主"}「${x.name}」`).join("、")}。策划不得改名。`
      : "写上「女主沈照雪」「男主陆沉」这样的全名，策划会按原名出人，不会自行改名。";
  }

  function loadPipelineView() {
    const p = project();
    $("ideaInput").value = p.ideaInput || "";
    $("authorNote").value = p.authorNote || "";
    $("targetChapters").value = normalizedTargetChapters(p.targetChapters);
    refreshAuthorNameHint();
    renderPlanPreview();
    renderPipeLog();
    markSteps(null);
  }

  function loadControlView() {
    const p = project();
    const orderedTasks = (p.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const completedTasks = orderedTasks.filter((task) => ["done", "digested"].includes(task.status));
    const nextTask = orderedTasks.find((task) => !["done", "digested"].includes(task.status));
    const openLoops = (p.plotLoops || []).filter((loop) => ["open", "deferred"].includes(loop?.status));
    const riskStats = UiShell?.continuityStats?.(p.continuityIssues || []) || { high: 0 };
    const protagonist = p.storyState?.location || p.storyState?.protagonistState || p.storyline?.positionSummary || "待更新";
    if ($("storyProgress")) $("storyProgress").textContent = orderedTasks.length ? `${completedTasks.length} / ${orderedTasks.length} 个任务` : "尚未开始";
    if ($("storyNextTask")) $("storyNextTask").textContent = nextTask ? `${nextTask.id || "任务"} · ${nextTask.chapter_title || nextTask.goal || "待命名"}` : orderedTasks.length ? "全部完成" : "待建立";
    if ($("storyOpenLoops")) $("storyOpenLoops").textContent = String(openLoops.length);
    if ($("storyHighRisks")) $("storyHighRisks").textContent = String(riskStats.high || 0);
    if ($("storyProtagonist")) $("storyProtagonist").textContent = protagonist;
    $("lockLogline").value = p.locks?.logline || p.spine?.logline || p.pitch || "";
    $("lockForbidden").value = (p.locks?.forbidden || []).join("\n");
    $("lockMust").value = (p.locks?.mustHonor || []).join("\n");
    const style = p.styleBible || {};
    const recoveredPacing = UiShell?.recoverConcatenatedStylePacing
      ? UiShell.recoverConcatenatedStylePacing(style.pacing, style.dialogue)
      : style.pacing || "";
    if (p.styleBible && !formTextEqual(style.pacing, recoveredPacing)) {
      p.styleBible = { ...style, pacing: recoveredPacing };
      markDirty();
    }
    if ($("stylePov")) $("stylePov").value = style.pov || "";
    if ($("styleTense")) $("styleTense").value = style.tense || "";
    if ($("stylePacing")) $("stylePacing").value = recoveredPacing;
    if ($("styleDialogue")) $("styleDialogue").value = style.dialogue || "";
    if ($("styleRules")) $("styleRules").value = (style.rules || []).join("\n");
    if ($("styleForbidden")) $("styleForbidden").value = (style.forbiddenPhrases || []).join("\n");
    if ($("styleExamples")) $("styleExamples").value = (style.examples || []).join("\n\n");
    $("lockWorld").checked = !!p.locks?.lockedFields?.includes("world");
    $("lockCast").checked = !!p.locks?.lockedFields?.includes("cast");
    $("lockSpine").checked = !!p.locks?.lockedFields?.includes("spine");
    p._locksFormReady = true;
    renderTasks();
    renderSpineSide();
  }

  const storyLabel = Records.label;

  function syncStoryTypeFilter(id, values) {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    const normalized = Records.typeOptions(values);
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部类型";
    select.appendChild(all);
    for (const value of normalized) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = storyLabel(value);
      select.appendChild(option);
    }
    select.value = normalized.includes(current) ? current : "";
  }

  function storyFilterValue(id) {
    return String($(id)?.value || "").trim();
  }

  function emptyState(kicker, hint, extraClass = "") {
    return `<div class="empty-state compact${extraClass}"><span class="empty-kicker">${escapeHtml(kicker)}</span><strong>${escapeHtml(hint)}</strong></div>`;
  }

  /** 三张记录表共用：同步类型下拉、写筛选统计、处理两种空态。返回 null 表示已画完空态。 */
  function prepareStoryView(model, ids, empty) {
    syncStoryTypeFilter(ids.type, model.types);
    if ($(ids.stats)) $(ids.stats).textContent = model.stats;
    const box = $(ids.box);
    if (!box) return null;
    if (!model.total) {
      box.innerHTML = emptyState(empty.kicker, empty.hint, empty.className || "");
      return null;
    }
    if (!model.matched) {
      box.innerHTML = emptyState("没有匹配项", empty.filterHint);
      return null;
    }
    return box;
  }

  function renderCanonRecords(p) {
    const model = Records.buildCanonRecords(p, {
      type: storyFilterValue("canonTypeFilter"),
      lock: storyFilterValue("canonLockFilter"),
      evidence: storyFilterValue("canonEvidenceFilter"),
    });
    const box = prepareStoryView(
      model,
      { type: "canonTypeFilter", stats: "canonFilterStats", box: "canonView" },
      {
        kicker: "尚无 Canon",
        hint: "完成一次章后交接后，这里会保存可追溯的锁定设定。",
        filterHint: "调整类型、锁定状态或证据章节筛选。",
      }
    );
    if (!box) return;
    box.innerHTML = Records.renderCanonHtml(model);
  }

  function renderLoopRecords(p) {
    const model = Records.buildLoopRecords(p, {
      type: storyFilterValue("loopTypeFilter"),
      status: storyFilterValue("loopStatusFilter"),
      evidence: storyFilterValue("loopEvidenceFilter"),
    });
    const box = prepareStoryView(
      model,
      { type: "loopTypeFilter", stats: "loopFilterStats", box: "loopView" },
      {
        kicker: "尚无伏笔",
        hint: "章后交接会记录新开、推进、延后和回收的伏笔。",
        filterHint: "调整伏笔类型、状态或证据章节筛选。",
      }
    );
    if (!box) return;
    box.innerHTML = Records.renderLoopHtml(model);
  }

  function renderContinuityRecords(p) {
    const model = Records.buildContinuityRecords(p, {
      type: storyFilterValue("continuityTypeFilter"),
      status: storyFilterValue("continuityStatusFilter"),
      severity: storyFilterValue("continuitySeverityFilter"),
      evidence: storyFilterValue("continuityEvidenceFilter"),
    });
    const box = prepareStoryView(
      model,
      { type: "continuityTypeFilter", stats: "continuityFilterStats", box: "continuityView" },
      {
        kicker: "连续性稳定",
        hint: "当前没有已记录的连续性问题。",
        className: " success-state",
        filterHint: "调整类型、状态、严重度或证据章节筛选。",
      }
    );
    if (!box) return;
    box.innerHTML = Records.renderContinuityHtml(model);
  }

  /**
   * 列表类面板的按钮统一走委托：一次重画最多 100 张卡或 200 条边，
   * 不该每次重画都重新挂几百个监听。
   * _sourceIndex 指向原数组位置，所以这里改的是作者那本书里的同一条记录。
   */
  function bindDelegatedPanelActions() {
    $("loopView")?.addEventListener("click", (e) => {
      const control = e.target?.closest?.("[data-loop-action]");
      if (!control) return;
      const p = project();
      const loop = p.plotLoops?.[Number(control.dataset.loopIndex)];
      if (!loop) return;
      if (control.dataset.loopAction === "resolved") {
        loop.status = "resolved";
        loop.resolutionEvidence = "作者手动确认已回收";
        loop.resolvedChapter = p.storyState?.lastChapter || loop.lastChapter || "";
      } else if (control.dataset.loopAction === "deferred") {
        const target = prompt("新的预计回收点", loop.target || "");
        if (target === null) return;
        loop.status = "deferred";
        loop.target = target.trim();
      }
      loop.updatedAt = Date.now();
      save({ immediateDisk: true });
      renderSpineSide();
    });
    $("continuityView")?.addEventListener("click", (e) => {
      const control = e.target?.closest?.("[data-issue-action]");
      if (!control?.dataset.issueIndex) return;
      const p = project();
      const issue = p.continuityIssues?.[Number(control.dataset.issueIndex)];
      if (!issue) return;
      issue.status = control.dataset.issueAction === "ignored" ? "ignored" : "handled";
      issue.resolution = issue.status === "ignored" ? "作者手动忽略" : "作者手动确认已处理";
      issue.resolvedChapter = p.storyState?.lastChapter || issue.lastChapter || "";
      issue.updatedAt = Date.now();
      save({ immediateDisk: true });
      renderSpineSide();
    });
    $("nodeList")?.addEventListener("click", (e) => {
      const control = e.target?.closest?.("[data-graph-node]");
      if (!control) return;
      graphSelectedNodeId = control.dataset.graphNode || null;
      loadGraphView();
    });
  }

  function renderSpineSide() {
    const p = project();
    const summary = Records.buildStorySummary(p);
    $("spineView").textContent = summary.spineText;
    if ($("storylineView")) $("storylineView").textContent = summary.storylineText;
    $("memoryView").textContent = summary.memoryText;
    if ($("entityStateView")) $("entityStateView").textContent = summary.entityStateText;
    renderCanonRecords(p);
    renderLoopRecords(p);
    renderContinuityRecords(p);
  }

  function renderTasks() {
    const p = project();
    const tb = $("taskTable").querySelector("tbody");
    tb.innerHTML = "";
    (p.tasks || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((t) => {
        const tr = document.createElement("tr");
        const taskStatus = String(t.status || "pending");
        const taskStatusClass = UiShell?.safeCssToken?.(taskStatus, "pending") || "pending";
        tr.innerHTML = `
          <td data-label="#">${escapeHtml(t.order || "")}</td>
          <td data-label="状态"><span class="st ${taskStatusClass}">${escapeHtml(UiShell?.taskStatusLabel?.(taskStatus) || taskStatus)}</span></td>
          <td data-label="标题">${escapeHtml(t.chapter_title || "")}</td>
          <td data-label="目标">${escapeHtml(t.goal || "")}</td>
          <td data-label="禁止">${escapeHtml((t.must_not || []).join("；"))}</td>
          <td data-label="操作"></td>`;
        const ops = tr.lastElementChild;
        const bEdit = btn("编辑", () => openTaskModal(t.id));
        const bWrite = btn("写", async () => {
          switchMode("write");
          await writeTask(t.id);
        });
        const bDel = btn("删", () => {
          if (guardProjectWritable("删除任务")) return;
          if (!confirm("删除该任务？")) return;
          p.tasks = p.tasks.filter((x) => x.id !== t.id);
          save();
        });
        ops.append(bEdit, bWrite, bDel);
        tb.appendChild(tr);
      });
  }

  function btn(label, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost xs inline-action";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function orderedChapters(p) {
    const taskOrder = new Map((p.tasks || []).map((t) => [t.id, t.order ?? 0]));
    return (p.chapters || [])
      .slice()
      .sort((a, b) => {
        const oa = taskOrder.has(a.taskId) ? taskOrder.get(a.taskId) : 1e9;
        const ob = taskOrder.has(b.taskId) ? taskOrder.get(b.taskId) : 1e9;
        if (oa !== ob) return oa - ob;
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      });
  }

  function createManualChapter() {
    if (guardGen("新建章节") || guardProjectWritable("新建章节")) return null;
    const p = project();
    if (!p) return null;
    syncEditorToProject();
    const ordered = orderedChapters(p);
    const order = Math.max(0, ...ordered.map((chapter) => Number(chapter.order) || 0)) + 1;
    const task = (p.tasks || []).find(
      (item) => !p.chapters?.some((chapter) => chapter.taskId === item.id)
    );
    const chapter = {
      id: Store.uid(),
      taskId: task?.id || null,
      title: task?.chapter_title || `第${order}章`,
      order,
      body: "",
      updatedAt: Date.now(),
    };
    p.chapters = p.chapters || [];
    p.chapters.push(chapter);
    p.activeChapterId = chapter.id;
    if (task) p.activeTaskId = task.id;
    markDirty();
    Store.saveAll(state);
    scheduleDiskSave(false);
    loadWriteView();
    requestAnimationFrame(() => {
      $("chapterTitle")?.focus();
      $("chapterTitle")?.select();
    });
    return chapter;
  }

  function loadWriteView() {
    const p = project();
    const schemaReadOnly = Boolean(projectReadOnlyReason(p));
    const chapters = orderedChapters(p);
    const total = WritingPresenter.renderChapterList(p, chapters, {
      writingChapterId,
      locked: genLocked,
      countWords: words,
      onSelect: selectChapter,
    });
    $("totalWords").textContent = String(total);

    const ch =
      UiShell?.chooseStartupChapter?.(p) ||
      p.chapters.find((c) => c.id === p.activeChapterId) ||
      chapters[0] ||
      p.chapters[0];
    syncComposerReviewForChapter(p, ch);
    if (ch) {
      // 只校正 active 指针，不要在这里用「错误的编辑器内容」反写章节
      if (p.activeChapterId !== ch.id) p.activeChapterId = ch.id;
      $("chapterTitle").value = ch.title || "";
      $("manuscript").value = ch.body || "";
      $("chapterWords").textContent = `${words(ch.body)} 字`;
    } else {
      $("chapterTitle").value = "";
      $("manuscript").value = "";
      $("chapterWords").textContent = "0 字";
    }
    if ($("chapterTitle")) $("chapterTitle").readOnly = genLocked || schemaReadOnly;
    if ($("manuscript")) $("manuscript").readOnly = genLocked || schemaReadOnly;
    for (const id of [
      "btnNewChapterFromWrite",
      "btnGenerate",
      "btnDigest",
      "btnSaveChapter",
      "btnRefreshBeat",
      "composeMode",
      "beatSceneList",
    ]) {
      const control = $(id);
      if (control) control.disabled = genLocked || schemaReadOnly;
    }
    renderWritingWelcome(p, ch);
    const task = p.tasks.find((t) => t.id === p.activeTaskId) || p.tasks.find((t) => t.id === ch?.taskId);
    renderTaskCard(task);
    const packed = packWriteContext(p, task, ch, $("instruction").value);
    const productionSummary = window.NOVEL_PRODUCTION_ENGINE?.summary?.(ch);
    $("ctxMeter").textContent = WriteUI.contextMeterText(packed, ch, productionSummary);
    renderWritingInspector(p, task, ch, packed);
    renderBeatPlanEditor(p, task, ch);
    updateComposerLabel();
    if (ch) queueWritingPositionRestore(p, ch);
  }

  function syncBeatPlanFromUi(chapter, { asUserEdit = false } = {}) {
    const list = $("beatSceneList");
    if (!chapter || !list || !window.NOVEL_WRITE_UI) return;
    const plan = window.NOVEL_WRITE_UI.collectBeatPlan(list, chapter.beatPlan || {});
    chapter.beatPlan = plan;
    if (asUserEdit) markDirty();
  }

  function liveBeatCoverage(chapter, task) {
    const plan = chapter?.beatPlan || task?.beatPlan;
    if (!chapter?.body || !plan || typeof window.NOVEL_CRAFT?.scoreBeatCoverage !== "function") return null;
    return window.NOVEL_CRAFT.scoreBeatCoverage(chapter.body, plan);
  }

  /** 只画提示条，不动细纲列表：列表里有输入框，重建会打断作者。 */
  function paintCraftHint(chapter, task) {
    const hint = $("beatPlanHint");
    if (!hint) return;
    const liveCoverage = liveBeatCoverage(chapter, task);
    if (!chapter?.craftScore && !liveCoverage) {
      hint.textContent = "写前按卷内节奏铺场面。改过的细纲会锁住，直到你点「重出细纲」。";
      return;
    }
    const score = chapter?.craftScore
      ? liveCoverage
        ? { ...chapter.craftScore, beatCoverage: liveCoverage }
        : chapter.craftScore
      : { beatCoverage: liveCoverage };
    window.NOVEL_WRITE_UI?.renderCraftHint?.(hint, score);
  }

  function renderBeatPlanEditor(p, task, chapter) {
    const pace = window.NOVEL_CRAFT?.applyPaceToTask?.(task || { order: chapter?.order || 0 }, p);
    if ($("beatPaceLabel")) $("beatPaceLabel").textContent = pace?.label || "推进";
    const coverage = liveBeatCoverage(chapter, task) || chapter?.craftScore?.beatCoverage || null;
    window.NOVEL_WRITE_UI?.renderBeatPlan?.($("beatSceneList"), chapter?.beatPlan, pace, coverage);
    paintCraftHint(chapter, task);
  }

  function renderTaskCard(task) {
    const el = $("currentTaskCard");
    if (!task) {
      el.innerHTML = `
        <div class="empty-state compact">
          <span class="empty-kicker">本章尚未绑定任务</span>
          <strong>可以自由续写，也可以先在故事中心建立章节任务。</strong>
          <button type="button" class="btn ghost" data-go-mode="control">前往任务板</button>
        </div>`;
      return;
    }
    const rows = [
      ["目标", task.goal],
      ["核心冲突", task.conflict],
      ["节拍", (task.beats || []).join(" → ")],
      ["必须包含", (task.must_include || []).join("；")],
      ["禁止", (task.must_not || []).join("；")],
      ["章末钩子", task.hook_end],
    ].filter(([, value]) => String(value || "").trim());
    const taskStatus = String(task.status || "pending");
    const taskStatusClass = UiShell?.safeCssToken?.(taskStatus, "pending") || "pending";
    el.innerHTML = `
      <div class="task-card-head">
        <span class="task-order">${escapeHtml(task.id || "任务")}</span>
      <span class="st ${taskStatusClass}">${escapeHtml(UiShell?.taskStatusLabel?.(taskStatus) || taskStatus)}</span>
      </div>
      <h3>${escapeHtml(task.chapter_title || "未命名章节")}</h3>
      <dl class="task-fields">
        ${rows
          .map(
            ([label, value]) =>
              `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
          )
          .join("")}
      </dl>`;
  }

  const graphNodeId = GraphPanel.nodeId;
  const graphForSelectedNode = GraphPanel.subgraphForNode;
  const graphChapterList = GraphPanel.chapterList;

  function renderGraphProfile(graph, selectedId) {
    const box = $("graphProfile");
    if (!box) return;
    const profile = selectedId
      ? window.NOVEL_NARRATIVE?.buildCharacterProfile?.(
          graph.nodes || [],
          graph.edges || [],
          selectedId
        )
      : null;
    box.innerHTML = GraphPanel.renderProfileHtml(profile, selectedId);
  }

  function renderGraphTimeline(graph, selectedId) {
    const box = $("graphTimeline");
    if (!box) return;
    const model = GraphPanel.buildTracks(
      window.NOVEL_NARRATIVE?.buildRelationshipTracks?.(graph.nodes || [], graph.edges || []),
      selectedId
    );
    box.innerHTML = GraphPanel.renderTracksHtml(model);
  }

  function loadGraphView() {
    const p = project();
    const baseGraph = p.graph || { nodes: [], edges: [] };
    if (graphSelectedProjectId !== p.id) {
      graphSelectedProjectId = p.id;
      graphSelectedNodeId = null;
    }
    if ($("graphJson")) $("graphJson").value = JSON.stringify(baseGraph, null, 2);
    p._graphFormReady = true;

    const minOccurrence = Math.max(1, Number($("graphMinOcc")?.value || 1));
    const chapterFrom = Number($("graphChapFrom")?.value || 0);
    const chapterTo = Number($("graphChapTo")?.value || 0);
    const chapters = graphChapterList(p, baseGraph);
    let filteredGraph = window.NOVEL_NARRATIVE?.filterGraph
      ? window.NOVEL_NARRATIVE.filterGraph(baseGraph, {
          minOccurrence,
          chapterFrom: chapterFrom || undefined,
          chapterTo: chapterTo || undefined,
          chapterList: chapters,
        })
      : {
          nodes: [...(baseGraph.nodes || [])],
          edges: (baseGraph.edges || []).filter((edge) => (Number(edge.occurrence) || 1) >= minOccurrence),
        };
    if (
      graphSelectedNodeId &&
      !(filteredGraph.nodes || []).some((node) => graphNodeId(node) === graphNodeId(graphSelectedNodeId))
    ) {
      graphSelectedNodeId = null;
    }
    const selectedNode = (filteredGraph.nodes || []).find(
      (node) => graphNodeId(node) === graphNodeId(graphSelectedNodeId)
    );
    const scopedGraph = graphForSelectedNode(filteredGraph, graphSelectedNodeId);
    const stats = window.NOVEL_NARRATIVE?.graphStats?.(filteredGraph) || {
      characters: (filteredGraph.nodes || []).length,
      relationships: (filteredGraph.edges || []).length,
      chapters: chapters.length,
    };
    if ($("graphStats")) {
      $("graphStats").textContent = GraphPanel.statsLine(stats, filteredGraph, chapters, selectedNode);
    }
    const clearSelection = $("btnGraphClearSelection");
    if (clearSelection) clearSelection.hidden = !graphSelectedNodeId;

    const mermaidText =
      window.NOVEL_NARRATIVE?.toMermaid?.(scopedGraph) || Ctx.graphToMermaid(scopedGraph);
    if ($("mermaidBox")) $("mermaidBox").textContent = mermaidText;
    window.NOVEL_GRAPH_VIEW?.render?.($("graphCanvas"), scopedGraph, {
      selectedId: graphSelectedNodeId,
      onSelect: (node) => {
        graphSelectedNodeId = node?.id || null;
        loadGraphView();
      },
    });

    const tb = $("edgeTable")?.querySelector("tbody");
    if (tb) {
      const rows = GraphPanel.buildEdgeRows(scopedGraph, filteredGraph);
      tb.innerHTML = GraphPanel.renderEdgeRowsHtml(rows);
    }

    const nodeList = $("nodeList");
    if (nodeList) {
      const buttons = GraphPanel.buildNodeButtons(filteredGraph, graphSelectedNodeId, storyLabel);
      nodeList.innerHTML = GraphPanel.renderNodeButtonsHtml(buttons);
    }
    renderGraphProfile(filteredGraph, graphSelectedNodeId);
    renderGraphTimeline(filteredGraph, graphSelectedNodeId);
  }

  function renderAll() {
    renderProjects();
    renderPipeLog();
    renderPlanPreview();
    if ($("view-control")?.classList.contains("active")) loadControlView();
    if ($("view-write")?.classList.contains("active")) loadWriteView();
    if ($("view-graph")?.classList.contains("active")) loadGraphView();
  }

  function setGenerationStopControls(active) {
    for (const id of ["btnStopPipe", "btnStop", "btnStopAuto"]) {
      const control = $(id);
      if (!control) continue;
      control.hidden = !active;
      control.disabled = !active;
    }
  }

  function handleWriteRunError(error, kind, failure) {
    DiagnosticsUI.handleWriteFailure(error, kind, failure, {
      alert,
      console,
      log: (message) => Pipe.log(project(), message),
      setStatus,
      setVaultStatus,
      setAutoStatus,
      refreshWrite: loadWriteView,
    });
  }

  function withAbort(fn, opts = {}) {
    return WriteCases.run(fn, opts, {
      guardWritable: (label) => guardProjectWritable(label),
      setStopControls: setGenerationStopControls,
      onRunError: handleWriteRunError,
      failureContext: () => DiagnosticsUI.failureContext(project()),
      flushStream: flushActiveChapterStream,
      setLock: setGenLock,
      persist: () => save({ immediateDisk: true }),
    });
  }

  function confirmSpineRisk(p) {
    const progressed = (p.tasks || []).filter((t) =>
      ["done", "written", "digested", "writing", "complete", "completed", "finished"].includes(
        String(t.status || "").trim().toLowerCase()
      )
    );
    const withBody = (p.chapters || []).filter((c) => c.body?.trim()).length;
    if (!progressed.length && !withBody) return true;
    return confirm(
      `当前已有 ${progressed.length} 个进行中/完成任务、${withBody} 章正文。\n` +
        `有进度时会保留已写章节和对应任务；尚无正文/完成任务时，待办板会按新策划刷新。\n` +
        `若要连同人物和任务板都全新开始，请先「新建书」。\n\n仍要在这本书上继续？`
    );
  }

  // —— Pipeline buttons ——
  $("btnRunPlan").addEventListener("click", () => {
    if (guardProjectWritable("运行完整策划")) return;
    const p = project();
    if (!confirmSpineRisk(p)) return;
    p.ideaInput = $("ideaInput").value;
    p.authorNote = $("authorNote").value;
    p.targetChapters = normalizedTargetChapters($("targetChapters").value);
    withAbort(async (signal) => {
      setStatus("策划中…", "busy");
      setGenLock(true, p.activeChapterId);
      try {
        await Pipe.runFullPlan(p, cfg, {
          signal,
          onStep: (name, st) => {
            markSteps(st === "start" ? name : null);
            if (st === "done" || st === "skip-locked") {
              renderPlanPreview();
              renderPipeLog();
              save({ skipRender: true, immediateDisk: false });
            }
          },
        });
        markSteps(null);
        setStatus("策划完成", "");
        renderAll();
      } finally {
        setGenLock(false);
      }
    });
  });

  function bindStep(btnId, runner, { spineRisk } = {}) {
    $(btnId).addEventListener("click", () => {
      if (guardProjectWritable("运行策划步骤")) return;
      const p = project();
      if (spineRisk && !confirmSpineRisk(p)) return;
      p.ideaInput = $("ideaInput").value;
      p.authorNote = $("authorNote").value;
      p.targetChapters = normalizedTargetChapters($("targetChapters").value);
      withAbort(async (signal) => {
        setStatus("运行中…", "busy");
        setGenLock(true, p.activeChapterId);
        try {
          await runner(p, cfg, signal);
          setStatus("完成", "");
          renderAll();
        } finally {
          setGenLock(false);
        }
      });
    });
  }
  bindStep("btnStepPitch", Pipe.runPitch);
  bindStep("btnStepWorld", Pipe.runWorld);
  bindStep("btnStepCast", Pipe.runCast);
  bindStep("btnStepSpine", Pipe.runSpine, { spineRisk: true });

  $("btnStopPipe").addEventListener("click", () => WriteCases.abort());
  $("btnStop").addEventListener("click", () => WriteCases.abort());
  $("btnStopAuto").addEventListener("click", () => {
    WriteCases.abort({ stopAuto: true });
  });

  $("btnGoControl").addEventListener("click", () => {
    if (guardProjectWritable("初始化故事锁定")) return;
    const p = project();
    if (!p.locks.logline) p.locks.logline = p.spine?.logline || p.pitch || "";
    save();
    switchMode("control");
  });

  $("btnSaveLocks").addEventListener("click", () => {
    if (guardProjectWritable("保存故事锁定")) return;
    const p = project();
    p.locks.logline = $("lockLogline").value.trim();
    p.locks.forbidden = $("lockForbidden").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    p.locks.mustHonor = $("lockMust").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    p.styleBible = {
      ...(p.styleBible || {}),
      pov: $("stylePov")?.value.trim() || "",
      tense: $("styleTense")?.value.trim() || "",
      pacing: UiShell?.recoverConcatenatedStylePacing
        ? UiShell.recoverConcatenatedStylePacing($("stylePacing")?.value.trim() || "", $("styleDialogue")?.value.trim() || p.styleBible?.dialogue)
        : $("stylePacing")?.value.trim() || "",
      dialogue: $("styleDialogue")?.value.trim() || "",
      rules: ($("styleRules")?.value || "").split(/\n+/).map((s) => s.trim()).filter(Boolean),
      forbiddenPhrases: ($("styleForbidden")?.value || "").split(/\n+/).map((s) => s.trim()).filter(Boolean),
      examples: ($("styleExamples")?.value || "").split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean),
    };
    const fields = [];
    if ($("lockWorld").checked) fields.push("world");
    if ($("lockCast").checked) fields.push("cast");
    if ($("lockSpine").checked) fields.push("spine");
    if (p.locks.logline) fields.push("logline");
    p.locks.lockedFields = fields;
    if (p.spine) p.spine.logline = p.locks.logline;
    Pipe.log(p, "已保存主线锁定");
    save();
    alert("锁定已保存。自动写章将强制遵守。");
  });

  $("btnSteer").addEventListener("click", () => {
    if (guardProjectWritable("执行作者纠偏")) return;
    const note = $("steerNote").value.trim();
    if (!note) return alert("请先写批注");
    withAbort(async (signal) => {
      setGenLock(true, project()?.activeChapterId);
      setAutoStatus("纠偏中…");
      const json = await Pipe.authorSteer(project(), cfg, note, { signal });
      $("lockLogline").value = project().locks.logline || "";
      $("lockForbidden").value = (project().locks.forbidden || []).join("\n");
      setAutoStatus(json.editor_note || "纠偏完成");
      renderTasks();
      renderSpineSide();
      save();
    });
  });

  $("btnAddTask").addEventListener("click", () => {
    if (guardProjectWritable("新增任务")) return;
    const p = project();
    const order = (p.tasks?.length || 0) + 1;
    const t = {
      id: `t${String(order).padStart(3, "0")}_${Store.uid().slice(0, 4)}`,
      order,
      chapter_title: `第${order}章`,
      goal: "",
      conflict: "",
      beats: [],
      must_include: [],
      must_not: [],
      hook_end: "",
      pov: "",
      status: "pending",
    };
    p.tasks = p.tasks || [];
    p.tasks.push(t);
    save();
    openTaskModal(t.id);
  });

  function openTaskModal(id) {
    const t = project().tasks.find((x) => x.id === id);
    if (!t) return;
    editingTaskId = id;
    $("taskModalTitle").textContent = `编辑 ${t.id}`;
    $("tmTitle").value = t.chapter_title || "";
    $("tmGoal").value = t.goal || "";
    $("tmConflict").value = t.conflict || "";
    $("tmBeats").value = (t.beats || []).join("\n");
    $("tmMust").value = (t.must_include || []).join("\n");
    $("tmMustNot").value = (t.must_not || []).join("\n");
    $("tmHook").value = t.hook_end || "";
    $("tmPov").value = t.pov || "";
    modalReturnFocus = document.activeElement;
    $("taskModal").hidden = false;
    syncModalBackgroundInert($("taskModal"));
    window.setTimeout(() => $("taskModal")?.querySelector(".modal")?.focus(), 0);
  }

  $("btnCloseTask").addEventListener("click", () => {
    $("taskModal").hidden = true;
    syncModalBackgroundInert();
    editingTaskId = null;
    modalReturnFocus?.focus?.();
    modalReturnFocus = null;
  });

  $("btnSaveTask").addEventListener("click", () => {
    if (guardProjectWritable("保存任务")) return;
    const t = project().tasks.find((x) => x.id === editingTaskId);
    if (!t) return;
    t.chapter_title = $("tmTitle").value.trim();
    t.goal = $("tmGoal").value.trim();
    t.conflict = $("tmConflict").value.trim();
    t.beats = $("tmBeats").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    t.must_include = $("tmMust").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    t.must_not = $("tmMustNot").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    t.hook_end = $("tmHook").value.trim();
    t.pov = $("tmPov").value.trim();
    $("taskModal").hidden = true;
    syncModalBackgroundInert();
    modalReturnFocus?.focus?.();
    modalReturnFocus = null;
    save();
  });

  /**
   * 流式重画：delta 只记 pending，rAF 每帧最多一次。
   * 防串显守卫必须在重画时刻判定；退出路径走 flushActiveChapterStream。
   */
  function paintActiveChapterStreamNow(chapterId) {
    const p = project();
    const cid = chapterId || writingChapterId || p.activeChapterId;
    const ch = p.chapters.find((c) => c.id === cid);
    if (!ch) return;
    if (p.activeChapterId !== ch.id || !$("manuscript")) return;
    $("chapterTitle").value = ch.title || "";
    $("manuscript").value = ch.body || "";
    $("chapterWords").textContent = `${words(ch.body)} 字`;
    $("manuscript").scrollTop = $("manuscript").scrollHeight;
    if (typeof window.__inkwellStreamPaintCount === "number") window.__inkwellStreamPaintCount += 1;
  }

  function flushActiveChapterStream() {
    if (streamPaintRaf) {
      cancelAnimationFrame(streamPaintRaf);
      streamPaintRaf = 0;
    }
    const pending = streamPaintPendingId;
    streamPaintPendingId = null;
    if (pending) paintActiveChapterStreamNow(pending);
  }

  function paintActiveChapterStream(_delta, _full, chapterId) {
    const p = project();
    const cid = chapterId || writingChapterId || p.activeChapterId;
    if (!cid) return;
    streamPaintPendingId = cid;
    if (streamPaintRaf) return;
    streamPaintRaf = requestAnimationFrame(() => {
      streamPaintRaf = 0;
      const pending = streamPaintPendingId;
      streamPaintPendingId = null;
      if (pending) paintActiveChapterStreamNow(pending);
    });
  }

  function addWritingFileHints(chapter) {
    if (!window.__mogaoGen || !chapter?.title) return;
    const extra = buildWritingFileHints(chapter.id);
    window.__mogaoGen.writingFileHints = [
      ...new Set([...(window.__mogaoGen.writingFileHints || []), ...extra]),
    ];
  }

  function writeUseCasePorts() {
    return {
      status: setStatus,
      autoStatus: setAutoStatus,
      chapterStatus: setChapterCycleStatus,
      setLock: setGenLock,
      addWritingHints: addWritingFileHints,
      syncBeatPlan: syncBeatPlanFromUi,
      onDelta: paintActiveChapterStream,
      flushStream: flushActiveChapterStream,
      captureReview: captureComposerSnapshot,
      renderWrite: loadWriteView,
      renderControl: loadControlView,
      showReview: showComposerReview,
    };
  }

  function writeTask(taskId) {
    const p = project();
    const task = p.tasks.find((item) => item.id === taskId);
    if (!task) return Promise.resolve();
    return withAbort((signal) =>
      WriteCases.writeTask(
        {
          project: p,
          cfg,
          task,
          signal,
          instruction: $("instruction")?.value || "",
        },
        {
          ...writeUseCasePorts(),
          taskOutcome: ({ chapter, pending }) => {
            if (pending) {
              const pendingState = handoffPresentation(chapter);
              setStatus(
                `正文验收通过 · ${pendingState.label}`,
                pendingState.tone === "danger" ? "err" : "warn"
              );
              setAutoStatus("待章后交接");
            } else {
              setStatus("本章完成", "");
              setAutoStatus("空闲");
            }
          },
        }
      )
    );
  }

  $("btnAutoWrite").addEventListener("click", () => {
    const p = project();
    if (!p.locks?.logline && !p.spine?.logline) {
      if (!confirm("尚未锁定主线，仍要自动连写吗？建议先保存锁定。")) return;
    }
    withAbort(
      (signal) =>
        WriteCases.autoWrite(
          {
            project: p,
            cfg,
            signal,
            instruction: $("instruction")?.value?.trim() || "",
          },
          {
            ...writeUseCasePorts(),
            switchToWrite: () => switchMode("write"),
            noPending: () =>
              alert("没有未完成任务（status ≠ done）。\n若卡在 written/digested，再点一次将只补摘要/关系，不会重写正文。"),
            taskError: (task, error) => {
              setAutoStatus(`${task.id} 失败，已停止连写`);
              alert(`任务 ${task.id} 失败：${error.message || error}\n状态保留为 ${task.status}，可稍后重试（不会重复覆盖已写正文）。`);
            },
            persistError: (task, error) => {
              console.error(error);
              setVaultStatus("连写存盘失败: " + (error.message || error), "err");
              setAutoStatus(`${task.id} 存盘失败，已停止连写`);
            },
            autoComplete: () => {
              $("btnStopAuto").disabled = true;
            },
          }
        ),
      { autoOwnsLock: true }
    );
  });

  $("btnWriteTask").addEventListener("click", () => {
    const p = project();
    const task = p.tasks.find((t) => t.id === p.activeTaskId);
    if (!task) return alert("无当前任务");
    writeTask(task.id);
  });

  function reviseFromAnnotation() {
    const p = project();
    const chapter = p?.chapters?.find((item) => item.id === p.activeChapterId);
    const editor = $("manuscript");
    const annotation = $("instruction")?.value?.trim() || "";
    if (!chapter || !editor?.value?.trim()) return alert("请先选择一章有正文的章节");
    if (!annotation) {
      $("instruction")?.focus();
      return alert("请先在 AI 写作指令中写下本轮批注");
    }
    const originalBody = editor.value;
    withAbort((signal) =>
      WriteCases.revise(
        {
          project: p,
          cfg,
          chapter,
          signal,
          annotation,
          originalBody,
          originalUpdatedAt: chapter.updatedAt,
        },
        {
          ...writeUseCasePorts(),
          afterRevision: ({ chapter: revised, snapshot }) => {
            editor.value = revised.body || "";
            $("chapterWords").textContent = `${words(revised.body)} 字`;
            const handoff = handoffStatusSuffix(revised, "待重新交接");
            setStatus(`修订完成 · ${handoff.suffix}`, handoff.kind);
            save({ immediateDisk: true });
            loadWriteView();
            showComposerReview(snapshot, revised, {
              canUndo: revised.handoffStatus !== "done",
              note: revised.handoffStatus === "done" ? "已完成章后交接" : "待章后交接",
              undoReason:
                revised.handoffStatus === "done"
                  ? "修订结果已更新故事记忆；请通过章节历史或快照回退完整状态"
                  : undefined,
            });
          },
          rollbackRevision: (_chapter, body) => {
            editor.value = body;
            $("chapterWords").textContent = `${words(body)} 字`;
          },
        }
      )
    );
  }

  $("btnGenerate").addEventListener("click", () => {
    const p = project();
    const task = p.tasks.find((item) => item.id === p.activeTaskId);
    const composeMode = $("composeMode")?.value || "task";
    if (composeMode === "rewrite") return $("btnRewriteSel")?.click();
    if (composeMode === "annotate") return reviseFromAnnotation();
    if (composeMode === "task" && task) return writeTask(task.id);
    const instruction = $("instruction").value || "请续写，保持文风，完成任务约束。";
    withAbort((signal) =>
      WriteCases.continueDraft(
        {
          project: p,
          cfg,
          task,
          signal,
          chapterTitle: $("chapterTitle").value,
          body: $("manuscript").value,
          instruction,
        },
        {
          ...writeUseCasePorts(),
          afterContinue: ({ chapter, snapshot }) => {
            const handoff = handoffStatusSuffix(chapter, "待章后交接");
            if (handoff.suffix === "记忆已交接") {
              setStatus("完成 · 记忆已交接", "");
              setAutoStatus("空闲");
            } else {
              setStatus(`正文已生成 · ${handoff.suffix}`, handoff.kind);
            }
            save({ immediateDisk: true });
            loadWriteView();
            showComposerReview(snapshot, chapter, {
              canUndo: chapter.handoffStatus !== "done",
              note: chapter.handoffStatus === "done" ? "已完成章后交接" : "待章后交接",
              undoReason:
                chapter.handoffStatus === "done"
                  ? "续写结果已更新故事记忆；请通过章节历史或快照回退完整状态"
                  : undefined,
            });
          },
        }
      )
    );
  });

  $("btnRewriteSel").addEventListener("click", () => {
    const editor = $("manuscript");
    if (editor.selectionStart === editor.selectionEnd) return alert("请先选中要重写的段落");
    const projectState = project();
    const chapter = projectState.chapters.find((item) => item.id === projectState.activeChapterId);
    const task = projectState.tasks.find((item) => item.id === projectState.activeTaskId) || {
      goal: "重写选段",
      must_not: projectState.locks?.forbidden || [],
      beats: [],
      must_include: [],
    };
    const instruction = $("instruction")?.value?.trim() || "保持剧情走向与人物声线，改善表达和节奏";
    withAbort((signal) =>
      WriteCases.rewriteSelection(
        {
          project: projectState,
          cfg,
          task,
          chapter,
          signal,
          body: editor.value,
          start: editor.selectionStart,
          end: editor.selectionEnd,
          instruction,
        },
        {
          ...writeUseCasePorts(),
          afterRewrite: ({ chapter: revised, snapshot }) => {
            editor.value = revised.body || "";
            const handoff = handoffStatusSuffix(revised, "待章后交接");
            setStatus(`重写完成 · ${handoff.suffix}`, handoff.kind);
            save();
            showComposerReview(snapshot, revised, {
              canUndo: revised.handoffStatus !== "done",
              note: revised.handoffStatus === "done" ? "已完成章后交接" : "待章后交接",
              undoReason:
                revised.handoffStatus === "done"
                  ? "重写结果已更新故事记忆；请通过章节历史或快照回退完整状态"
                  : undefined,
            });
          },
        }
      )
    );
  });

  $("btnDigest").addEventListener("click", () => {
    const p = project();
    const chapter = p.chapters.find((item) => item.id === p.activeChapterId);
    const task = p.tasks.find((item) => item.id === chapter?.taskId || item.id === p.activeTaskId);
    if (!chapter?.body?.trim() && !$("manuscript").value.trim()) return alert("本章无正文");
    if ($("chapterMore")) $("chapterMore").open = false;
    withAbort((signal) =>
      WriteCases.handoffExisting(
        {
          project: p,
          cfg,
          chapter,
          task,
          signal,
          editorBody: $("manuscript").value,
          instruction: $("instruction")?.value || "",
        },
        {
          ...writeUseCasePorts(),
          invalidateAfterAuthorEdit: (item, linkedTask) =>
            invalidateProductionAfterAuthorEdit(item, linkedTask),
          afterHandoff: () => {
            setStatus("完成 · 记忆已交接", "");
            save();
            loadControlView();
            loadGraphView();
          },
          finalizeHandoff: loadWriteView,
        }
      )
    );
  });

  function saveActiveChapterNow() {
    if (guardGen("保存") || guardProjectWritable("保存章节")) return;
    const p = project();
    syncEditorToProject();
    scheduleDiskSave(true);
    setVaultStatus(
      vaultOnline ? "手动存盘…" : "已保存到浏览器缓存 · 本地书库未连接",
      vaultOnline ? "busy" : "warn"
    );
    renderChapterHeaderState(p, p?.chapters?.find((chapter) => chapter.id === p.activeChapterId));
  }

  $("btnSaveChapter")?.addEventListener("click", saveActiveChapterNow);
  $("btnKeepComposerResult")?.addEventListener("click", () => {
    clearComposerReview();
    setStatus("已保留本次 AI 结果", "muted");
    $("instruction")?.focus();
  });
  $("btnUndoComposerResult")?.addEventListener("click", undoComposerReview);

  $("instruction").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("btnGenerate").click();
    }
  });

  function updateComposerLabel() {
    let mode = $("composeMode")?.value || "task";
    const hasTask = !!project()?.tasks?.find((task) => task.id === project()?.activeTaskId);
    if (mode === "task" && !hasTask && $("composeMode")) {
      mode = "continue";
      $("composeMode").value = mode;
    }
    const labels = {
      task: hasTask ? "按任务写本章" : "从当前位置续写",
      continue: "从当前位置续写",
      rewrite: "重写选中段落",
      annotate: "根据批注修订",
    };
    if ($("btnGenerate")) $("btnGenerate").textContent = labels[mode] || labels.continue;
    const placeholders = {
      task: "补充本轮要求，例如：加强女主主动性，让章末停在门被推开的瞬间。Ctrl+Enter 执行",
      continue: "说明续写方向、节奏或必须出现的细节。Ctrl+Enter 执行",
      rewrite: "先在正文中选中段落，再说明希望怎样重写。Ctrl+Enter 执行",
      annotate: "写下针对本章的修改批注；成功后才会替换原稿。Ctrl+Enter 执行",
    };
    if ($("instruction")) $("instruction").placeholder = placeholders[mode] || placeholders.continue;
  }

  $("composeMode")?.addEventListener("change", updateComposerLabel);
  $("beatSceneList")?.addEventListener("input", () => {
    const p = project();
    const ch = p?.chapters?.find((chapter) => chapter.id === p.activeChapterId);
    if (!ch) return;
    syncBeatPlanFromUi(ch, { asUserEdit: true });
    ch.beatPlanLocked = true;
  });
  $("btnRefreshBeat")?.addEventListener("click", () => {
    const p = project();
    const ch = p?.chapters?.find((chapter) => chapter.id === p.activeChapterId);
    const task = p?.tasks?.find((item) => item.id === p.activeTaskId || item.id === ch?.taskId);
    if (!ch || !task) return alert("请先选择一章并绑定任务");
    ch.beatPlanLocked = false;
    withAbort(async (signal) => {
      setStatus("铺本章细纲…", "busy");
      await Pipe.planChapterBeat(p, cfg, task, { signal, forceBeat: true });
      renderBeatPlanEditor(p, task, ch);
      setStatus("细纲已更新", "");
      save();
    });
  });

  function syncComposerSelection() {
    const editor = $("manuscript");
    const selectionState = $("composeSelectionState");
    if (!editor || !selectionState) return;
    const selected = Math.max(0, editor.selectionEnd - editor.selectionStart);
    selectionState.hidden = selected === 0;
    selectionState.textContent = selected ? `已选 ${selected} 字` : "";
    if (selected && $("composeMode")?.value !== "annotate") {
      $("composeMode").value = "rewrite";
      updateComposerLabel();
    }
    captureWritingPosition(false);
  }

  function productionIsBlocked(chapter) {
    return (
      ProductionState?.isQualityBlocked?.(chapter) ??
      ["needs_revision", "quality-blocked"].includes(
        String(chapter?.production?.status || chapter?.production?.stage || "")
      )
    );
  }

  function alignTaskAfterBodyMutation(task, chapter, reason) {
    if (productionIsBlocked(chapter)) {
      ChapterState.requestRevision(chapter, task, {
        reason: reason || chapter?.handoffError || "正文变化后等待重新验收",
        stage: chapter?.production?.stage || "quality-review",
        touch: false,
      });
      return;
    }
    ChapterState.markHandoffStale(chapter, task, {
      reason: reason || chapter?.handoffError || "正文变化后等待重新交接",
      touch: false,
    });
  }

  function invalidateProductionAfterAuthorEdit(
    chapter,
    task,
    reason = "正文编辑后等待重新通过叙事质量闸门"
  ) {
    if (!chapter) return { changed: false, reason: "missing-chapter" };
    return ProductionState.invalidateAfterBodyEdit(chapter, { reason, task });
  }

  $("manuscript")?.addEventListener("select", syncComposerSelection);
  $("manuscript")?.addEventListener("keyup", syncComposerSelection);
  $("manuscript")?.addEventListener("click", syncComposerSelection);
  $("manuscript")?.addEventListener("scroll", () => captureWritingPosition(false), { passive: true });

  $("manuscript").addEventListener("input", () => {
    if (genLocked && writingChapterId && project()?.activeChapterId !== writingChapterId) return;
    $("chapterWords").textContent = `${words($("manuscript").value)} 字`;
    const p = project();
    const ch = p.chapters.find((c) => c.id === p.activeChapterId);
    if (ch) {
      if (composerReviewState && $("manuscript").value !== composerReviewState.afterBody) {
        clearComposerReview();
      }
      ch.body = $("manuscript").value;
      ch.updatedAt = Date.now();
      const linkedTask = p.tasks.find((t) => t.id === ch.taskId);
      invalidateProductionAfterAuthorEdit(ch, linkedTask);
      scheduleCraftRescore(ch.id);
    }
    markDirty();
    scheduleDiskSave(false);
  });
  $("chapterTitle").addEventListener("input", () => {
    if (genLocked && writingChapterId && project()?.activeChapterId !== writingChapterId) return;
    const p = project();
    const ch = p.chapters.find((c) => c.id === p.activeChapterId);
    if (ch) {
      const t = $("chapterTitle").value.trim();
      if (t) ch.title = t;
      ch.updatedAt = Date.now();
      const linkedTask = p.tasks.find((task) => task.id === ch.taskId);
      ChapterState.markHandoffStale(ch, linkedTask, { reason: "章节标题编辑后尚未重新交接" });
    }
    markDirty();
    scheduleDiskSave(false);
  });
  $("btnNewChapterFromWrite")?.addEventListener("click", createManualChapter);
  /**
   * syncEditorToProject 会读入内存的策划/锁定/风格/图谱控件。
   * 每一项都必须：用户改动 → markDirty；失焦 → 立即排队落盘。
   * manuscript / chapterTitle / beatSceneList 有自己的 input 路径，不进这张表。
   */
  const PROJECT_FORM_FIELDS = [
    "targetChapters",
    "lockLogline",
    "lockForbidden",
    "lockMust",
    "lockWorld",
    "lockCast",
    "lockSpine",
    "stylePov",
    "styleTense",
    "stylePacing",
    "styleDialogue",
    "styleRules",
    "styleForbidden",
    "styleExamples",
    "ideaInput",
    "authorNote",
    "graphJson",
  ];
  $("ideaInput")?.addEventListener("input", refreshAuthorNameHint);
  $("authorNote")?.addEventListener("input", refreshAuthorNameHint);
  function bindProjectFormPersistence() {
    for (const id of PROJECT_FORM_FIELDS) {
      const el = $(id);
      if (!el) continue;
      const mark = () => markDirty();
      el.addEventListener("input", mark);
      el.addEventListener("change", mark);
      el.addEventListener("blur", () => {
        syncEditorToProject();
        persistOnly({ immediateDisk: true });
      });
    }
  }
  bindProjectFormPersistence();
  ["manuscript", "chapterTitle"].forEach((id) => {
    $(id)?.addEventListener("blur", () => {
      syncEditorToProject();
      persistOnly({ immediateDisk: true });
    });
  });

  for (const id of [
    "canonTypeFilter",
    "canonLockFilter",
    "loopTypeFilter",
    "loopStatusFilter",
    "continuityTypeFilter",
    "continuityStatusFilter",
    "continuitySeverityFilter",
  ]) {
    $(id)?.addEventListener("change", renderSpineSide);
  }
  for (const id of ["canonEvidenceFilter", "loopEvidenceFilter", "continuityEvidenceFilter"]) {
    $(id)?.addEventListener("input", renderSpineSide);
  }
  for (const [buttonId, filterIds] of [
    ["btnCanonClearFilters", ["canonTypeFilter", "canonLockFilter", "canonEvidenceFilter"]],
    ["btnLoopClearFilters", ["loopTypeFilter", "loopStatusFilter", "loopEvidenceFilter"]],
    [
      "btnContinuityClearFilters",
      ["continuityTypeFilter", "continuityStatusFilter", "continuitySeverityFilter", "continuityEvidenceFilter"],
    ],
  ]) {
    $(buttonId)?.addEventListener("click", () => {
      for (const filterId of filterIds) {
        const control = $(filterId);
        if (control) control.value = "";
      }
      renderSpineSide();
    });
  }

  // Graph
  $("btnSaveGraph").addEventListener("click", () => {
    try {
      project().graph = JSON.parse($("graphJson").value);
      save();
      loadGraphView();
      alert("图谱已保存");
    } catch (e) {
      alert("JSON 无效: " + e.message);
    }
  });
  $("btnReloadGraph").addEventListener("click", loadGraphView);
  $("btnGraphApplyFilter")?.addEventListener("click", loadGraphView);
  $("btnGraphReload")?.addEventListener("click", () => {
    graphSelectedNodeId = null;
    loadGraphView();
  });
  $("btnGraphClearSelection")?.addEventListener("click", () => {
    graphSelectedNodeId = null;
    loadGraphView();
  });
  for (const id of ["graphMinOcc", "graphChapFrom", "graphChapTo"]) {
    $(id)?.addEventListener("change", loadGraphView);
  }

  // Projects
  $("projectSelect").addEventListener("change", async () => {
    const id = $("projectSelect").value;
    const target = state.projects.find((p) => p.id === id);
    if (!target) return;
    if (target.slug) await switchToSlug(target.slug);
    else {
      syncEditorToProject();
      state.activeId = id;
      Store.saveAll(state);
      renderAll();
      loadPipelineView();
      loadWriteView();
    }
  });

  $("btnLibRefresh")?.addEventListener("click", () => refreshLibraryFromServer());
  $("btnSnapshot")?.addEventListener("click", async () => {
    const p = project();
    if (!p?.slug || !vaultOnline) return alert("无本地书或未连接服务");
    try {
      await flushToDisk();
      const res = await Vault.snapshot(p.slug, "manual");
      setVaultStatus(`快照 ${res.id}`, "ok");
      alert(`已创建快照 ${res.id}\n位置: books/${p.slug}/.history/`);
    } catch (e) {
      alert("快照失败: " + (e.message || e));
    }
  });

  $("btnToggleLibrary")?.addEventListener("click", () => setLibraryDrawer(!document.querySelector(".shell")?.classList.contains("library-open"), true));
  $("btnCloseLibrary")?.addEventListener("click", () => setLibraryDrawer(false, true));
  $("libraryScrim")?.addEventListener("click", () => setLibraryDrawer(false, true));
  $("btnOpenChapters")?.addEventListener("click", () => setChapterDrawer(true));
  $("btnCloseChapters")?.addEventListener("click", () => setChapterDrawer(false));
  $("btnOpenInspector")?.addEventListener("click", () => {
    setInspectorDrawer(true);
    setInspectorTab(uiState.inspectorTab || "task", { open: true });
  });
  $("btnCloseInspector")?.addEventListener("click", () => setInspectorDrawer(false));
  $("btnFocusMode")?.addEventListener("click", () => setFocusMode(!document.body.classList.contains("focus-mode"), true));
  $("vaultStatus")?.addEventListener("click", () => {
    if (SaveConflicts.list().length) {
      openNextSaveConflict();
      return;
    }
    const menu = $("utilityMenu");
    if (menu) menu.open = true;
  });
  $("btnCloseSaveConflict")?.addEventListener("click", () => closeSaveConflictModal({ keepPending: true }));
  $("saveConflictModal")?.addEventListener("click", (event) => {
    if (event.target === $("saveConflictModal")) closeSaveConflictModal({ keepPending: true });
  });
  $("btnConflictUseDisk")?.addEventListener("click", () => {
    void resolveActiveSaveConflict("disk").catch((error) => alert("处理冲突失败：" + (error.message || error)));
  });
  $("btnConflictSaveMerge")?.addEventListener("click", () => {
    void resolveActiveSaveConflict("merge").catch((error) => alert("保存合并稿失败：" + (error.message || error)));
  });
  $("btnConflictKeepLocal")?.addEventListener("click", () => {
    if (!confirm("这会用 Inkwell 内存稿覆盖磁盘上的外部新版。确定继续？")) return;
    void resolveActiveSaveConflict("local").catch((error) => alert("覆盖磁盘失败：" + (error.message || error)));
  });

  document.addEventListener("click", async (e) => {
    const storyButton = e.target?.closest?.("[data-go-mode]");
    if (storyButton?.dataset.goMode) {
      e.preventDefault();
      await switchMode(storyButton.dataset.goMode);
      const targetId = storyButton.dataset.storyTarget;
      const target = targetId ? $(targetId) : null;
      if (target && $("view-control")?.classList.contains("active")) {
        const group = target.closest("details");
        if (group) group.open = true;
        window.requestAnimationFrame(() => {
          target.scrollIntoView({ block: "start", behavior: "smooth" });
          group?.querySelector(":scope > summary")?.focus();
        });
      }
      return;
    }
    const inspectorButton = e.target?.closest?.("[data-inspector-target]");
    if (inspectorButton?.dataset.inspectorTarget) {
      e.preventDefault();
      if (!$("view-write")?.classList.contains("active")) await switchMode("write");
      setInspectorTab(inspectorButton.dataset.inspectorTarget, { open: true });
      setInspectorDrawer(true);
      return;
    }
    const libraryAction = e.target?.closest?.("[data-library-action]")?.dataset.libraryAction;
    if (libraryAction) {
      if (libraryAction === "clear") {
        if ($("libFilter")) $("libFilter").value = "";
        refreshLibrarySidebar();
        $("libFilter")?.focus();
        return;
      }
      const target = { new: "btnNewProject", open: "btnOpenVaultDir", sample: "btnImportSeed" }[libraryAction];
      if (target) $(target)?.click();
      return;
    }
    if (e.target?.closest?.("[data-chapter-action='new']")) {
      $("btnNewChapterFromWrite")?.click();
      return;
    }
    const settingsButton = e.target?.closest?.(".settings-nav-item");
    if (settingsButton?.dataset.settingsTarget) {
      setSettingsTab(settingsButton.dataset.settingsTarget);
      return;
    }
    const issueButton = e.target?.closest?.("[data-issue-action]");
    if (!issueButton) return;
    const card = issueButton.closest("[data-issue-id]");
    const issue = (project()?.continuityIssues || []).find((item) => item.id === card?.dataset.issueId);
    if (!issue) return;
    const action = issueButton.dataset.issueAction;
    if (action === "handled" || action === "ignored") {
      issue.status = action;
      issue.resolution = action === "handled" ? "作者手动确认已处理" : "作者手动忽略";
      issue.updatedAt = Date.now();
      save({ immediateDisk: true });
      loadWriteView();
      loadControlView();
      return;
    }
    if (action === "repair") {
      const p = project();
      const chapter = p.chapters.find((item) => item.id === p.activeChapterId);
      const task = p.tasks.find((item) => item.id === chapter?.taskId || item.id === p.activeTaskId);
      if (!chapter?.body?.trim()) return alert("本章没有可修复的正文");
      withAbort((signal) =>
        WriteCases.repairIssue(
          { project: p, cfg, chapter, task, issue, signal },
          {
            ...writeUseCasePorts(),
            repairOutcome: ({ chapter: repaired, handedOff }) => {
              if (handedOff) return setStatus("局部修复完成 · 记忆已交接", "");
              const handoff = handoffStatusSuffix(repaired, "待重新交接");
              setStatus(`局部修复完成 · ${handoff.suffix}`, handoff.kind);
            },
          }
        )
      );
    }
  });

  // 快捷键
  document.addEventListener("keydown", (e) => {
    const openModal = [$("settingsModal"), $("taskModal"), $("snapshotModal"), $("saveConflictModal")].find(
      (modal) => modal && !modal.hidden
    );
    if (e.key === "Tab" && openModal) {
      const focusable = [...openModal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.getClientRects().length > 0);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const dialog = openModal.querySelector('[role="dialog"]');
        if (!openModal.contains(document.activeElement) || document.activeElement === dialog) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    const rovingKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (rovingKeys.includes(e.key)) {
      const settingsTab = e.target?.closest?.(".settings-nav-item");
      if (settingsTab) {
        e.preventDefault();
        moveRovingTab(settingsTab, ".settings-nav-item", e.key, (next) => {
          setSettingsTab(next.dataset.settingsTarget, { focus: true });
        });
        return;
      }
      const inspectorTab = e.target?.closest?.(".inspector-tab");
      if (inspectorTab) {
        e.preventDefault();
        moveRovingTab(inspectorTab, ".inspector-tab", e.key, (next) => {
          setInspectorTab(next.dataset.inspectorTarget, { open: true, focus: true });
        });
        return;
      }
      const themeOption = e.target?.closest?.(".theme-swatch");
      if (themeOption) {
        e.preventDefault();
        moveRovingTab(themeOption, ".theme-swatch", e.key, (next) => {
          applyTheme(next.dataset.theme, true);
          next.focus();
        });
        return;
      }
    }
    if (e.key === "Escape") {
      if (!$("saveConflictModal")?.hidden) {
        closeSaveConflictModal({ keepPending: true });
        return;
      }
      setLibraryDrawer(false, true);
      setChapterDrawer(false);
      setInspectorDrawer(false);
      if (!$("settingsModal")?.hidden) closeSettings(false);
      if (!$("taskModal")?.hidden) {
        $("taskModal").hidden = true;
        syncModalBackgroundInert();
        editingTaskId = null;
      }
      if (!$("snapshotModal")?.hidden) $("btnCloseSnapshots")?.click();
      modalReturnFocus?.focus?.();
      modalReturnFocus = null;
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && ["1", "2", "3"].includes(e.key)) {
      e.preventDefault();
      switchMode(["pipeline", "control", "graph"][Number(e.key) - 1]);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      // 工作区优先保存当前打开的文件，避免整本 flush 用内存旧稿盖掉 md
      if (document.getElementById("view-workspace")?.classList.contains("active")) {
        void Ws?.saveCurrent?.().catch((e) => console.warn("workspace shortcut save", e));
        return;
      }
      saveActiveChapterNow();
      return;
    }
    if (["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      const modes = ["write", uiState.storyMode || "control", "workspace", "analyze"];
      switchMode(modes[Number(e.key) - 1]);
    }
  });

  window.addEventListener("focus", () => checkExternalChange());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkExternalChange();
  });

  $("btnNewProject").addEventListener("click", async () => {
    const name = prompt("新书名 / 意向一句话？", "热血玄幻，废柴逆袭");
    if (name === null) return;
    syncEditorToProject();
    try {
      await flushToDisk();
    } catch (e) {
      alert("当前作品保存失败，已取消新建书。\n\n" + (e.message || e));
      return;
    }
    try {
      let p;
      if (vaultOnline) {
        p = await Vault.createBook(name.slice(0, 40) || "新书", name);
        setVaultStatus(`已建夹 · ${p.slug}`, "ok");
      } else {
        p = Store.defaultProject();
        p.ideaInput = name;
        p.title = name.slice(0, 20);
        alert("本地服务未连接：新书只存在浏览器缓存。请启动本地服务后再试。");
      }
      state.projects.unshift(p);
      state.activeId = p.id;
      Store.saveAll(state);
      await refreshLibraryFromServer();
      switchMode("pipeline");
      loadPipelineView();
      renderProjects();
    } catch (e) {
      alert("创建新书失败: " + (e.message || e));
    }
  });

  $("btnImportSeed").addEventListener("click", async () => {
    try {
      const res = await fetch("samples/xuanhuan-romance-seed.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const seed = await res.json();
      seed.id = Store.uid();
      seed.createdAt = Date.now();
      seed.updatedAt = Date.now();
      seed.pipelineLog = [
        { t: Date.now(), msg: "已导入示例策划《红莲渡鹤归》（玄幻+言情双强）" },
      ];
      if (seed.tasks?.length) seed.activeTaskId = seed.tasks[0].id;
      syncEditorToProject();
      try {
        await flushToDisk();
      } catch (e) {
        alert("当前作品保存失败，已取消导入示例。\n\n" + (e.message || e));
        return;
      }

      if (vaultOnline) {
        // 先建夹再写入完整 seed；走 flushProject 以便 adopt 基线并进串行锁
        const created = await Vault.createBook(seed.title || "红莲渡鹤归", seed.ideaInput || "");
        seed.slug = created.slug;
        seed.id = created.id || seed.id;
        state.projects.unshift(seed);
        state.activeId = seed.id;
        await flushProject(seed);
        setVaultStatus(`示例已写入 · ${seed.slug}`, "ok");
      } else {
        state.projects.unshift(seed);
        state.activeId = seed.id;
      }
      Store.saveAll(state);
      switchMode("pipeline");
      loadPipelineView();
      loadControlView();
      loadGraphView();
      renderProjects();
      alert(
        vaultOnline
          ? `已导入《红莲渡鹤归》到本地书夹：\nbooks/${seed.slug}\n\n可用 Obsidian 打开该文件夹。`
          : "已导入（仅浏览器缓存）。请启动本地服务以写入文件夹。"
      );
    } catch (e) {
      alert("导入失败（请确认本地服务已连接）\n" + (e.message || e));
    }
  });

  function downloadMarkdown(p) {
    DiagnosticsUI.downloadText(
      PersistenceFactory.buildExportMarkdown(p),
      `${p.title || "novel"}-全书.md`,
      "text/markdown;charset=utf-8"
    );
  }

  $("btnExport").addEventListener("click", async () => {
    syncEditorToProject();
    const p = project();
    const choice = prompt(
      "导出方式：\n1 = 只打开本地书文件夹\n2 = 只下载合并 Markdown\n3 = 两者都做\n\n请输入 1 / 2 / 3",
      "1"
    );
    if (choice === null) return;
    const mode = String(choice).trim() || "1";

    if ((mode === "1" || mode === "3") && vaultOnline && p.slug) {
      try {
        await flushToDisk();
        await Vault.revealBook(p.slug);
        setVaultStatus(`已打开文件夹 · ${p.slug}`, "ok");
      } catch (e) {
        alert("打开本地文件夹失败: " + (e.message || e));
      }
    } else if ((mode === "1" || mode === "3") && !vaultOnline) {
      alert("未连接本地服务，无法打开文件夹。将改为下载 md。");
    }

    if (mode === "2" || mode === "3" || ((mode === "1" || mode === "3") && !vaultOnline)) {
      downloadMarkdown(p);
    }
  });

  DiagnosticsUI.bindDiagnosticsExport({
    button: $("btnExportDiagnostics"),
    getProject: project,
    syncEditor: syncEditorToProject,
    setStatus,
    meta: $("cfgDiagnosticsMeta"),
    alert,
  });

  $("btnOpenVault")?.addEventListener("click", async () => {
    if (!vaultOnline) {
      alert("本地服务未连接，无法打开文件夹");
      return;
    }
    try {
      setVaultStatus("正在打开文件夹…", "busy");
      const p = project();
      let res;
      if (p?.slug) {
        res = await Vault.revealBook(p.slug);
      } else if (vaultPath) {
        res = await Vault.reveal(vaultPath);
      } else {
        alert("当前没有可打开的书或书库路径");
        setVaultStatus("无路径可打开", "warn");
        return;
      }
      const opened = res?.path || (p?.slug ? `books/${p.slug}` : vaultPath);
      setVaultStatus(`已在资源管理器打开 · ${opened}`, "ok");
    } catch (e) {
      setVaultStatus("打开文件夹失败", "err");
      alert("打开文件夹失败: " + (e.message || e));
    }
  });

  $("btnReloadDisk")?.addEventListener("click", async () => {
    if (!vaultOnline) {
      alert("本地服务未连接，无法重载");
      return;
    }
    if (guardGen("重载")) return;
    const p = project();
    if (!p?.slug) {
      alert("当前书无本地文件夹（缺少 slug）。请先在左侧书库点选一本书。");
      return;
    }
    const flags = diskAdoptFlags(p);
    const hasUnsaved =
      flags.dirty || flags.pendingConflict || flags.editorDesynced || flags.workspaceChapterDirty;
    if (
      !confirm(
        hasUnsaved
          ? "有未同步到磁盘的修改。重载将丢弃内存改动，用磁盘版本覆盖。确定？"
          : "从磁盘重载将覆盖当前内存中的本书内容。确定？"
      )
    ) {
      return;
    }
    try {
      setVaultStatus(`重载 ${p.slug}…`, "busy");
      const fresh = await Vault.reloadBook(p.slug);
      const result = await replaceMemoryWithDisk(p, fresh, { intent: "discard" });
      if (!result.replaced) {
        throw new Error(result.verdict?.reason || "未能采用磁盘版本");
      }
      renderAll();
      loadWriteView();
      loadControlView();
      loadGraphView();
      // 工作区树/打开文件一并刷新，避免「点了重载界面没变」
      try {
        await Ws?.bindBook?.(result.project.slug, { autoOpen: true });
      } catch (we) {
        console.warn("reload bindBook", we);
      }
      setVaultStatus(`已从磁盘重载 · 未存盘稿已丢弃`, "ok");
    } catch (e) {
      setVaultStatus("重载失败", "err");
      alert("重载失败: " + (e.message || e));
    }
  });

  $("btnMigrate")?.addEventListener("click", async () => {
    if (!vaultOnline) return alert("本地服务未连接");
    const cached = Store.loadAll();
    if (!cached.projects?.length) return alert("浏览器缓存里没有作品");
    const filtered = filterMigrateProjects(cached.projects || []);
    if (!filtered.ok) return alert(filtered.reason || "无法迁入");
    const toMigrate = filtered.projects;
    if (!confirm(`把浏览器里 ${toMigrate.length} 部作品写入 vault/books/ ？`)) return;
    try {
      setVaultStatus("迁移中…", "busy");
      const res = await Vault.migrate(toMigrate);
      assertMigrationComplete(res, toMigrate.length);
      await bootFromVault(true);
      setVaultStatus(`已迁入 ${res.migrated?.length || 0} 部`, "ok");
      alert(`迁移完成 ${res.migrated?.length || 0} 部。\n书库：${vaultPath}`);
    } catch (e) {
      alert("迁移失败: " + (e.message || e));
    }
  });

  // Settings
  async function openSettings() {
    modalReturnFocus = document.activeElement;
    $("cfgBase").value = cfg.baseUrl || "";
    $("cfgKey").value = cfg.apiKey || "";
    $("cfgModel").value = cfg.model || "";
    $("cfgBudget").value = cfg.contextBudgetChars || window.NOVEL_DEFAULTS?.contextBudgetChars || 16000;
    if ($("cfgTokenBudget")) {
      $("cfgTokenBudget").value = cfg.contextBudgetTokens || window.NOVEL_DEFAULTS?.contextBudgetTokens || 12000;
    }
    if ($("cfgOutputTokens")) {
      $("cfgOutputTokens").value = cfg.outputReserveTokens || window.NOVEL_DEFAULTS?.outputReserveTokens || 3500;
    }
    $("cfgChapWords").value = cfg.chapterTargetWords || 2000;
    if ($("cfgPrevTail")) $("cfgPrevTail").value = cfg.prevChapterTailChars || window.NOVEL_DEFAULTS?.prevChapterTailChars || 1800;
    if ($("cfgMemDepth")) $("cfgMemDepth").value = cfg.memoryDepth || window.NOVEL_DEFAULTS?.memoryDepth || 12;
    if ($("cfgHarness")) $("cfgHarness").checked = cfg.harnessEnabled !== false;
    if ($("cfgProduction")) $("cfgProduction").checked = cfg.productionEngineEnabled !== false;
    if ($("cfgQualityGate")) $("cfgQualityGate").value = cfg.productionQualityPolicy === "warn" ? "warn" : "strict";
    if ($("cfgManualHandoff")) $("cfgManualHandoff").checked = cfg.manualAutoHandoff !== false;
    if ($("cfgContinuityReview")) $("cfgContinuityReview").checked = cfg.continuityReviewEnabled !== false;
    if ($("cfgContinuityRepair")) $("cfgContinuityRepair").checked = cfg.continuityAutoRepair !== false;
    if ($("cfgChapterBeat")) $("cfgChapterBeat").checked = cfg.chapterBeatEnabled !== false;
    if ($("cfgProseLint")) $("cfgProseLint").checked = cfg.proseLintEnabled !== false;
    if ($("cfgContinuityStrict")) $("cfgContinuityStrict").checked = cfg.continuityReviewPolicy === "strict";
    if ($("cfgRag")) $("cfgRag").checked = cfg.ragEnabled !== false;
    if ($("cfgRagStrict")) $("cfgRagStrict").checked = cfg.ragFailurePolicy === "strict";
    if ($("cfgRagEmbed")) $("cfgRagEmbed").checked = !!cfg.ragUseEmbeddings;
    if ($("cfgRagTopK")) $("cfgRagTopK").value = cfg.ragTopK || window.NOVEL_DEFAULTS?.ragTopK || 8;
    $("testLog").textContent = "";
    applyTheme(cfg.theme || "soft-paper", false);

    // 本地书库信息
    const pathEl = $("cfgVaultPath");
    if (pathEl) pathEl.value = vaultPath || (vaultOnline ? "（路径未知）" : "未连接本地服务");
    const metaEl = $("cfgEngineMeta");
    if (metaEl) {
      metaEl.innerHTML = `<span>引擎 / 版本：加载中…</span>`;
    }
    $("settingsModal").hidden = false;
    syncModalBackgroundInert($("settingsModal"));
    window.setTimeout(() => $("settingsModal")?.querySelector(".modal")?.focus(), 0);

    // 异步刷新 settings/health
    try {
      let version = window.NOVEL_APP_VERSION || CLIENT_VERSION;
      let engine = vaultOnline ? "mogao" : "offline";
      let booksPath = "";
      if (vaultOnline) {
        try {
          const st = await Vault.settings();
          if (st?.vaultPath) {
            vaultPath = st.vaultPath;
            if (pathEl) pathEl.value = vaultPath;
            updateVaultPathUI();
          }
          if (st?.version) version = st.version;
          if (st?.booksPath) booksPath = st.booksPath;
          if (st?.engine) engine = st.engine;
        } catch (_) {}
        try {
          const h = await Vault.health();
          if (h?.version) version = h.version;
          if (h?.app) engine = h.app;
          else if (h?.engine) engine = h.engine;
          if (h?.vault && !vaultPath) {
            vaultPath = h.vault;
            if (pathEl) pathEl.value = vaultPath;
          }
        } catch (_) {}
      }
      if (metaEl) {
        const lines = [
          `引擎：${engine}`,
          `版本：v${version}`,
          booksPath ? `books：${booksPath}` : "",
          vaultOnline ? "状态：已连接" : "状态：未连接",
        ].filter(Boolean);
        metaEl.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
      }
    } catch (e) {
      if (metaEl) metaEl.innerHTML = `<span>引擎信息加载失败</span>`;
    }
  }
  function applySettingsFromForm() {
    cfg.baseUrl = $("cfgBase").value.trim();
    cfg.apiKey = $("cfgKey").value.trim();
    cfg.model = $("cfgModel").value.trim() || "gemini-3.6-flash";
    cfg.contextBudgetChars = Number($("cfgBudget").value) || window.NOVEL_DEFAULTS?.contextBudgetChars || 16000;
    if ($("cfgTokenBudget")) {
      cfg.contextBudgetTokens = Number($("cfgTokenBudget").value) || window.NOVEL_DEFAULTS?.contextBudgetTokens || 12000;
    }
    if ($("cfgOutputTokens")) {
      cfg.outputReserveTokens = Math.max(
        512,
        Math.min(65536, Number($("cfgOutputTokens").value) || window.NOVEL_DEFAULTS?.outputReserveTokens || 3500)
      );
    }
    cfg.chapterTargetWords = Number($("cfgChapWords").value) || 2000;
    if ($("cfgPrevTail")) {
      cfg.prevChapterTailChars = Number($("cfgPrevTail").value) || window.NOVEL_DEFAULTS?.prevChapterTailChars || 1800;
    }
    if ($("cfgMemDepth")) {
      cfg.memoryDepth = Number($("cfgMemDepth").value) || window.NOVEL_DEFAULTS?.memoryDepth || 12;
    }
    if ($("cfgHarness")) cfg.harnessEnabled = !!$("cfgHarness").checked;
    if ($("cfgProduction")) cfg.productionEngineEnabled = !!$("cfgProduction").checked;
    if ($("cfgQualityGate")) cfg.productionQualityPolicy = $("cfgQualityGate").value === "warn" ? "warn" : "strict";
    if ($("cfgManualHandoff")) cfg.manualAutoHandoff = !!$("cfgManualHandoff").checked;
    if ($("cfgContinuityReview")) cfg.continuityReviewEnabled = !!$("cfgContinuityReview").checked;
    if ($("cfgContinuityRepair")) cfg.continuityAutoRepair = !!$("cfgContinuityRepair").checked;
    if ($("cfgChapterBeat")) cfg.chapterBeatEnabled = !!$("cfgChapterBeat").checked;
    if ($("cfgProseLint")) cfg.proseLintEnabled = !!$("cfgProseLint").checked;
    if ($("cfgContinuityStrict")) {
      cfg.continuityReviewPolicy = $("cfgContinuityStrict").checked ? "strict" : "warn";
    }
    if ($("cfgRag")) cfg.ragEnabled = !!$("cfgRag").checked;
    if ($("cfgRagStrict")) cfg.ragFailurePolicy = $("cfgRagStrict").checked ? "strict" : "warn";
    if ($("cfgRagEmbed")) cfg.ragUseEmbeddings = !!$("cfgRagEmbed").checked;
    if ($("cfgRagTopK")) cfg.ragTopK = Number($("cfgRagTopK").value) || 8;
    const activeTheme =
      document.documentElement.getAttribute("data-theme") || cfg.theme || "soft-paper";
    cfg.theme = activeTheme;
    Store.saveCfg(cfg);
    // 立即写磁盘，避免关设置后杀进程丢 key
    persistCfg(true);
  }
  function closeSettings(save) {
    if (save) applySettingsFromForm();
    $("settingsModal").hidden = true;
    syncModalBackgroundInert();
    modalReturnFocus?.focus?.();
    modalReturnFocus = null;
  }
  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", () => closeSettings(true));
  $("settingsModal").addEventListener("click", (e) => {
    // 点遮罩仅关闭，不静默保存，避免误触改 key
    if (e.target === $("settingsModal")) closeSettings(false);
  });
  $("themeSwatches")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".theme-swatch");
    if (!btn?.dataset?.theme) return;
    applyTheme(btn.dataset.theme, true);
  });
  $("btnRebuildRag")?.addEventListener("click", async () => {
    applySettingsFromForm();
    const p = project();
    try {
      const idx = window.NOVEL_HARNESS?.rebuildIndex?.(p) || window.NOVEL_RAG?.ensureIndex?.(p, true);
      try {
        await flushProject(p);
      } catch (_) {
        Store.saveAll(state);
      }
      setStatus(`RAG 索引已重建：${idx?.N || p.ragIndex?.N || 0} 文档`, "ok");
      alert(`RAG 索引重建完成\n文档数：${idx?.N || p.ragIndex?.N || 0}`);
    } catch (e) {
      alert("重建失败: " + (e.message || e));
    }
  });

  $("btnTestApi").addEventListener("click", async () => {
    applySettingsFromForm();
    $("testLog").className = "test-log busy";
    $("testLog").textContent = "正在连接模型服务…";
    $("btnTestApi").disabled = true;
    try {
      const { content } = await API.chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        seed: cfg.seed,
        stream: false,
        messages: [{ role: "user", content: "只回：连接成功" }],
      });
      $("testLog").className = "test-log ok";
      $("testLog").textContent = `连接成功 · ${cfg.model}\n${content}`;
    } catch (e) {
      $("testLog").className = "test-log err";
      $("testLog").textContent = `连接失败。请检查密钥、模型名称和高级设置中的服务地址。\n详情：${String(e.message || e)}`;
    } finally {
      $("btnTestApi").disabled = false;
    }
  });

  // Mode nav
  document.querySelectorAll(".mode").forEach((b) => {
    b.addEventListener("click", () => switchMode(b.dataset.mode));
  });

  async function bootFromVault(force) {
    const lib = await Vault.library();
    vaultPath = lib.vault || vaultPath;
    updateVaultPathUI();
    const books = lib.books || [];
    libraryBooks = books;
    if (!books.length) {
      if (!force) return false;
      state = { projects: [], activeId: null };
      return true;
    }
    const meta = Store.loadMeta();
    const preferSlug =
      (meta.activeSlug && books.find((b) => b.slug === meta.activeSlug)?.slug) || books[0].slug;

    // 按需：只完整加载当前书，其余用轻量 stub（切书时再 loadBook）
    const projects = [];
    for (const b of books) {
      if (b.slug === preferSlug) {
        try {
          const full = await Vault.loadBook(b.slug);
          if (!full.id) full.id = b.id || Store.uid();
          full.slug = b.slug;
          projects.push(full);
        } catch (e) {
          console.warn("load active book failed", b.slug, e);
          projects.push({
            ...Store.defaultProject(),
            id: b.id || Store.uid(),
            slug: b.slug,
            title: b.title || b.slug,
            updatedAt: Number(b.updatedAt) || Number(b.mtime) || 0,
            createdAt: Number(b.updatedAt) || Number(b.mtime) || 0,
            chapters: [],
            _stub: true,
          });
        }
      } else {
        projects.push({
          ...Store.defaultProject(),
          id: b.id || Store.uid(),
          slug: b.slug,
          title: b.title || b.slug,
          stage: b.stage || "idea",
          updatedAt: Number(b.updatedAt) || Number(b.mtime) || 0,
          createdAt: Number(b.updatedAt) || Number(b.mtime) || 0,
          chapters: [],
          _stub: true,
        });
      }
    }
    if (!projects.length) return false;
    const prefer = projects.find((p) => p.slug === preferSlug) || projects[0];
    // 若当前是 stub（加载失败），仍允许进入
    state = { projects, activeId: prefer.id };
    const recovered = Store.applyRecovery?.(state) || 0;
    if (recovered > 0) {
      dirty = true;
      setVaultStatus(`已恢复 ${recovered} 章未落盘正文，请确认后保存`, "warn");
    }
    Store.saveAll(state);
    Store.saveMeta({ activeId: prefer.id, activeSlug: prefer.slug, vaultPath });
    return true;
  }

  async function boot() {
    const isDesktop =
      !!(window.pywebview?.api) || isTauri() || /desktop=1/.test(location.search);
    if (isDesktop) {
      document.body.classList.add("is-desktop");
      const sub = document.querySelector(".brand-sub");
      if (sub) sub.textContent = "Inkwell · 本地创作与叙事分析";
    }
    const verEl = $("appVersion");
    if (verEl) verEl.textContent = `v${window.NOVEL_APP_VERSION || "0.19.0"}`;

    setVaultStatus("连接本地书库…", "busy");
    const health = await Vault.health();
    vaultOnline = !!(health && health.ok);
    vaultPath = health?.vault || "";

    // 优先用 settings 拿完整 vault 路径 + 恢复 clientCfg/uiState（磁盘权威）
    if (vaultOnline) {
      try {
        const st = await Vault.settings();
        if (st?.vaultPath) vaultPath = st.vaultPath;
        if (st?.version && verEl) verEl.textContent = `v${st.version}`;
        if (st?.clientCfg && typeof st.clientCfg === "object") {
          cfg = Store.mergeCfgFromServer(cfg, st.clientCfg);
          Store.saveCfg(cfg);
          applyTheme(cfg.theme || "soft-paper", false);
        }
        if (st?.uiState && typeof st.uiState === "object") {
          uiState = normalizeUiState({ ...uiState, ...st.uiState });
          Store.saveUiState?.(uiState);
        }
        // 若本地有 key 而磁盘没有，补写一次（迁移旧 localStorage）
        if (cfg.apiKey || cfg.theme) {
          try {
            await Vault.putSettings({
              clientCfg: { ...cfg },
              uiState: { ...uiState },
              replaceClientCfg: true,
            });
          } catch (_) {}
        }
      } catch (e) {
        console.warn("settings", e);
      }
    }
    updateVaultPathUI();
      try {
        initCollapsiblePanels();
        initDetailsAccessibility();
        bindDelegatedPanelActions();
      } catch (e) {
        console.warn("panels/accessibility", e);
      }

    if (health?.version) {
      if (verEl) verEl.textContent = `v${health.version}`;
      // 版本协商：旧 server 缺字段或版本过旧
      const hv = String(health.version);
      if (hv === "vault-1" || (health.app !== "mogao" && !/^\d+\.\d+/.test(hv))) {
        alert(
          "检测到旧版/不匹配的本地服务仍在运行（" +
            hv +
            "）。\n请关掉旧进程后重新启动本地服务，\n否则存盘/快照等新功能可能异常。"
        );
        setVaultStatus("服务版本过旧 · 请重启", "err");
      } else if (hv !== CLIENT_VERSION) {
        // 前后端小版本差只提示状态栏
        setVaultStatus(`服务 v${hv} / 客户端 v${CLIENT_VERSION}`, "warn");
      }
    }

    if (vaultOnline) {
      const ok = await bootFromVault(false);
      if (!ok) {
        const cached = Store.loadAll();
        if (cached.projects?.length) {
          state = cached;
          const filtered = filterMigrateProjects(cached.projects || []);
          if (!filtered.ok) {
            state = { projects: [], activeId: null };
            setVaultStatus("书库为空 · 缓存无可用正文（已跳过迁入）", "warn");
          } else {
            setVaultStatus("书库为空 · 可迁入浏览器缓存", "warn");
            if (
              confirm(
                `本地书库是空的，浏览器里有 ${filtered.projects.length} 部可迁入作品。\n要立刻迁入 vault/books/ 吗？`
              )
            ) {
              try {
                // A2：与按钮迁入同一 slim 过滤，禁止空壳毁库
                const migrated = await Vault.migrate(filtered.projects);
                assertMigrationComplete(migrated, filtered.projects.length);
                await bootFromVault(true);
                setVaultStatus("迁移完成", "ok");
              } catch (e) {
                alert("迁移失败: " + (e.message || e));
              }
            }
          }
        }
        if (!state.projects?.length) {
          await ensureEmptyVaultBook();
        }
      } else {
        if (!state.projects?.length) {
          await ensureEmptyVaultBook();
        }
        setVaultStatus(`书库 · ${(state.projects || []).length} 部`, "ok");
      }
      await refreshLibraryFromServer();
      updateVaultPathUI();
      const cur = project();
      if (cur?.slug) {
        try {
          const meta = await Vault.meta(cur.slug);
          diskMtime = meta.mtime || 0;
        } catch (_) {}
      }
    } else {
      state = Store.loadAll();
      setVaultStatus("本地服务未连接", "err");
      updateVaultPathUI();
      console.warn("Vault offline — local service not connected");
    }

    if (!state.projects?.length) {
      const p = Store.defaultProject();
      state = { projects: [p], activeId: p.id };
      Store.saveAll(state);
    }

    const restoredConflictCount = restorePersistedSaveConflicts();
    dirty = restoredConflictCount > 0 || (state.projects || []).some((item) => item?._dirty === true);
    if (restoredConflictCount > 0) {
      setVaultStatus(`已恢复 ${restoredConflictCount} 个待处理保存冲突`, "warn");
    } else if (dirty) {
      setVaultStatus("已恢复未落盘正文，请确认后保存", "warn");
    }

    // 初始化 Obsidian 风格工作区
    Ws?.init?.({
      getProjectReadOnlyReason: () => projectReadOnlyReason(project()),
      onStatus: (msg, kind) => {
        if (kind === "err") setVaultStatus(msg, "err");
        else if (kind === "ok" && msg) setVaultStatus(msg, "ok");
      },
      onBookMutated: async (slug, meta = {}) => {
        // P0-4：生成事务中禁止 mutate reload，避免覆盖正在流式写入的正文
        if (genLocked || window.__mogaoGen?.locked) {
          setStatus("生成中，跳过书目重载", "muted");
          return;
        }
        const cur = project();
        if (!cur || cur.slug !== slug) return;
        try {
          if (meta.source === "snapshot") {
            const fresh = await Vault.reloadBook(slug);
            await replaceMemoryWithDisk(cur, fresh, { intent: "discard" });
            if (isWriteViewActive()) loadWriteView();
            return;
          }
          if (isWriteViewActive()) syncEditorToProject();
          // 存盘过程中的资料回写不能等待 Persistence，否则会跟 flushToDisk 互相等待。
          const verdict = Vault.classifyDiskAdopt(diskAdoptFlags(cur));
          if (verdict.ok) {
            await reloadActiveBookFromDisk({ silent: true });
            if (isWriteViewActive()) loadWriteView();
            return;
          }
          if (Persistence.isSaving()) {
            setVaultStatus("正在存盘 · 写章台未存盘正文仍保留", "warn");
            return;
          }
          const fresh = await Vault.reloadBook(slug);
          refreshConflictDiskSides(cur, fresh);
          const added = enqueueChapterConflictsIfDiverged(cur, fresh);
          if (added) openNextSaveConflict();
          else setVaultStatus("资料已写入磁盘 · 写章台未存盘正文仍保留", "warn");
        } catch (e) {
          console.warn("book mutate reload", e);
        }
      },
    });

    // 叙事分析 UI
    window.NOVEL_ANALYZE_UI?.init?.({
      $,
      project,
      getCfg: () => cfg,
      setStatus,
      vaultOnline: () => vaultOnline,
      graphToMermaid: (g) => Ctx.graphToMermaid(g),
      markDirty: () => markDirty(),
      saveProject: async (p) => {
        if (!p?.slug || !vaultOnline) {
          Store.saveAll(state);
          return;
        }
        try {
          p._dirty = true;
          Store.saveRecovery?.(p);
          const result = await flushProject(p);
          if (projectHasPendingSaveConflict(p)) {
            const conflictError = new Error(
              "分析结果已生成，但作品保存检测到外部章节冲突。请先在冲突对话框中选择保留版本，再继续分析。"
            );
            conflictError.code = "ANALYSIS_SAVE_CONFLICT";
            throw conflictError;
          }
          loadGraphView();
          return result;
        } catch (e) {
          console.warn("saveProject after analysis", e);
          p._dirty = true;
          Store.saveRecovery?.(p);
          throw e;
        }
      },
      onGraphUpdated: (p) => {
        Store.saveAll(state);
        loadGraphView();
      },
    });

    renderProjects();
    loadPipelineView();
    loadControlView();
    loadWriteView();
    loadGraphView();
    const initialMode = UiShell?.startupModeForState?.(uiState) || "write";
    await switchMode(initialMode);
    setInspectorTab(uiState.inspectorTab || "task", { open: false, persist: false });
    setFocusMode(initialMode === "write" && !!uiState.focusMode, false);
    setLibraryDrawer(!!uiState.libraryOpen, false);
    Composition.assertComplete(window);
    bootDone = true;
    window.__mogaoReady = true;
    setStatus("就绪", "muted");
    if (restoredConflictCount > 0) {
      setVaultStatus(`已恢复 ${restoredConflictCount} 个待处理保存冲突`, "warn");
      if (projectHasPendingSaveConflict(project())) openNextSaveConflict();
    }

    window.addEventListener("beforeunload", (ev) => {
      let flushSucceeded;
      try {
        flushSucceeded = window.__mogaoFlushSync?.() !== false;
      } catch (_) {
        flushSucceeded = false;
      }
      if (!flushSucceeded || Ws?.isDirty?.() || (dirty && vaultOnline)) {
        ev.preventDefault();
        ev.returnValue = "尚有未确认存盘的修改";
      }
    });
  }

  // 书库 UI 模块：开库/建库/导入/筛选/跨书搜索
  window.NOVEL_VAULT_UI?.init?.({
    $,
    Vault,
    Store,
    Ws,
    getVaultPath: () => vaultPath,
    setVaultPath: (p) => {
      vaultPath = p || "";
    },
    isVaultOnline: () => vaultOnline,
    setVaultOnline: (v) => {
      vaultOnline = !!v;
    },
    setVaultStatus,
    updateVaultPathUI,
    prepareVaultSwitch,
    afterVaultSwitch,
    bootFromVault,
    ensureEmptyVaultBook,
    refreshLibraryFromServer,
    refreshLibrarySidebar,
    switchToSlug,
    switchMode,
    renderAll,
    loadPipelineView,
    loadControlView,
    loadWriteView,
    loadGraphView,
    project,
    getState: () => state,
    getProjectCount: () => (state.projects || []).length,
    applyLibrarySnapshot: (lib) => {
      if (!lib) return;
      if (Array.isArray(lib.books)) libraryBooks = lib.books;
      else if (Array.isArray(lib)) libraryBooks = lib;
      if (lib.vault) vaultPath = lib.vault;
      if (lib.vaultPath) vaultPath = lib.vaultPath;
    },
    syncDiskMtime: async (slug) => {
      try {
        const meta = await Vault.meta(slug);
        diskMtime = meta.mtime || 0;
      } catch (_) {}
    },
    tauriInvoke,
    isTauri,
    closeSettings: (save) => closeSettings(save),
  });

  // 初始 gen 状态
  window.__mogaoGen = { locked: false, writingChapterId: null, writingFileHints: [] };

  boot().catch((e) => {
    console.error(e);
    // vault 已在线时内存可能已是 hydrate 全书；禁止再用 slim 缓存盖掉。
    if (!vaultOnline) {
      state = Store.loadAll();
    }
    try {
      renderProjects();
      loadPipelineView();
    } catch (_) {}
    setStatus("启动异常", "err");
    setVaultStatus(String(e.message || e), "err");
  });
})();
