/** 本地书库客户端 —— 对接 /api/*（Mogao 本地服务） */
window.NOVEL_VAULT = (() => {
  const BASE = ""; // same origin

  /** 启动时从 URL ?token= 读取（Tauri 注入）；读入后从地址栏剥离，避免长期暴露 */
  (function initMogaoToken() {
    try {
      const params = new URLSearchParams(location.search || "");
      const t = String(params.get("token") || "").trim();
      if (t) {
        window.__MOGAO_TOKEN = t;
        params.delete("token");
        const q = params.toString();
        const next =
          location.pathname + (q ? "?" + q : "") + (location.hash || "");
        try {
          history.replaceState(null, "", next);
        } catch (_) {}
      }
    } catch (_) {}
  })();

  function getToken() {
    return String(window.__MOGAO_TOKEN || "").trim();
  }

  /** 给 headers 对象附加 X-Mogao-Token（有 token 才加） */
  function applyAuthHeaders(headers) {
    const h = headers && typeof headers === "object" ? headers : {};
    const t = getToken();
    if (t) h["X-Mogao-Token"] = t;
    return h;
  }

  async function req(method, path, body) {
    const opts = { method, headers: applyAuthHeaders({}) };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || text || res.statusText;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** POST /api/preview/markdown → { html } 或纯 HTML 字符串 */
  async function previewMarkdown(content) {
    const data = await req("POST", "/api/preview/markdown", { content: String(content || "") });
    if (typeof data === "string") return data;
    if (data?.html != null) return String(data.html);
    if (data?.raw != null) return String(data.raw);
    return "";
  }

  async function health() {
    try {
      return await req("GET", "/api/health");
    } catch (e) {
      return null;
    }
  }

  /** GET /api/settings → { vaultPath, version, booksPath, clientCfg, uiState } */
  async function settings() {
    return req("GET", "/api/settings");
  }

  /**
   * PUT /api/settings — 持久化 clientCfg / uiState 到 mogao-settings.json
   * @param {{ clientCfg?: object, uiState?: object, replaceClientCfg?: boolean }} body
   */
  async function putSettings(body) {
    return req("PUT", "/api/settings", body || {});
  }

  /**
   * POST /api/vault/open { path, force? }
   * force=true：允许把 Unknown 目录 ensure 成 vault
   * 结构化拒绝（bookDir / unknown）不抛错，直接返回 body 供 UI 处理
   */
  async function openVault(path, force) {
    const body = { path: String(path || "") };
    if (force) body.force = true;
    try {
      return await req("POST", "/api/vault/open", body);
    } catch (e) {
      const data = e?.data;
      if (data && typeof data === "object" && (data.kind != null || data.requireConfirm != null || data.ok === false)) {
        return data;
      }
      throw e;
    }
  }

  /** POST /api/vault/create { path, name? } */
  async function createVault(path, name) {
    const body = { path };
    if (name) body.name = name;
    return req("POST", "/api/vault/create", body);
  }

  async function library() {
    return req("GET", "/api/library");
  }

  async function loadBook(slug) {
    return req("GET", `/api/books/${encodeURIComponent(slug)}`);
  }

  function prepareProjectForSave(project) {
    const payload = { ...(project || {}) };
    const serialized = window.NOVEL_RAG?.serializeIndex?.(project?.ragIndex);
    if (serialized) payload.ragIndex = serialized;
    else delete payload.ragIndex;
    delete payload._lastRag;
    delete payload._lastContextManifest;
    delete payload._saveWarnings;
    return payload;
  }

  function normalizeChapterFile(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  }

  function chapterMatchesWarning(chapter, warningPath) {
    const expected = normalizeChapterFile(warningPath);
    const actual = normalizeChapterFile(chapter?._file || chapter?.path);
    if (expected && actual) return expected === actual;
    return false;
  }

  /**
   * 将后端保存警告映射回可展示的章节对象。
   * - preservedExternal：安全补入本地缺失的磁盘章节；
   * - externalConflict：不替用户做覆盖决定，只返回本地/磁盘双版本。
   * 该函数不替换已有正文，便于保存层在 UI 中显式解决冲突。
   */
  function reconcileSavedBook(localProject, diskProject, warnings) {
    const local = localProject && typeof localProject === "object" ? localProject : {};
    const disk = diskProject && typeof diskProject === "object" ? diskProject : {};
    local.chapters = Array.isArray(local.chapters) ? local.chapters : [];
    const diskChapters = Array.isArray(disk.chapters) ? disk.chapters : [];
    const rows = Array.isArray(warnings) ? warnings : [];
    const added = [];
    const conflicts = [];

    const findLocal = (diskChapter, warning) =>
      local.chapters.find(
        (chapter) =>
          (diskChapter?.id && chapter?.id === diskChapter.id) ||
          chapterMatchesWarning(chapter, warning?.path) ||
          (diskChapter?._file && normalizeChapterFile(chapter?._file) === normalizeChapterFile(diskChapter._file))
      );

    for (const warning of rows) {
      if (!warning || !["externalConflict", "preservedExternal"].includes(warning.kind)) continue;
      const diskChapter = diskChapters.find(
        (chapter) =>
          chapterMatchesWarning(chapter, warning.path) ||
          (warning.chapterId && chapter?.id === warning.chapterId)
      );
      if (!diskChapter) continue;
      const localChapter = findLocal(diskChapter, warning);
      if (warning.kind === "preservedExternal") {
        if (!localChapter) {
          const clone = JSON.parse(JSON.stringify(diskChapter));
          local.chapters.push(clone);
          added.push(clone);
        }
        continue;
      }
      conflicts.push({
        warning: { ...warning },
        localChapter: localChapter || null,
        diskChapter: JSON.parse(JSON.stringify(diskChapter)),
      });
    }

    if (added.length) {
      local.chapters.sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
    }
    return { added, conflicts };
  }

  /**
   * 保存成功后把每章的乐观并发基线换成服务端刚写盘的 mtime。
   *
   * 保存本身会重写章节文件，磁盘 mtime 随之变新。基线不跟着走的话，同一次会话里
   * 第二次改同一章就会被后端判成「外部修改」：作者看到一个根本不存在的磁盘冲突，
   * 正文也存不进去。
   * 冲突章与被保留的磁盘章一律不换基线——那些磁盘版本还等着作者裁决，
   * 换了基线下一次保存就会静默盖掉。
   */
  function adoptChapterBaselines(project, saved, warnings) {
    const chapters = Array.isArray(project?.chapters) ? project.chapters : [];
    const rows = Array.isArray(saved?.chapterBaselines) ? saved.chapterBaselines : [];
    if (!chapters.length || !rows.length) return 0;
    const blocked = new Set(
      (Array.isArray(warnings) ? warnings : [])
        .map((warning) => normalizeChapterFile(warning?.path))
        .filter(Boolean)
    );
    let adopted = 0;
    for (const row of rows) {
      const file = normalizeChapterFile(row?.file);
      const mtime = Number(row?.mtime) || 0;
      if (!file || !mtime || blocked.has(file)) continue;
      const chapter = chapters.find(
        (item) =>
          (row?.id && item?.id === row.id) ||
          (item?._file && normalizeChapterFile(item._file) === file)
      );
      if (!chapter) continue;
      chapter._file = row.file;
      chapter._fileMtime = mtime;
      adopted += 1;
    }
    return adopted;
  }

  /**
   * 磁盘整本替换内存的闸门。全部 flag 为假才允许静默采纳。
   * 误判「脏」只会跳过重载（安全）；误判「干净」才会丢稿。
   *
   * @param {{
   *   generating?: boolean,
   *   dirty?: boolean,
   *   pendingConflict?: boolean,
   *   editorDesynced?: boolean,
   *   workspaceChapterDirty?: boolean,
   *   saveInFlight?: boolean
   * }} flags
   * @returns {{ ok: boolean, code: string, reason: string }}
   */
  function classifyDiskAdopt(flags) {
    const row = flags && typeof flags === "object" ? flags : {};
    const blockers = [
      ["generating", "generating", "生成中，写章台正文未从磁盘覆盖"],
      ["saveInFlight", "saveInFlight", "正在存盘，未从磁盘覆盖内存"],
      ["pendingConflict", "conflict", "有待裁决的保存冲突，未从磁盘覆盖内存"],
      ["dirty", "dirty", "写章台未存盘正文仍保留，未从磁盘覆盖"],
      ["editorDesynced", "editorDesynced", "编辑器与内存正文不一致，未从磁盘覆盖"],
      ["workspaceChapterDirty", "workspaceDirty", "资料区章节文件未保存，未从磁盘覆盖写章台"],
    ];
    for (const [flag, code, reason] of blockers) {
      if (row[flag]) return { ok: false, code, reason };
    }
    return { ok: true, code: "ok", reason: "" };
  }

  /**
   * 冲突弹窗「我的版本」用哪一份正文。
   * 内存章若已经被磁盘顶成同一份，仍展示入队时的作者快照。
   */
  function pickLocalChapterForConflictDisplay(queued, live, diskChapter) {
    if (!queued) return live || null;
    if (!live) return queued;
    const diskBody = String(diskChapter?.body || "");
    const liveBody = String(live.body || "");
    const queuedBody = String(queued.body || "");
    if (liveBody === diskBody && queuedBody !== diskBody) return queued;
    return live;
  }

  function chapterBodiesDiverge(localCh, diskCh) {
    if (!localCh || !diskCh) return false;
    return String(localCh.body || "") !== String(diskCh.body || "");
  }

  /**
   * 重命名等「磁盘改了元数据、内存正文仍是作者的」路径：
   * 只抄 _path/_mtime/_file/_fileMtime，绝不抄 body。
   */
  function adoptDiskConcurrencyMeta(localProject, diskProject) {
    if (!localProject || !diskProject) return 0;
    if (diskProject._path) localProject._path = diskProject._path;
    if (diskProject._mtime) localProject._mtime = diskProject._mtime;
    const locals = Array.isArray(localProject.chapters) ? localProject.chapters : [];
    const disks = Array.isArray(diskProject.chapters) ? diskProject.chapters : [];
    let adopted = 0;
    for (const local of locals) {
      const disk = disks.find(
        (item) =>
          (local?.id && item?.id === local.id) ||
          (local?._file &&
            item?._file &&
            normalizeChapterFile(local._file) === normalizeChapterFile(item._file))
      );
      if (!disk) continue;
      if (disk._file) local._file = disk._file;
      if (disk._fileMtime) local._fileMtime = disk._fileMtime;
      adopted += 1;
    }
    return adopted;
  }

  async function saveBook(slug, project) {
    return req("PUT", `/api/books/${encodeURIComponent(slug)}`, prepareProjectForSave(project));
  }

  async function createBook(title, idea) {
    return req("POST", "/api/books", { title, idea });
  }

  async function deleteBook(slug) {
    return req("DELETE", `/api/books/${encodeURIComponent(slug)}`);
  }

  async function reloadBook(slug) {
    return req("POST", `/api/books/${encodeURIComponent(slug)}/reload`, {});
  }

  async function reveal(path) {
    // 桌面客户端优先走原生桥（更稳的聚焦）
    try {
      if (window.pywebview?.api?.reveal) {
        return await window.pywebview.api.reveal(path || "");
      }
    } catch (_) {}
    return req("POST", "/api/reveal", { path });
  }

  async function revealBook(slug) {
    try {
      if (window.pywebview?.api?.reveal) {
        // 先问服务端书路径，再原生打开
        const book = await loadBook(slug);
        const path = book?._path || "";
        // 服务端 load 不带 path 时，用约定相对拼不了绝对路径 → 仍走 HTTP
        if (path) return await window.pywebview.api.reveal(path);
      }
    } catch (_) {}
    return req("POST", `/api/books/${encodeURIComponent(slug)}/reveal`, {});
  }

  async function migrate(projects) {
    return req("POST", "/api/migrate", { projects });
  }

  async function rescan() {
    return req("POST", "/api/library/rescan", {});
  }

  async function meta(slug) {
    return req("GET", `/api/books/${encodeURIComponent(slug)}/meta`);
  }

  /**
   * 重命名书目
   * @param {string} slug
   * @param {string|{ title: string, renameFolder?: boolean }} titleOrOpts
   *   传字符串时仅改标题；传对象可带 renameFolder 同步改文件夹 slug
   */
  async function renameBook(slug, titleOrOpts) {
    const body =
      typeof titleOrOpts === "string" || titleOrOpts == null
        ? { title: String(titleOrOpts || "") }
        : {
            title: String(titleOrOpts.title || ""),
            ...(titleOrOpts.renameFolder != null
              ? { renameFolder: !!titleOrOpts.renameFolder }
              : {}),
          };
    return req("POST", `/api/books/${encodeURIComponent(slug)}/rename`, body);
  }

  /** POST /api/vault/import-book { path } — 将单书目录导入当前 vault */
  async function importBook(path) {
    return req("POST", "/api/vault/import-book", { path: String(path || "") });
  }

  /** GET /api/search?q=&limit= — 跨书轻量搜索 */
  async function search(q, limit) {
    const query = String(q || "").trim();
    if (!query) return { hits: [] };
    const lim = limit != null ? Number(limit) : 50;
    const qs = `q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(lim || 50))}`;
    return req("GET", `/api/search?${qs}`);
  }

  async function snapshot(slug, reason) {
    return req("POST", `/api/books/${encodeURIComponent(slug)}/snapshot`, { reason: reason || "manual" });
  }

  async function listSnapshots(slug) {
    return req("GET", `/api/books/${encodeURIComponent(slug)}/snapshots`);
  }

  async function restoreSnapshot(slug, id) {
    return req("POST", `/api/books/${encodeURIComponent(slug)}/restore`, { id });
  }

  async function fileTree(slug) {
    return req("GET", `/api/books/${encodeURIComponent(slug)}/tree`);
  }

  async function fileWatch(slug) {
    return req("GET", `/api/books/${encodeURIComponent(slug)}/watch`);
  }

  async function readFile(slug, filePath) {
    const q = encodeURIComponent(filePath);
    return req("GET", `/api/books/${encodeURIComponent(slug)}/file?path=${q}`);
  }

  async function writeFile(slug, filePath, content) {
    return req("PUT", `/api/books/${encodeURIComponent(slug)}/file`, {
      path: filePath,
      content,
    });
  }

  /** POST /api/books/{slug}/fs/mkdir { path } */
  async function fsMkdir(slug, path) {
    return req("POST", `/api/books/${encodeURIComponent(slug)}/fs/mkdir`, { path });
  }

  /** POST /api/books/{slug}/fs/create { path, content? } */
  async function fsCreate(slug, path, content) {
    const body = { path };
    if (content !== undefined) body.content = content;
    return req("POST", `/api/books/${encodeURIComponent(slug)}/fs/create`, body);
  }

  /** POST /api/books/{slug}/fs/rename { from, to } */
  async function fsRename(slug, from, to) {
    return req("POST", `/api/books/${encodeURIComponent(slug)}/fs/rename`, { from, to });
  }

  /** DELETE /api/books/{slug}/fs?path= */
  async function fsDelete(slug, path) {
    const q = encodeURIComponent(path);
    return req("DELETE", `/api/books/${encodeURIComponent(slug)}/fs?path=${q}`);
  }

  return {
    req,
    getToken,
    applyAuthHeaders,
    health,
    settings,
    putSettings,
    openVault,
    createVault,
    library,
    loadBook,
    saveBook,
    prepareProjectForSave,
    reconcileSavedBook,
    adoptChapterBaselines,
    classifyDiskAdopt,
    pickLocalChapterForConflictDisplay,
    chapterBodiesDiverge,
    adoptDiskConcurrencyMeta,
    createBook,
    deleteBook,
    reloadBook,
    reveal,
    revealBook,
    migrate,
    rescan,
    meta,
    renameBook,
    importBook,
    search,
    snapshot,
    listSnapshots,
    restoreSnapshot,
    fileTree,
    fileWatch,
    readFile,
    writeFile,
    fsMkdir,
    fsCreate,
    fsRename,
    fsDelete,
    previewMarkdown,
  };
})();
