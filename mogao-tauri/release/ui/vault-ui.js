/**
 * 墨稿 · 书库 UI（开库/建库/导入/筛选/跨书搜索）
 * 从 app.js 抽出，减少主文件行数。
 * 用法：NOVEL_VAULT_UI.init({ ...deps })
 */
window.NOVEL_VAULT_UI = (() => {
  "use strict";

  /** @type {Record<string, any>} */
  let D = {};

  const $ = (id) => (D.$ ? D.$(id) : document.getElementById(id));
  const Vault = () => D.Vault || window.NOVEL_VAULT;
  const Store = () => D.Store || window.NOVEL_STORE;
  const Ws = () => D.Ws || window.NOVEL_WORKSPACE;

  /** 开/建库结果是否成功（取消、ok:false、error 均不算成功） */
  function isVaultOpOk(res) {
    return !!(res && res.ok !== false && !res.cancelled && !res.error);
  }

  function setVaultStatus(text, kind) {
    if (typeof D.setVaultStatus === "function") return D.setVaultStatus(text, kind);
    const el = $("vaultStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "vault-status" + (kind ? ` ${kind}` : "");
  }

  function updateVaultPathUI() {
    if (typeof D.updateVaultPathUI === "function") D.updateVaultPathUI();
  }

  function getVaultPath() {
    return typeof D.getVaultPath === "function" ? D.getVaultPath() : "";
  }

  function setVaultPath(p) {
    if (typeof D.setVaultPath === "function") D.setVaultPath(p || "");
  }

  function isVaultOnline() {
    return typeof D.isVaultOnline === "function" ? !!D.isVaultOnline() : false;
  }

  function setVaultOnline(v) {
    if (typeof D.setVaultOnline === "function") D.setVaultOnline(!!v);
  }

  function isTauri() {
    if (typeof D.isTauri === "function") return D.isTauri();
    return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  }

  async function tauriInvoke(cmd, args) {
    if (typeof D.tauriInvoke === "function") return D.tauriInvoke(cmd, args);
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

  /** 复制文本到剪贴板（Clipboard API + execCommand 回退） */
  async function copyTextToClipboard(text) {
    const t = String(text || "");
    if (!t) throw new Error("无可复制内容");
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(t);
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
    if (!ok) throw new Error("复制失败");
    return true;
  }

  async function copyVaultPath() {
    const path = getVaultPath() || "";
    if (!path) {
      setVaultStatus("无书库路径可复制", "warn");
      return alert("当前没有可用的书库绝对路径");
    }
    try {
      await copyTextToClipboard(path);
      setVaultStatus("已复制", "ok");
      const el = $("wsStatus");
      if (el) {
        el.textContent = "已复制";
        el.className = "ws-status ok";
      }
    } catch (e) {
      setVaultStatus("复制失败", "err");
      alert("复制失败: " + (e.message || e));
    }
  }

  /**
   * 导入成功：刷新书库并选中新书（不强制 afterVaultSwitch）
   * 期望 { ok, slug, vaultPath, library }
   */
  async function applyImportSuccess(imported) {
    if (imported?.vaultPath) setVaultPath(imported.vaultPath);
    else if (imported?.path && imported?.slug && imported?.library) {
      /* path 可能是书路径，仅当带 library 时视为 vault 上下文 */
    }
    if (imported?.vaultPath) setVaultOnline(true);

    // 若返回了 library 快照，先喂给 app 再 refresh 校正
    if (imported?.library && typeof D.applyLibrarySnapshot === "function") {
      try {
        D.applyLibrarySnapshot(imported.library);
      } catch (e) {
        console.warn("applyLibrarySnapshot", e);
      }
    }

    if (typeof D.refreshLibraryFromServer === "function") {
      try {
        await D.refreshLibraryFromServer();
      } catch (e) {
        console.warn("refresh after import", e);
      }
    }

    const slug = imported?.slug;
    if (slug && typeof D.switchToSlug === "function") {
      try {
        await D.switchToSlug(slug);
      } catch (e) {
        console.warn("switchToSlug after import", e);
        if (typeof D.renderAll === "function") D.renderAll();
      }
    } else if (typeof D.renderAll === "function") {
      D.renderAll();
    }

    const title = imported?.title || slug || "";
    setVaultStatus(`已导入 · ${slug || ""}`, "ok");
    alert(`已导入为书目：${title || slug || "（未知）"}`);
    return true;
  }

  /**
   * 处理选中「单书目录」而非 vault 根的情况：提示并可选导入
   * @returns {Promise<boolean>}
   */
  async function handleBookDirResult(res) {
    const path =
      res?.path || res?.bookPath || res?.suggestionPath || res?.suggestion || "";
    const hint =
      res?.message ||
      res?.suggestion ||
      "所选路径看起来是「单书目录」（含 章节/ 或 book.json），不是书库根目录（应含 books/ 或 library.json）。";
    const pathLine = path ? `\n路径：${path}` : "";
    const canTryImport = !!(path && typeof Vault().importBook === "function");

    if (canTryImport) {
      const ok = confirm(
        `${hint}${pathLine}\n\n是否将该目录导入为当前书库中的一本书？`
      );
      if (!ok) {
        alert(
          "请改选书库根目录（含 books/ 或 library.json）。\n" +
            "若要导入单书：先打开正确书库，再选择该单书目录导入。"
        );
        setVaultStatus("已取消（单书目录）", "warn");
        return false;
      }
      try {
        setVaultStatus("导入单书…", "busy");
        const imported = await Vault().importBook(path);
        if (!isVaultOpOk(imported)) {
          const msg = imported?.error || imported?.message || "导入失败";
          setVaultStatus(String(msg), "err");
          alert(String(msg));
          return false;
        }
        return await applyImportSuccess(imported);
      } catch (e) {
        setVaultStatus("导入失败", "err");
        alert(
          "导入失败: " +
            (e.message || e) +
            "\n\n请先打开/创建书库根目录，再将单书目录复制到 books/<书名>/。"
        );
        return false;
      }
    }

    alert(
      `${hint}${pathLine}\n\n` +
        "请改选书库根目录（含 books/ 或 library.json）。\n" +
        "导入单书：打开正确书库后，将目录放到 books/<书名>/ 下，再点「重新扫描」。"
    );
    setVaultStatus("路径类型不正确（单书目录）", "warn");
    return false;
  }

  /**
   * Unknown 目录：确认后 force open
   */
  async function handleUnknownVault(res) {
    const path =
      res?.path || res?.vaultPath || res?.suggestionPath || res?.suggestion || "";
    const msg =
      res?.message ||
      "该目录不是标准书库，强制打开将在此创建 books/ 结构，确定？";
    if (!path) {
      setVaultStatus("路径未知，无法强制打开", "err");
      alert(msg);
      return false;
    }
    if (!confirm(`${msg}\n\n路径：${path}`)) {
      setVaultStatus("已取消（非标准书库）", "warn");
      return false;
    }
    try {
      setVaultStatus("强制打开书库…", "busy");
      const forced = await Vault().openVault(path, true);
      return await applyVaultOpResult(forced || { ok: true, vaultPath: path }, {
        successAlert: () => `已强制打开书库\n${getVaultPath() || path}`,
      });
    } catch (e) {
      setVaultStatus("强制打开失败", "err");
      alert("强制打开失败: " + (e.message || e));
      return false;
    }
  }

  /**
   * 统一处理 pick/open/create 返回值；成功才 afterVaultSwitch
   * @returns {Promise<boolean>}
   */
  async function applyVaultOpResult(res, { successAlert } = {}) {
    if (!res || res.cancelled) return false;
    const kind = String(res.kind || "").toLowerCase();
    if (kind === "bookdir") {
      return handleBookDirResult(res);
    }
    if (kind === "unknown" && (res.requireConfirm || res.require_confirm)) {
      return handleUnknownVault(res);
    }
    // 部分后端把 unknown 放在 ok:false 且无 kind 大小写变体
    if (
      !isVaultOpOk(res) &&
      (kind === "unknown" || res.requireConfirm || res.require_confirm)
    ) {
      return handleUnknownVault(res);
    }
    if (!isVaultOpOk(res)) {
      const msg = res.error || res.message || "书库操作失败";
      setVaultStatus(String(msg), "err");
      alert(String(msg));
      return false;
    }
    await afterVaultSwitch(res);
    if (successAlert) alert(successAlert(res));
    return true;
  }

  /** 开/建库后清空状态并重新 boot 书库 */
  async function afterVaultSwitch(res) {
    if (typeof D.afterVaultSwitch === "function") {
      return D.afterVaultSwitch(res);
    }
    // 内置实现（依赖 init 注入）
    if (res?.vaultPath) setVaultPath(res.vaultPath);
    else if (res?.path) setVaultPath(res.path);
    else if (res?.vault) setVaultPath(res.vault);
    setVaultOnline(true);

    if (typeof D.resetForVaultSwitch === "function") {
      D.resetForVaultSwitch(res);
    }

    updateVaultPathUI();
    setVaultStatus("切换书库…", "busy");

    const bootFromVault = D.bootFromVault;
    let ok = false;
    if (typeof bootFromVault === "function") {
      ok = await bootFromVault(true);
    }

    // force 空库可能 ok=true 但 projects 为空；始终补建
    const count =
      typeof D.getProjectCount === "function"
        ? D.getProjectCount()
        : D.getState?.()?.projects?.length || 0;
    if ((!ok || !count) && typeof D.ensureEmptyVaultBook === "function") {
      await D.ensureEmptyVaultBook();
    }

    if (typeof D.refreshLibraryFromServer === "function") {
      await D.refreshLibraryFromServer();
    }
    updateVaultPathUI();
    if (typeof D.renderAll === "function") D.renderAll();
    if (typeof D.loadPipelineView === "function") D.loadPipelineView();
    if (typeof D.loadControlView === "function") D.loadControlView();
    if (typeof D.loadWriteView === "function") D.loadWriteView();
    if (typeof D.loadGraphView === "function") D.loadGraphView();

    const cur = typeof D.project === "function" ? D.project() : null;
    if (cur?.slug) {
      try {
        if (typeof D.syncDiskMtime === "function") await D.syncDiskMtime(cur.slug);
      } catch (_) {}
      Ws()?.bindBook?.(cur.slug, { autoOpen: true });
    } else {
      Ws()?.bindBook?.("", { autoOpen: false });
    }

    const n =
      (typeof D.getProjectCount === "function" ? D.getProjectCount() : null) ??
      (typeof D.getState === "function" ? D.getState()?.projects?.length : 0) ??
      0;
    setVaultStatus(`书库 · ${n} 部`, "ok");
  }

  async function pickOpenVault() {
    if (!isVaultOnline() && !isTauri()) {
      return alert("本地服务未连接，无法打开书库");
    }
    if (typeof D.prepareVaultSwitch === "function" && !(await D.prepareVaultSwitch())) {
      return false;
    }
    if (isTauri()) {
      try {
        setVaultStatus("请选择书库文件夹…", "busy");
        const res = await tauriInvoke("pick_and_open_vault");
        if (res != null) {
          if (res.cancelled) {
            setVaultStatus("已取消选择", "warn");
            return;
          }
          await applyVaultOpResult(res, {
            successAlert: () => `已打开书库\n${getVaultPath() || res.vaultPath || ""}`,
          });
          return;
        }
        // invoke 返回 null：原生桥不可用
        setVaultStatus("原生选夹不可用，改用路径输入", "warn");
      } catch (e) {
        console.warn("pick_and_open_vault", e);
        setVaultStatus("选夹失败，改用路径输入", "warn");
        // fall through to prompt
      }
    }
    let path = prompt("请输入要打开的书库绝对路径", getVaultPath() || "");
    if (path === null) return;
    path = String(path).trim();
    if (!path) return alert("路径不能为空");
    try {
      setVaultStatus("打开书库…", "busy");
      const res = await Vault().openVault(path);
      await applyVaultOpResult(res || { ok: true, vaultPath: path }, {
        successAlert: () => `已打开书库\n${getVaultPath() || path}`,
      });
    } catch (e) {
      const data = e?.data;
      if (data && typeof data === "object") {
        const kind = String(data.kind || "").toLowerCase();
        if (kind === "bookdir") {
          await handleBookDirResult(data);
          return;
        }
        if (kind === "unknown" || data.requireConfirm || data.require_confirm) {
          await handleUnknownVault({ ...data, path: data.path || path });
          return;
        }
      }
      setVaultStatus("打开书库失败", "err");
      alert("打开书库失败: " + (e.message || e));
    }
  }

  async function pickCreateVault() {
    if (!isVaultOnline() && !isTauri()) {
      return alert("本地服务未连接，无法新建书库");
    }
    if (typeof D.prepareVaultSwitch === "function" && !(await D.prepareVaultSwitch())) {
      return false;
    }
    if (isTauri()) {
      try {
        setVaultStatus("请选择新建书库的父目录…", "busy");
        const res = await tauriInvoke("pick_and_create_vault");
        if (res != null) {
          if (res.cancelled) {
            setVaultStatus("已取消选择", "warn");
            return;
          }
          await applyVaultOpResult(res, {
            successAlert: () => `已新建书库\n${getVaultPath() || res.vaultPath || ""}`,
          });
          return;
        }
      } catch (e) {
        console.warn("pick_and_create_vault", e);
      }
    }
    const path = prompt("请输入新建书库的父目录绝对路径", getVaultPath() || "");
    if (path === null) return;
    const trimmed = String(path).trim();
    if (!trimmed) return alert("路径不能为空");
    const name = prompt("书库文件夹名（可选，留空则直接用上面路径）", "mogao-vault");
    if (name === null) return;
    try {
      setVaultStatus("新建书库…", "busy");
      const res = await Vault().createVault(trimmed, String(name).trim() || undefined);
      await applyVaultOpResult(res || { ok: true, vaultPath: trimmed }, {
        successAlert: () => `已新建书库\n${getVaultPath() || trimmed}`,
      });
    } catch (e) {
      setVaultStatus("新建书库失败", "err");
      alert("新建书库失败: " + (e.message || e));
    }
  }

  // —— 跨书搜索 UI ——
  let searchTimer = null;
  let searchSeq = 0;

  function hideSearchHits() {
    const panel = $("searchHits");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  function escapeHtml(t) {
    return String(t || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const SEARCH_GROUPS = Object.freeze([
    { id: "chapter", label: "正文" },
    { id: "character", label: "人物" },
    { id: "canon", label: "Canon" },
    { id: "loop", label: "伏笔" },
    { id: "other", label: "其他文件" },
  ]);

  function searchGroupForHit(hit) {
    const explicit = String(hit?.group || "").toLowerCase();
    if (SEARCH_GROUPS.some((group) => group.id === explicit)) return explicit;
    const path = String(hit?.path || "").replace(/\\/g, "/").toLowerCase();
    if (path.startsWith("章节/")) return "chapter";
    if (path.startsWith("关系/") || /entity-states|timeline-events|人物/.test(path)) return "character";
    if (/canon|细节设定|设定|锁定/.test(path)) return "canon";
    if (/plot-loops|foreshadow|伏笔|钩子/.test(path)) return "loop";
    return "other";
  }

  function groupSearchHits(hits) {
    const grouped = new Map(SEARCH_GROUPS.map((group) => [group.id, []]));
    for (const hit of Array.isArray(hits) ? hits : []) {
      grouped.get(searchGroupForHit(hit)).push(hit);
    }
    return SEARCH_GROUPS.map((group) => ({ ...group, hits: grouped.get(group.id) })).filter(
      (group) => group.hits.length
    );
  }

  function createSearchHitButton(hit) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-hit";
    const title = hit.title || hit.bookTitle || hit.slug || "（无标题）";
    const path = hit.path || "";
    const snippet = hit.snippet || hit.preview || "";
    btn.innerHTML = `
      <span class="search-hit-title">${escapeHtml(title)}</span>
      <span class="search-hit-meta">${escapeHtml(hit.slug || "")}${path ? " · " + escapeHtml(path) : ""}</span>
      ${snippet ? `<span class="search-hit-snip">${escapeHtml(snippet)}</span>` : ""}
    `;
    btn.addEventListener("click", async () => {
      hideSearchHits();
      const input = $("vaultSearch");
      if (input) input.value = "";
      const slug = hit.slug;
      if (slug && typeof D.switchToSlug === "function") await D.switchToSlug(slug);
      if (path && Ws()?.openFile) {
        if (typeof D.switchMode === "function") {
          try {
            await D.switchMode("workspace");
          } catch (_) {}
        }
        try {
          await Ws().openFile(path);
        } catch (e) {
          const msg = e?.message || String(e) || "打开文件失败";
          setVaultStatus(`打开失败 · ${path}：${msg}`, "err");
          alert(`打开文件失败：${msg}\n路径：${path}`);
        }
      }
    });
    return btn;
  }

  async function runVaultSearch(q) {
    const panel = $("searchHits");
    if (!panel) return;
    const query = String(q || "").trim();
    if (!query) {
      hideSearchHits();
      return;
    }
    if (!isVaultOnline()) {
      panel.hidden = false;
      panel.innerHTML = `<div class="search-hit-empty">书库未连接</div>`;
      return;
    }
    const seq = ++searchSeq;
    panel.hidden = false;
    panel.innerHTML = `<div class="search-hit-empty">搜索中…</div>`;
    try {
      const res = await Vault().search(query, 50);
      if (seq !== searchSeq) return;
      const hits = res?.hits || res?.results || (Array.isArray(res) ? res : []) || [];
      if (!hits.length) {
        panel.innerHTML = `<div class="search-hit-empty">无匹配结果</div>`;
        return;
      }
      panel.innerHTML = "";
      for (const group of groupSearchHits(hits)) {
        const section = document.createElement("section");
        section.className = "search-group";
        section.dataset.searchGroup = group.id;
        const heading = document.createElement("h3");
        heading.className = "search-group-title";
        heading.textContent = `${group.label} · ${group.hits.length}`;
        section.appendChild(heading);
        const list = document.createElement("div");
        list.className = "search-group-list";
        for (const hit of group.hits) list.appendChild(createSearchHitButton(hit));
        section.appendChild(list);
        panel.appendChild(section);
      }
    } catch (e) {
      if (seq !== searchSeq) return;
      panel.innerHTML = `<div class="search-hit-empty">搜索失败：${escapeHtml(e.message || e)}</div>`;
    }
  }

  function onVaultSearchInput() {
    const q = $("vaultSearch")?.value || "";
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      runVaultSearch(q);
    }, 280);
  }

  function wireDom() {
    $("btnOpenVaultDir")?.addEventListener("click", () => pickOpenVault());
    $("btnNewVaultDir")?.addEventListener("click", () => pickCreateVault());
    $("btnCopyVaultPath")?.addEventListener("click", () => copyVaultPath());
    $("btnSettingsOpenVault")?.addEventListener("click", () => {
      if (typeof D.closeSettings === "function") D.closeSettings(false);
      pickOpenVault();
    });
    $("btnSettingsNewVault")?.addEventListener("click", () => {
      if (typeof D.closeSettings === "function") D.closeSettings(false);
      pickCreateVault();
    });
    $("btnSettingsCopyVaultPath")?.addEventListener("click", () => copyVaultPath());

    $("libFilter")?.addEventListener("input", () => {
      if (typeof D.refreshLibrarySidebar === "function") D.refreshLibrarySidebar();
    });

    $("vaultSearch")?.addEventListener("input", onVaultSearchInput);
    $("vaultSearch")?.addEventListener("focus", () => {
      const q = $("vaultSearch")?.value || "";
      if (String(q).trim()) runVaultSearch(q);
    });
    $("vaultSearch")?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideSearchHits();
        e.target.blur?.();
      }
    });
    document.addEventListener("click", (e) => {
      const wrap = e.target?.closest?.(".vault-search-wrap");
      const panel = $("searchHits");
      if (!wrap && panel && !panel.contains(e.target)) hideSearchHits();
    });
  }

  /**
   * @param {Record<string, any>} deps
   */
  function init(deps) {
    D = deps || {};
    wireDom();
  }

  return {
    init,
    isVaultOpOk,
    applyVaultOpResult,
    handleBookDirResult,
    handleUnknownVault,
    afterVaultSwitch,
    pickOpenVault,
    pickCreateVault,
    copyVaultPath,
    applyImportSuccess,
    hideSearchHits,
    runVaultSearch,
    searchGroupForHit,
    groupSearchHits,
  };
})();
