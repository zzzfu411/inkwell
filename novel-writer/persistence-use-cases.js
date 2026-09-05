/**
 * 作品保存用例。
 *
 * 事务顺序与串行化集中在这里；DOM、工作区和 HTTP 都通过 deps 端口注入。
 * 这样控制器只负责采集界面值，保存用例可用内存端口独立验证。
 */
window.NOVEL_PERSISTENCE_USE_CASES = (() => {
  "use strict";

  /** 将资料区章节快照合并回工程；调用方负责从 DOM/工作区采集 snapshot。 */
  function mergeWorkspaceChapter(project, snapshot, options = {}) {
    if (!project || !snapshot) return null;
    const workspaceSlug = String(snapshot.slug || "");
    if (workspaceSlug && project.slug && workspaceSlug !== project.slug) return null;
    if (!snapshot.dirty) return null;
    const workspacePath = snapshot.path;
    if (!workspacePath) return null;
    const normalizedPath = String(workspacePath).replace(/\\/g, "/");
    if (!normalizedPath.startsWith("章节/") || !/\.md$/i.test(normalizedPath)) return null;
    const content = options.chapterBodyFromMarkdown?.(snapshot.content) ?? snapshot.content;
    const basename = normalizedPath.split("/").pop() || "";
    const stem = basename.replace(/\.md$/i, "");
    const chapters = Array.isArray(project.chapters) ? project.chapters : [];
    const chapter =
      chapters.find((item) => {
        const file = String(item._file || item.path || "").replace(/\\/g, "/");
        return file === normalizedPath || file === workspacePath;
      }) ||
      chapters.find((item) => {
        const file = String(item._file || item.path || "").replace(/\\/g, "/");
        return file === basename || file.endsWith("/" + basename);
      }) ||
      chapters.find((item) => {
        const title = String(item.title || "").trim();
        return Boolean(title) && (stem === title || stem.endsWith("-" + title) || stem.endsWith(title));
      });
    if (!chapter) return false;
    const bodyChanged = String(chapter.body || "") !== String(content || "");
    chapter.body = content;
    chapter.updatedAt = options.now ? options.now() : Date.now();
    if (!chapter._file) chapter._file = normalizedPath;
    if (bodyChanged) options.onBodyChanged?.(chapter);
    return true;
  }

  function canonicalFormJson(value) {
    if (value === undefined || value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
    if (Array.isArray(value)) return `[${value.map(canonicalFormJson).join(",")}]`;
    if (typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalFormJson(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(String(value));
  }

  function projectFormEqual(left, right) {
    return canonicalFormJson(left) === canonicalFormJson(right);
  }

  function formTextEqual(left, right) {
    return String(left || "") === String(right || "");
  }

  function formStringListEqual(left, right) {
    const normalize = (value) =>
      (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);
    const leftItems = normalize(left);
    const rightItems = normalize(right);
    return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index]);
  }

  function formIdSetEqual(left, right) {
    const leftIds = [...new Set((Array.isArray(left) ? left : []).map(String))].sort();
    const rightIds = [...new Set((Array.isArray(right) ? right : []).map(String))].sort();
    return leftIds.length === rightIds.length && leftIds.every((item, index) => item === rightIds[index]);
  }

  function formGraphEqual(left, right) {
    const normalize = (graph) => {
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) return { nodes: [], edges: [] };
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const edges = Array.isArray(graph.edges) ? graph.edges : [];
      const extra = Object.keys(graph).filter((key) => key !== "nodes" && key !== "edges");
      return !nodes.length && !edges.length && !extra.length ? { nodes: [], edges: [] } : graph;
    };
    return projectFormEqual(normalize(left), normalize(right));
  }

  function splitFormLines(value) {
    return String(value || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function buildExportMarkdown(project) {
    const lines = [`# ${project.title}`, "", `> ${project.pitch || ""}`, ""];
    lines.push(`> 本地路径: vault/books/${project.slug || "(未建夹)"}`, "");
    lines.push("## 锁定主线", project.locks?.logline || "", "");
    lines.push("## 禁区", (project.locks?.forbidden || []).map((item) => `- ${item}`).join("\n"), "");
    lines.push("## 人物", project.cast_summary || "", "");
    lines.push("## 关系 JSON", "```json", JSON.stringify(project.graph, null, 2), "```", "");
    lines.push("## 滚动摘要");
    for (const memory of project.memoryRoll || []) {
      lines.push(
        typeof memory === "string"
          ? "- " + memory
          : `- ${memory.chapter}: ${(memory.happened || []).join("，")}`
      );
    }
    lines.push("", "## 正文", "");
    const chapters = (project.chapters || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!chapters.length) lines.push("_（尚无章节正文）_");
    for (const chapter of chapters) {
      lines.push(`### ${chapter.title}`, "", chapter.body || "（空）", "");
    }
    return lines.join("\n");
  }

  /** 把展示层采集的普通对象写回工程；返回是否发生了可持久化变化。 */
  function applyProjectForm(project, form = {}, options = {}) {
    if (!project) return false;
    let changed = false;
    const note = (value) => {
      if (value) changed = true;
    };
    if (form.ideaInput !== undefined) {
      note(!formTextEqual(project.ideaInput, form.ideaInput));
      project.ideaInput = form.ideaInput;
    }
    if (form.authorNote !== undefined) {
      note(!formTextEqual(project.authorNote, form.authorNote));
      project.authorNote = form.authorNote;
    }
    if (form.targetChapters !== undefined) {
      const normalize = options.normalizeTargetChapters || ((value) => value);
      const next = normalize(form.targetChapters);
      note(normalize(project.targetChapters) !== next);
      project.targetChapters = next;
    }

    const locks = form.locks;
    if (locks) {
      const logline = String(locks.logline || "").trim();
      if (project._locksFormReady || logline || locks.forbidden || locks.mustHonor) {
        project.locks = project.locks || { logline: "", forbidden: [], mustHonor: [], lockedFields: [] };
        const nextLocks = {
          ...project.locks,
          logline,
          forbidden: splitFormLines(locks.forbidden),
          mustHonor: splitFormLines(locks.mustHonor),
          lockedFields: [
            locks.world ? "world" : "",
            locks.cast ? "cast" : "",
            locks.spine ? "spine" : "",
            logline ? "logline" : "",
          ].filter(Boolean),
        };
        note(
          !formTextEqual(project.locks.logline, nextLocks.logline) ||
            !formStringListEqual(project.locks.forbidden, nextLocks.forbidden) ||
            !formStringListEqual(project.locks.mustHonor, nextLocks.mustHonor) ||
            !formIdSetEqual(project.locks.lockedFields, nextLocks.lockedFields)
        );
        project.locks = nextLocks;
        if (project.spine && nextLocks.logline) project.spine.logline = nextLocks.logline;

        const style = locks.style || {};
        const dialogue = String(style.dialogue || "").trim();
        const rawPacing = String(style.pacing || "").trim();
        const pacing = options.recoverStylePacing
          ? options.recoverStylePacing(rawPacing, dialogue || project.styleBible?.dialogue)
          : rawPacing;
        const nextStyle = {
          ...(project.styleBible || {}),
          pov: String(style.pov || "").trim(),
          tense: String(style.tense || "").trim(),
          pacing,
          dialogue,
          rules: splitFormLines(style.rules),
          forbiddenPhrases: splitFormLines(style.forbiddenPhrases),
          examples: String(style.examples || "")
            .split(/\n\s*\n+/)
            .map((item) => item.trim())
            .filter(Boolean),
        };
        note(
          !formTextEqual(project.styleBible?.pov, nextStyle.pov) ||
            !formTextEqual(project.styleBible?.tense, nextStyle.tense) ||
            !formTextEqual(project.styleBible?.pacing, nextStyle.pacing) ||
            !formTextEqual(project.styleBible?.dialogue, nextStyle.dialogue) ||
            !formStringListEqual(project.styleBible?.rules, nextStyle.rules) ||
            !formStringListEqual(project.styleBible?.forbiddenPhrases, nextStyle.forbiddenPhrases) ||
            !formStringListEqual(project.styleBible?.examples, nextStyle.examples)
        );
        project.styleBible = nextStyle;
      }
    }

    if (form.graphJson !== undefined) {
      try {
        const graph = JSON.parse(form.graphJson || "{}");
        if (graph && typeof graph === "object") {
          note(!formGraphEqual(project.graph, graph));
          project.graph = graph;
        }
      } catch (_) {
        // 半截 JSON 不覆盖内存图谱。
      }
    }
    return changed;
  }

  function create(deps) {
    if (!deps || typeof deps !== "object") throw new Error("persistence deps are required");
    let inFlight = null;

    function observability() {
      return deps.getObservability?.() || null;
    }

    function activeContext(project) {
      const chapter = (project?.chapters || []).find((item) => item.id === project.activeChapterId) || null;
      const task =
        (project?.tasks || []).find(
          (item) => item.id === project.activeTaskId || item.id === chapter?.taskId
        ) || null;
      return { chapter, task };
    }

    function pendingConflictError(project) {
      const error = new Error("存在尚未处理的章节保存冲突");
      error.code = "SAVE_CONFLICT";
      const observer = observability();
      observer?.captureFailure?.(project, error, {
        ...activeContext(project),
        stage: "save-conflict",
        category: "conflict",
        retrySafe: false,
      });
      return error;
    }

    async function serialized(operation) {
      if (inFlight) {
        await inFlight;
        return serialized(operation);
      }
      const run = Promise.resolve().then(operation);
      inFlight = run;
      try {
        return await run;
      } finally {
        if (inFlight === run) inFlight = null;
      }
    }

    function saveMeta(project, result, active) {
      if (result?.path) project._path = result.path;
      if (result?.mtime && active) deps.setDiskMtime?.(result.mtime);
    }

    async function ensureBackingBook(project) {
      if (!project || project.slug) return;
      if (!deps.createBook) throw new Error("作品尚未建入本地书库，不能确认存盘成功");
      const created = await deps.createBook(project.title);
      if (!created?.slug) throw new Error("创建本地作品失败：服务未返回书籍路径");
      project.slug = created.slug;
      project._bookRevision = created._bookRevision;
      project._path = created._path;
      deps.saveCache();
    }

    async function persistProject(project, options = {}) {
      const active = deps.getActiveProject?.() === project;
      const revision = deps.readRevision(project);
      const observer = observability();
      const startedAt = observer?.startTimer?.();
      const bytes = observer?.byteLength?.(project) || 0;
      try {
        let result;
        try {
          result = await deps.saveBook(project.slug, project);
        } catch (error) {
          if (error.code !== "BOOK_CONFLICT" || !deps.resolveBookConflict) throw error;
          const disk = await deps.loadBook(project.slug);
          const choice = await deps.resolveBookConflict(project, disk);
          if (!["local", "disk"].includes(choice)) throw error;
          if (choice === "disk") {
            const keys = new Set([...Object.keys(project), ...Object.keys(disk)]);
            for (const key of keys) {
              if (key.startsWith("_") || ["chapters", "updatedAt", "activeChapterId"].includes(key)) continue;
              if (Object.hasOwn(disk, key)) project[key] = disk[key];
              else delete project[key];
            }
          }
          project._bookRevision = disk._bookRevision;
          deps.saveRecovery?.(project);
          deps.saveCache();
          result = await deps.saveBook(project.slug, project);
          deps.renderActive?.();
        }
        saveMeta(project, result, active);
        const warnings = Array.isArray(result?.saveWarnings) ? result.saveWarnings : [];
        deps.adoptBaselines?.(project, result, warnings);
        const reconciled = await deps.reconcileWarnings(project, warnings, revision);
        if (!reconciled.conflicts) {
          const message = reconciled.added
            ? `已同步并加入 ${reconciled.added} 个外部章节 · ${project.slug}`
            : options.silentStatus
              ? ""
              : `已同步 · ${project.slug}`;
          deps.markClean(message, { project, revision });
        }
        observer?.record?.(
          "storage",
          {
            stage: "save-book",
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: true,
            bytes,
            chapters: project.chapters,
            warnings,
            conflicts: reconciled.conflicts,
          },
          project
        );
        return { result, reconciled };
      } catch (error) {
        if (!error.code) error.code = "STORAGE_SAVE_FAILED";
        const failure = observer?.captureFailure?.(project, error, {
          ...activeContext(project),
          stage: "save-book",
        });
        observer?.record?.(
          "storage",
          {
            stage: "save-book",
            durationMs: observer.elapsedMs?.(startedAt) || 0,
            ok: false,
            bytes,
            chapters: project.chapters,
            code: failure?.code || error.code,
            category: failure?.category || "storage",
          },
          project
        );
        throw error;
      }
    }

    async function runCurrent() {
      if (!deps.isOnline()) return null;
      const project = deps.getActiveProject?.();
      if (!project) return null;
      deps.assertWritable(project);
      await ensureBackingBook(project);
      await deps.ensureWorkspaceSaved("整本保存");
      if (deps.hasPendingConflict(project)) {
        deps.openNextConflict?.();
        throw pendingConflictError(project);
      }
      deps.setStatus?.(`写入 ${project.slug}…`, "busy");
      const merged = deps.mergeWorkspace(project);
      if (merged === false) return deps.saveWorkspaceOnly(project, { announce: true });
      deps.syncActiveEditor();
      const saved = await persistProject(project);
      deps.refreshLibrary?.();
      return saved.result;
    }

    async function runFixed(project) {
      if (!project) return null;
      deps.assertWritable(project);
      if (deps.hasPendingConflict(project)) {
        if (deps.getActiveProject?.() === project) deps.openNextConflict?.();
        throw pendingConflictError(project);
      }
      deps.bumpRevision(project);
      project.updatedAt = deps.now();
      project._dirty = true;
      deps.saveRecovery?.(project);
      const merged = deps.mergeWorkspace(project);
      if (merged === false) {
        if (deps.isOnline() && project.slug) {
          await deps.saveWorkspaceOnly(project, { announce: false });
        }
        deps.saveCache();
        return null;
      }
      const active = deps.getActiveProject?.();
      if (active === project) deps.syncActiveEditor();
      deps.saveCache();
      if (!deps.isOnline()) return null;
      await ensureBackingBook(project);
      const saved = await persistProject(project, { silentStatus: active !== project });
      return saved.result;
    }

    return {
      flushCurrent: () => serialized(runCurrent),
      flushProject: (project) => serialized(() => runFixed(project)),
      isSaving: () => Boolean(inFlight),
      currentPromise: () => inFlight,
      async waitForIdle() {
        if (inFlight) await inFlight;
      },
    };
  }

  return {
    create,
    mergeWorkspaceChapter,
    canonicalFormJson,
    projectFormEqual,
    formTextEqual,
    formStringListEqual,
    formIdSetEqual,
    formGraphEqual,
    splitFormLines,
    buildExportMarkdown,
    applyProjectForm,
  };
})();
