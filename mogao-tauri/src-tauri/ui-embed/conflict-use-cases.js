/**
 * 保存冲突的纯用例模型。
 *
 * 不读取 DOM、网络或存储；控制器负责持久化队列和打开对话框。本模块只做
 * 身份匹配、去重、磁盘侧刷新和恢复副本水合，便于所有保存适配器复用。
 */
window.NOVEL_CONFLICT_USE_CASES = (() => {
  "use strict";

  function clonePlain(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  }

  function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/");
  }

  function belongsToProject(entry, project) {
    if (!entry || !project) return false;
    return entry.projectId === project.id || Boolean(entry.slug && entry.slug === project.slug);
  }

  function chapterMatches(chapter, entry) {
    if (!chapter || !entry) return false;
    const localId = entry.localChapter?.id;
    const diskId = entry.diskChapter?.id;
    const path = normalizePath(entry.warning?.path || entry.diskChapter?._file || "");
    const chapterPath = normalizePath(chapter._file || chapter.path || "");
    return Boolean(
      (localId && chapter.id === localId) ||
        (diskId && chapter.id === diskId) ||
        (path && chapterPath === path)
    );
  }

  function findLocalChapter(project, entry) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
    return chapters.find((chapter) => chapterMatches(chapter, entry));
  }

  function hasPending(entries, project) {
    return Boolean(project) && (Array.isArray(entries) ? entries : []).some((entry) => belongsToProject(entry, project));
  }

  function dropProject(entries, project, extraSlugs = []) {
    if (!project) return { entries: Array.isArray(entries) ? entries.slice() : [], removed: [], activeMatches: false };
    const slugs = new Set([project.slug, ...extraSlugs].filter(Boolean));
    const kept = [];
    const removed = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const matches = entry?.projectId === project.id || Boolean(entry?.slug && slugs.has(entry.slug));
      (matches ? removed : kept).push(entry);
    }
    return { entries: kept, removed };
  }

  function findMatchingChapter(chapters, entry) {
    return (
      (Array.isArray(chapters) ? chapters : []).find((chapter) => chapterMatches(chapter, entry)) ||
      (Array.isArray(chapters) ? chapters : []).find(
        (chapter) =>
          (entry?.diskChapter?.id && chapter.id === entry.diskChapter.id) ||
          (entry?.localChapter?.id && chapter.id === entry.localChapter.id)
      )
    );
  }

  function refreshDiskSides(entries, project, freshBook) {
    if (!project || !freshBook) return 0;
    const freshChapters = Array.isArray(freshBook.chapters) ? freshBook.chapters : [];
    let updated = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!belongsToProject(entry, project)) continue;
      const diskChapter = findMatchingChapter(freshChapters, entry);
      if (!diskChapter) continue;
      entry.diskChapter = clonePlain(diskChapter);
      updated += 1;
    }
    return updated;
  }

  function chapterIdentityMatch(local, disk) {
    if (!local || !disk) return false;
    if (disk.id && local.id === disk.id) return true;
    return Boolean(
      disk._file &&
        local._file &&
        normalizePath(local._file || local.path) === normalizePath(disk._file || disk.path)
    );
  }

  function enqueueDiverged(entries, project, freshBook, options = {}) {
    if (!project || !freshBook) return { added: 0, entries: Array.isArray(entries) ? entries : [] };
    const queue = Array.isArray(entries) ? entries : [];
    const localChapters = Array.isArray(project.chapters) ? project.chapters : [];
    const diskChapters = Array.isArray(freshBook.chapters) ? freshBook.chapters : [];
    const diverges = typeof options.diverges === "function" ? options.diverges : () => false;
    const now = typeof options.now === "function" ? options.now : Date.now;
    let added = 0;
    for (const diskChapter of diskChapters) {
      const localChapter = localChapters.find((chapter) => chapterIdentityMatch(chapter, diskChapter));
      if (!diverges(localChapter, diskChapter)) continue;
      const path = diskChapter._file || localChapter?._file || "";
      if (queue.some((entry) => entry.slug === project.slug && (entry.warning?.path || "") === path)) continue;
      queue.push({
        warning: { kind: "externalConflict", path, chapterId: diskChapter.id || localChapter?.id },
        localChapter: clonePlain(localChapter),
        diskChapter: clonePlain(diskChapter),
        projectId: project.id,
        slug: project.slug,
        detectedAt: now(),
        detectedRevision: options.detectedRevision,
      });
      added += 1;
    }
    return { added, entries: queue };
  }

  function hydrateProject(entries, project) {
    if (!project || project._stub) return { hydrated: 0, dirty: false };
    const chapters = Array.isArray(project.chapters) ? project.chapters : (project.chapters = []);
    let hydrated = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!belongsToProject(entry, project)) continue;
      entry.projectId = project.id;
      entry.slug = project.slug;
      const localSnapshot = clonePlain(entry.localChapter);
      if (!localSnapshot) continue;
      let chapter = chapters.find((item) => chapterMatches(item, entry));
      if (chapter) Object.assign(chapter, localSnapshot);
      else {
        chapter = localSnapshot;
        chapters.push(chapter);
      }
      entry.localChapter = chapter;
      hydrated += 1;
    }
    if (hydrated) project._dirty = true;
    return { hydrated, dirty: hydrated > 0 };
  }

  function filterExisting(entries, projects) {
    const list = Array.isArray(projects) ? projects : [];
    return (Array.isArray(entries) ? entries : []).filter((entry) =>
      list.some(
        (project) =>
          project &&
          (project.id === entry.projectId || Boolean(entry.slug && project.slug === entry.slug))
      )
    );
  }

  function relevantSaveWarnings(warnings) {
    return (Array.isArray(warnings) ? warnings : []).filter((warning) =>
      ["externalConflict", "preservedExternal"].includes(warning?.kind)
    );
  }

  /**
   * 保存冲突应用用例。队列状态留在实例内，网络、缓存、生产状态和 UI 刷新
   * 全部经 deps 端口注入；因此本模块可在内存端口上完整测试事务顺序。
   */
  function create(deps = {}) {
    let queue = [];
    let active = null;
    const projectsNeedSave = new Set();
    const projects = () => deps.getProjects?.() || [];
    const now = () => (deps.now ? deps.now() : Date.now());

    function list() {
      return queue;
    }

    function current() {
      return active;
    }

    function reset(entries = []) {
      queue = Array.isArray(entries) ? entries.slice() : [];
      active = null;
      projectsNeedSave.clear();
      persist();
      return queue.length;
    }

    function persist() {
      const saved = deps.savePending?.(queue);
      if (saved === false) {
        deps.setStatus?.("冲突恢复副本写入失败 · 请勿关闭应用", "err");
        return false;
      }
      return true;
    }

    function hasPendingProject(project) {
      return hasPending(queue, project);
    }

    function hydrate(project) {
      const result = hydrateProject(queue, project);
      if (result.hydrated) {
        deps.saveRecovery?.(project);
        deps.saveCache?.();
      }
      return result.hydrated;
    }

    function restore() {
      queue = filterExisting(deps.loadPending?.() || [], projects());
      active = null;
      projectsNeedSave.clear();
      for (const project of projects()) hydrate(project);
      persist();
      return queue.length;
    }

    function drop(project, extraSlugs = []) {
      if (!project) return 0;
      const result = dropProject(queue, project, extraSlugs);
      queue = result.entries;
      if (active && result.removed.includes(active)) {
        active = null;
        deps.hideConflictModal?.();
      }
      persist();
      return result.removed.length;
    }

    function removeSlug(slug) {
      if (!slug) return 0;
      const removed = queue.filter((entry) => entry.slug === slug);
      queue = queue.filter((entry) => entry.slug !== slug);
      if (active?.slug === slug) {
        active = null;
        deps.hideConflictModal?.();
      }
      persist();
      return removed.length;
    }

    function refresh(project, freshBook) {
      return refreshDiskSides(queue, project, freshBook);
    }

    function enqueueDivergedChapters(project, freshBook) {
      const result = enqueueDiverged(queue, project, freshBook, {
        diverges: deps.chapterBodiesDiverge,
        detectedRevision: deps.readRevision?.(project),
        now,
      });
      if (result.added) {
        project._dirty = true;
        deps.saveRecovery?.(project);
        persist();
        deps.saveCache?.();
      }
      return result.added;
    }

    function addReconciled(project, conflicts, submittedRevision) {
      let added = 0;
      for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
        const duplicate = queue.some(
          (entry) => entry.slug === project.slug && entry.warning?.path === conflict.warning?.path
        );
        if (duplicate) continue;
        queue.push({
          ...conflict,
          projectId: project.id,
          slug: project.slug,
          detectedAt: now(),
          detectedRevision: submittedRevision,
        });
        added += 1;
      }
      return added;
    }

    /** 同步关窗路径使用调用方提供的同步读取端口，模块自身不碰 XHR。 */
    function persistSync(project, warnings, saveRevision) {
      const relevant = relevantSaveWarnings(warnings);
      const conflicts = relevant.filter((warning) => warning.kind === "externalConflict");
      if (!project || !conflicts.length) return false;
      const diskProject = deps.loadDiskSync?.(project) || null;
      if (diskProject && typeof deps.reconcileSavedBook === "function") {
        const result = deps.reconcileSavedBook(project, diskProject, relevant) || { conflicts: [] };
        addReconciled(project, result.conflicts, saveRevision);
      } else {
        for (const warning of conflicts) {
          if (queue.some((entry) => entry.slug === project.slug && entry.warning?.path === warning.path)) continue;
          const path = normalizePath(warning.path);
          const localChapter = (project.chapters || []).find((chapter) => {
            const chapterPath = normalizePath(chapter._file || chapter.path);
            return (warning.chapterId && chapter.id === warning.chapterId) || (path && chapterPath === path);
          });
          queue.push({
            warning,
            localChapter: localChapter || null,
            diskChapter: null,
            projectId: project.id,
            slug: project.slug,
            detectedAt: now(),
            detectedRevision: saveRevision,
          });
        }
      }
      project._dirty = true;
      deps.saveRecovery?.(project);
      persist();
      return true;
    }

    function activateNext() {
      if (!active) active = queue[0] || null;
      if (!active) return null;
      const project = projects().find(
        (item) => item.id === active.projectId || item.slug === active.slug
      );
      const queued = active.localChapter;
      const live = findLocalChapter(project, active);
      const diskChapter = active.diskChapter || {};
      const localChapter =
        deps.pickLocalChapter?.(queued, live, diskChapter) || queued || live || null;
      return {
        entry: active,
        project,
        localChapter,
        diskChapter,
        position: Math.max(0, queue.indexOf(active)),
        count: queue.length,
      };
    }

    function closeActive({ keepPending = true } = {}) {
      if (!keepPending) active = null;
      return active;
    }

    async function reconcileWarnings(project, warnings, submittedRevision) {
      const relevant = relevantSaveWarnings(warnings);
      if (!relevant.length) return { added: 0, conflicts: 0 };
      let fresh;
      try {
        fresh = await deps.reloadBook(project.slug);
      } catch (error) {
        project._dirty = true;
        deps.saveRecovery?.(project);
        throw new Error(`磁盘已保护外部版本，但读取合并结果失败：${error.message || error}`, {
          cause: error,
        });
      }
      const result = deps.reconcileSavedBook?.(project, fresh, relevant) || {
        added: [],
        conflicts: [],
      };
      addReconciled(project, result.conflicts, submittedRevision);
      if ((result.added || []).length || (result.conflicts || []).length) {
        deps.saveCache?.();
        if (deps.getActiveProject?.() === project) deps.renderActive?.();
      }
      if ((result.conflicts || []).length) {
        project._dirty = true;
        deps.saveRecovery?.(project);
        deps.setActiveDirty?.(project);
        const recoverySaved = persist();
        deps.setStatus?.(
          recoverySaved
            ? `已保护磁盘新版 · 待处理 ${(result.conflicts || []).length} 个冲突`
            : "冲突仍在内存，但恢复副本写入失败 · 请立即处理且不要关闭应用",
          recoverySaved ? "warn" : "err"
        );
        if (deps.getActiveProject?.() === project) deps.openNextConflict?.();
      }
      return { added: (result.added || []).length, conflicts: (result.conflicts || []).length };
    }

    async function resolve(choice, options = {}) {
      const entry = active;
      if (!entry) return;
      const project = projects().find(
        (item) => item.id === entry.projectId || item.slug === entry.slug
      );
      if (!project) throw new Error("冲突对应的作品已不在当前书库中");
      const localChapter = findLocalChapter(project, entry);
      const diskChapter = clonePlain(entry.diskChapter || {});
      const chapters = Array.isArray(project.chapters) ? project.chapters : (project.chapters = []);
      const index = localChapter ? chapters.indexOf(localChapter) : -1;
      const changedSinceDetection =
        entry.detectedRevision == null || !deps.revisionMatches?.(project, entry.detectedRevision);

      if (choice === "disk") {
        if (index >= 0) chapters[index] = diskChapter;
        else chapters.push(diskChapter);
        const diskTask = (project.tasks || []).find((task) => task.id === diskChapter.taskId);
        deps.reconcileProductionChapter?.(diskChapter, diskTask);
        deps.alignAfterBodyMutation?.(diskTask, diskChapter, diskChapter.handoffError);
        if (changedSinceDetection) projectsNeedSave.add(project.id);
      } else {
        if (!localChapter) throw new Error("内存版本不存在，不能覆盖磁盘");
        const previousBody = String(localChapter.body || "");
        const body = choice === "merge" ? String(options.mergeBody || "") : localChapter.body || "";
        localChapter.body = body;
        localChapter.updatedAt = now();
        localChapter._file = diskChapter._file || localChapter._file;
        localChapter._fileMtime = diskChapter._fileMtime || localChapter._fileMtime || 0;
        localChapter._fileRevision = diskChapter._fileRevision;
        localChapter._bodyLoaded = true;
        const linkedTask = (project.tasks || []).find((task) => task.id === localChapter.taskId);
        const reason =
          choice === "merge"
            ? "手工合并后等待重新通过叙事质量闸门"
            : "覆盖外部版本后等待重新交接";
        if (String(body) !== previousBody) {
          deps.invalidateAfterAuthorEdit?.(localChapter, linkedTask, reason);
        } else {
          deps.markHandoffStale?.(localChapter, linkedTask, reason);
        }
        projectsNeedSave.add(project.id);
      }

      queue = queue.filter((item) => item !== entry);
      active = null;
      deps.hideConflictModal?.();
      if (!persist()) throw new Error("冲突选择已应用，但剩余冲突的恢复副本写入失败");
      deps.saveCache?.();
      if (deps.getActiveProject?.() === project) deps.renderAllActive?.();

      if (!hasPendingProject(project)) {
        if (projectsNeedSave.has(project.id)) {
          projectsNeedSave.delete(project.id);
          project._dirty = true;
          deps.saveRecovery?.(project);
          await deps.flushProject?.(project);
        } else {
          project._dirty = false;
          deps.clearRecovery?.(project);
          deps.recomputeDirty?.();
          deps.saveCache?.();
          deps.setStatus?.(`已采用磁盘新版 · ${project.slug}`, "ok");
        }
      }
      if (queue.length) deps.openNextConflict?.();
    }

    return {
      list,
      current,
      reset,
      persist,
      restore,
      hydrate,
      drop,
      removeSlug,
      refresh,
      enqueueDiverged: enqueueDivergedChapters,
      hasPending: hasPendingProject,
      persistSync,
      activateNext,
      closeActive,
      reconcileWarnings,
      resolve,
    };
  }

  return {
    clonePlain,
    normalizePath,
    belongsToProject,
    chapterMatches,
    findLocalChapter,
    hasPending,
    dropProject,
    refreshDiskSides,
    enqueueDiverged,
    hydrateProject,
    filterExisting,
    relevantSaveWarnings,
    create,
  };
})();
