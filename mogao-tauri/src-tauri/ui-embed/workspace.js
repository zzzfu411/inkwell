/**
 * 墨稿 · Obsidian 风格书稿工作区
 * 文件树 + 源码编辑 + Markdown 预览 + 磁盘监视 + 文件生命周期
 */
window.NOVEL_WORKSPACE = (() => {
  const Vault = () => window.NOVEL_VAULT;

  let slug = "";
  let treeData = null;
  let openPath = "";
  /** 树选中路径（可与 openPath 不同，用于文件夹操作） */
  let selectedPath = "";
  let selectedKind = ""; // file | dir
  let openMtime = 0;
  let dirty = false;
  let fallbackRevision = 0;
  const editRevisions = window.NOVEL_UI_SHELL?.createRevisionTracker?.(() => "workspace") || {
    read: () => fallbackRevision,
    bump: () => ++fallbackRevision,
    matches: (_subject, revision) => fallbackRevision === Number(revision || 0),
  };
  let watchTimer = null;
  let lastWatch = {};
  /** 上次 watch 响应的 content epoch；null 表示未收到过（兼容旧后端无 epoch） */
  let lastEpoch = null;
  /** 连续 epoch 短路次数；满 10 次强制全量 mtime 对比，防漏 */
  let epochSkipCount = 0;
  let pollIntervalMs = 800;
  let expanded = new Set(["章节", "策划", "关系", "记忆", "锁定"]);
  let splitMode = "both"; // editor | preview | both
  let onStatus = () => {};
  let onBookMutated = null; // 章节写入后通知 app 重载内存
  let previewSeq = 0; // 防预览竞态
  let previewTimer = null;
  /** @type {HTMLElement|null} */
  let snapshotReturnFocus = null;
  /** @type {HTMLElement|null} */
  let ctxMenuEl = null;

  const $ = (id) => document.getElementById(id);

  /**
   * 这些文件是项目状态的人类可读/可交换镜像，整本保存时会由编辑台重建。
   * 工作区允许查看与复制，但不能把它们伪装成可直接维护的权威来源。
   */
  const GENERATED_MIRROR_PATHS = new Set([
    "README.md",
    "book.json",
    "策划/pitch.md",
    "策划/world.json",
    "策划/spine.json",
    "策划/tasks.json",
    "策划/style-bible.json",
    "关系/graph.json",
    "记忆/细节设定.md",
    "锁定/locks.json",
  ]);

  function normalizeWorkspacePath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
  }

  function generatedMirrorInfo(path) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return null;
    const generatedMemoryJson = /^记忆\/[^/]+\.json$/i.test(normalized);
    if (!GENERATED_MIRROR_PATHS.has(normalized) && !generatedMemoryJson) return null;

    let owner = "故事 / 设置 / 分析";
    if (normalized === "README.md" || normalized === "book.json") owner = "故事 / 设置";
    else if (normalized.startsWith("策划/")) owner = "故事 / 设置";
    else if (normalized.startsWith("关系/") || normalized.startsWith("记忆/")) owner = "分析 / 故事";
    else if (normalized.startsWith("锁定/")) owner = "故事";

    return {
      path: normalized,
      owner,
      message: `系统生成镜像，只读；请在「${owner}」中修改源数据`,
    };
  }

  function workspaceReadOnlyReason(path = openPath) {
    if (isGenLocked()) {
      return { kind: "generation", message: "生成中，工作区暂时只读" };
    }
    const mirror = generatedMirrorInfo(path);
    return mirror ? { kind: "mirror", ...mirror } : null;
  }

  /** 统一计算生成锁与系统镜像只读态；调用方不得直接覆写 wsEditor.readOnly。 */
  function syncReadOnly({ announce = false } = {}) {
    const reason = workspaceReadOnlyReason();
    const readOnly = !!reason;
    const ed = $("wsEditor");
    if (ed) {
      ed.readOnly = readOnly;
      ed.setAttribute("aria-readonly", String(readOnly));
      ed.classList.toggle("system-readonly", reason?.kind === "mirror");
      ed.title = reason?.message || "";
    }

    const save = $("btnWsSave");
    if (save) {
      save.disabled = readOnly || !openPath;
      save.title = reason?.message || (openPath ? "保存当前文件" : "请先打开文件");
    }

    const selectedFile = selectedKind === "file" ? selectedPath : openPath;
    const selectionIsMirror = !!generatedMirrorInfo(selectedFile);
    for (const id of ["btnWsRename", "btnWsDelete"]) {
      const button = $(id);
      if (!button) continue;
      button.disabled = isGenLocked() || selectionIsMirror || !selectedFile;
      button.title = selectionIsMirror
        ? "系统生成镜像不能重命名或删除"
        : isGenLocked()
          ? "生成中暂不可修改文件"
          : "";
    }

    const meta = $("wsFileMeta");
    if (meta) {
      const base = meta.dataset.fileDetails || "";
      const suffix =
        reason?.kind === "mirror"
          ? "系统镜像 · 只读"
          : reason?.kind === "generation"
            ? "生成中 · 只读"
            : "";
      meta.textContent = [base, suffix].filter(Boolean).join(" · ");
    }

    if (announce && reason) setStatus(reason.message, "warn");
    return reason;
  }

  function setStatus(msg, kind) {
    // 后台树刷新、复制等成功消息不得覆盖更高优先级的未保存状态。
    // saveCurrent/openFile 会先把 dirty 置 false，因此真正的保存成功仍会正常显示。
    if (dirty && kind === "ok") return;
    onStatus(msg, kind);
    const el = $("wsStatus");
    if (el) {
      el.textContent = msg;
      el.className = "ws-status" + (kind ? ` ${kind}` : "");
      el.setAttribute("aria-live", kind === "err" ? "assertive" : "polite");
      el.setAttribute("aria-busy", kind === "busy" ? "true" : "false");
    }
  }

  function filesDrawerIsCompact() {
    return !!window.matchMedia?.("(max-width: 760px)").matches;
  }

  function syncFilesDrawerAccessibility() {
    const layout = document.querySelector("#view-workspace .ws-layout");
    const drawer = $("wsFilesDrawer");
    const toggle = $("btnWsToggleFiles");
    const scrim = $("wsFilesScrim");
    if (!layout || !drawer || !toggle || !scrim) return;
    const compact = filesDrawerIsCompact();
    const open = compact && layout.classList.contains("files-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭资料文件" : "打开资料文件");
    scrim.hidden = !open;
    if (compact) {
      drawer.inert = !open;
      drawer.setAttribute("aria-hidden", String(!open));
    } else {
      layout.classList.remove("files-open");
      drawer.inert = false;
      drawer.removeAttribute("aria-hidden");
    }
  }

  function setFilesDrawer(open, { restoreFocus = false } = {}) {
    const layout = document.querySelector("#view-workspace .ws-layout");
    if (!layout) return;
    layout.classList.toggle("files-open", filesDrawerIsCompact() && !!open);
    syncFilesDrawerAccessibility();
    if (open) {
      window.setTimeout(() => $("wsTree")?.querySelector("button")?.focus(), 0);
    } else if (restoreFocus) {
      $("btnWsToggleFiles")?.focus();
    }
  }

  /** 极简 Markdown → HTML（无外部依赖） */
  function renderMarkdown(src) {
    let s = String(src || "");
    // 抽出 fenced code
    const blocks = [];
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const i = blocks.length;
      blocks.push(
        `<pre class="md-code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`
      );
      return `\u0000BLOCK${i}\u0000`;
    });
    s = escapeHtml(s);
    s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    s = s.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
    s = s.replace(/^\- (.+)$/gm, "<li>$1</li>");
    s = s.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/^(?!<h[1-3]|<ul|<li|<blockquote|<pre)(.+)$/gm, (line) => {
      if (!line.trim() || line.startsWith("\u0000BLOCK")) return line;
      return `<p>${line}</p>`;
    });
    s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)] || "");
    s = s.replace(/\n{2,}/g, "\n");
    return s;
  }

  function escapeHtml(t) {
    return String(t || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function noteTemplate(title) {
    const name = String(title || "未命名").trim() || "未命名";
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return `---\ntitle: ${name}\ncreated: ${now}\n---\n\n# ${name}\n\n`;
  }

  function parentDir(path) {
    if (!path) return "";
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(0, i) : "";
  }

  function baseName(path) {
    if (!path) return "";
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
  }

  function joinPath(dir, name) {
    const d = String(dir || "").replace(/\/+$/, "");
    const n = String(name || "").replace(/^\/+/, "");
    return d ? `${d}/${n}` : n;
  }

  /** 生成锁：禁止一切工作区文件变更（读开仍允许） */
  function isGenLocked() {
    return !!(window.__mogaoGen?.locked);
  }

  function guardGenMutate(actionLabel) {
    if (!isGenLocked()) return false;
    const msg = `生成中，无法${actionLabel || "修改文件"}。请稍候或先点「停止」。`;
    setStatus(msg, "warn");
    alert(msg);
    return true;
  }

  function guardFileMutate(actionLabel, path = openPath) {
    if (guardGenMutate(actionLabel)) return true;
    const mirror = generatedMirrorInfo(path);
    if (!mirror) return false;
    const msg = `无法${actionLabel || "修改"}「${mirror.path}」：${mirror.message}。`;
    setStatus(msg, "warn");
    alert(msg);
    return true;
  }

  /** 当前操作基准目录：选中文件夹 / 打开文件的父目录 / 根 */
  function targetDir() {
    if (selectedPath && selectedKind === "dir") return selectedPath;
    if (selectedPath && selectedKind === "file") return parentDir(selectedPath);
    if (openPath) return parentDir(openPath);
    return "";
  }

  function ensureMdExt(name) {
    const n = String(name || "").trim();
    if (!n) return "";
    return /\.(md|json|txt|markdown)$/i.test(n) ? n : `${n}.md`;
  }

  function isWritingHintPath(path) {
    const hints = window.__mogaoGen?.writingFileHints || [];
    if (!path || !hints.length) return false;
    const p = String(path);
    return hints.some((h) => {
      const s = String(h || "");
      if (!s) return false;
      return p === s || p.includes(s) || s.includes(p) || baseName(p).includes(baseName(s));
    });
  }

  function renderTree(nodes, depth = 0) {
    if (!nodes?.length) return `<div class="ws-empty">（空目录）</div>`;
    let html = `<ul class="ws-tree-ul" data-depth="${depth}">`;
    for (const n of nodes) {
      if (n.type === "dir") {
        const open = expanded.has(n.path);
        const sel = n.path === selectedPath ? " selected" : "";
        html += `<li class="ws-dir ${open ? "open" : ""}">
          <button type="button" class="ws-row dir${sel}" data-path="${escapeHtml(n.path)}" data-kind="dir" data-droppable="1">
            <span class="ws-twist">${open ? "▾" : "▸"}</span>
            <span class="ws-icon">📁</span>
            <span class="ws-name">${escapeHtml(n.name)}</span>
          </button>
          <div class="ws-children" ${open ? "" : "hidden"}>${renderTree(n.children || [], depth + 1)}</div>
        </li>`;
      } else {
        const active = n.path === openPath ? " active" : "";
        const sel = n.path === selectedPath ? " selected" : "";
        const writing = isWritingHintPath(n.path) ? " writing-file" : "";
        const mirror = generatedMirrorInfo(n.path);
        const system = mirror ? " system-mirror" : "";
        const icon = n.ext === ".md" ? "📄" : n.ext === ".json" ? "{}" : "📎";
        html += `<li>
          <button type="button" class="ws-row file${active}${sel}${writing}${system}" data-path="${escapeHtml(n.path)}" data-kind="file" data-editable="${n.editable && !mirror ? "1" : "0"}" data-system-mirror="${mirror ? "1" : "0"}" draggable="${mirror ? "false" : "true"}"${mirror ? ` aria-label="${escapeHtml(`${n.name}，系统生成镜像，只读`)}" title="${escapeHtml(mirror.message)}"` : ""}>
            <span class="ws-twist"></span>
            <span class="ws-icon">${icon}</span>
            <span class="ws-name">${escapeHtml(n.name)}</span>
            ${mirror ? '<span class="ws-mirror-mark" aria-hidden="true">只读</span>' : ""}
          </button>
        </li>`;
      }
    }
    html += "</ul>";
    return html;
  }

  function setSelected(path, kind) {
    selectedPath = path || "";
    selectedKind = kind || "";
    syncReadOnly();
  }

  function hideCtxMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }

  function showCtxMenu(clientX, clientY, path, kind) {
    hideCtxMenu();
    setSelected(path, kind);
    // 仅刷新选中态，避免重绑打断后续操作
    const root = $("wsTree");
    root?.querySelectorAll(".ws-row").forEach((btn) => {
      const on = btn.dataset.path === path;
      btn.classList.toggle("selected", on);
    });

    const menu = document.createElement("div");
    menu.className = "ws-ctx-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const protectedMirror = kind === "file" ? generatedMirrorInfo(path) : null;
    const items = [
      { label: "新建笔记", run: () => newNote() },
      { label: "新建文件夹", run: () => newFolder() },
      { label: "重命名", run: () => renameSelected(), disabled: !!protectedMirror },
      { label: "删除", run: () => deleteSelected(), danger: true, disabled: !!protectedMirror },
      {
        label: "在资源管理器中显示",
        run: async () => {
          try {
            if (!slug) {
              alert("请先选择一本书");
              return;
            }
            const rel = path || openPath || "";
            if (rel) {
              const vaultRel = `books/${slug}/${String(rel).replace(/^\/+/, "")}`;
              try {
                await Vault().reveal(vaultRel);
                setStatus(`已在资源管理器显示 · ${rel}`, "ok");
                return;
              } catch (e1) {
                console.warn("ctx reveal rel", e1);
              }
            }
            await Vault().revealBook(slug);
            setStatus(`已打开书目录 · ${slug}`, "ok");
          } catch (e) {
            alert("打开失败: " + (e.message || e));
          }
        },
      },
    ];
    items.forEach(({ label, run, danger, disabled }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-ctx-item" + (danger ? " danger" : "");
      b.textContent = label;
      b.disabled = !!disabled;
      if (disabled) b.title = "系统生成镜像只读";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        hideCtxMenu();
        run();
      });
      menu.appendChild(b);
    });

    document.body.appendChild(menu);
    ctxMenuEl = menu;
    requestAnimationFrame(() => {
      if (!ctxMenuEl) return;
      const r = ctxMenuEl.getBoundingClientRect();
      let left = clientX;
      let top = clientY;
      if (r.right > window.innerWidth - 4) left = Math.max(4, window.innerWidth - r.width - 4);
      if (r.bottom > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
      ctxMenuEl.style.left = `${left}px`;
      ctxMenuEl.style.top = `${top}px`;
    });
  }

  function bindTreeClicks() {
    const root = $("wsTree");
    if (!root) return;
    root.querySelectorAll(".ws-row").forEach((btn) => {
      btn.addEventListener("click", async () => {
        hideCtxMenu();
        const kind = btn.dataset.kind;
        const path = btn.dataset.path;
        setSelected(path, kind);
        if (kind === "dir") {
          if (expanded.has(path)) expanded.delete(path);
          else expanded.add(path);
          paintTree();
          return;
        }
        if (dirty && openPath && openPath !== path) {
          if (!confirm("当前文件未保存，切换将丢弃修改。继续？")) {
            paintTree();
            return;
          }
        }
        await openFile(path);
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, btn.dataset.path, btn.dataset.kind);
      });

      // —— 拖拽移动：file → dir ——
      if (btn.dataset.kind === "file") {
        btn.addEventListener("dragstart", (e) => {
          const path = btn.dataset.path || "";
          if (isGenLocked() || generatedMirrorInfo(path)) {
            e.preventDefault();
            if (generatedMirrorInfo(path)) setStatus("系统生成镜像不能移动", "warn");
            return;
          }
          e.dataTransfer?.setData("text/plain", path);
          e.dataTransfer?.setData("application/x-mogao-path", path);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          btn.classList.add("dragging");
        });
        btn.addEventListener("dragend", () => {
          btn.classList.remove("dragging");
          root.querySelectorAll(".ws-row.drop-target").forEach((el) => el.classList.remove("drop-target"));
        });
      }
      if (btn.dataset.kind === "dir") {
        btn.addEventListener("dragover", (e) => {
          if (isGenLocked()) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          btn.classList.add("drop-target");
        });
        btn.addEventListener("dragleave", () => {
          btn.classList.remove("drop-target");
        });
        btn.addEventListener("drop", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          btn.classList.remove("drop-target");
          if (guardGenMutate("移动文件")) return;
          const from =
            e.dataTransfer?.getData("application/x-mogao-path") ||
            e.dataTransfer?.getData("text/plain") ||
            "";
          const dir = btn.dataset.path || "";
          if (!from || !dir) return;
          if (guardFileMutate("移动", from)) return;
          // 禁止拖到自身所在目录（无变化）或拖到自身路径
          if (from === dir) return;
          if (parentDir(from) === dir) {
            setStatus("已在目标目录", "warn");
            return;
          }
          // 禁止把文件拖进以自身为前缀的「伪子路径」（文件无子，仅防异常）
          if (dir === from || dir.startsWith(from + "/")) return;
          const to = joinPath(dir, baseName(from));
          if (to === from) return;
          // 同名冲突预检：后端 fs_rename 拒绝覆盖，前端直接拦截
          if (pathExistsInTree(treeData?.tree, to)) {
            setStatus(`目标已存在：${to}`, "warn");
            alert(`目标已存在，无法移动：\n${to}\n\n请先重命名或删除目标文件。`);
            return;
          }
          try {
            setStatus(`移动 ${from} → ${to}…`, "busy");
            await Vault().fsRename(slug, from, to);
            if (openPath === from) {
              openPath = to;
              $("wsFilePath") && ($("wsFilePath").textContent = to);
            }
            setSelected(to, "file");
            await refreshTree(true);
            setStatus(`已移动 · ${to}`, "ok");
            if (shouldNotifyBookMutated(from) || shouldNotifyBookMutated(to)) {
              await notifyBookMutated();
            }
          } catch (err) {
            const raw = String(err?.message || err || "移动失败");
            const friendly =
              /target\s*exists|already\s*exists|目标已存在|已存在/i.test(raw)
                ? `目标已存在：${to}\n${raw}`
                : raw;
            setStatus("移动失败", "err");
            alert("移动失败: " + friendly);
          }
        });
      }
    });
  }

  function paintTree() {
    const el = $("wsTree");
    if (!el || !treeData) return;
    el.innerHTML = renderTree(treeData.tree || []);
    bindTreeClicks();
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      updatePreview();
    }, 120);
  }

  async function updatePreview() {
    const src = $("wsEditor")?.value || "";
    const prev = $("wsPreview");
    if (!prev) return;
    const seq = ++previewSeq;
    if (!src.trim()) {
      prev.innerHTML = "";
      return;
    }
    // 优先服务端 pulldown-cmark 预览；失败回退本地极简渲染
    try {
      if (Vault()?.previewMarkdown) {
        const html = await Vault().previewMarkdown(src);
        if (seq !== previewSeq) return;
        // 空字符串也算成功（服务端已处理）
        if (typeof html === "string") {
          prev.innerHTML = html;
          return;
        }
      }
    } catch (_) {
      /* fallback */
    }
    if (seq !== previewSeq) return;
    prev.innerHTML = renderMarkdown(src);
  }

  /** 镜像文件 / 章节 / book.json 变更后通知 app 重载工程内存 */
  function shouldNotifyBookMutated(path) {
    if (!path) return false;
    return (
      path === "book.json" ||
      path.startsWith("章节/") ||
      path.startsWith("策划/") ||
      path.startsWith("关系/") ||
      path.startsWith("记忆/") ||
      path.startsWith("锁定/")
    );
  }

  async function notifyBookMutated(mutatedSlug = slug, meta = {}) {
    if (typeof onBookMutated !== "function" || !mutatedSlug) return;
    try {
      await onBookMutated(mutatedSlug, meta);
    } catch (e) {
      console.warn("onBookMutated", e);
    }
  }

  function applySplit() {
    const ed = $("wsEditorPane");
    const pr = $("wsPreviewPane");
    if (!ed || !pr) return;
    ed.hidden = splitMode === "preview";
    pr.hidden = splitMode === "editor";
    document.querySelectorAll("[data-split]").forEach((b) => {
      const active = b.dataset.split === splitMode;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    });
    const activeTabId = $(`ws-tab-${splitMode}`)?.id || "ws-tab-both";
    ed.setAttribute("aria-labelledby", activeTabId);
    pr.setAttribute("aria-labelledby", activeTabId);
  }

  async function refreshTree(silent) {
    if (!slug) return;
    try {
      treeData = await Vault().fileTree(slug);
      // 默认展开一级
      (treeData.tree || []).forEach((n) => {
        if (n.type === "dir") expanded.add(n.path);
      });
      paintTree();
      if (!silent) setStatus(`文件树 · ${slug}`, "ok");
      const w = await Vault().fileWatch(slug);
      lastWatch = w.files || {};
      const hint = w.pollHintMs ?? w.poll_hint_ms ?? w.hintMs;
      if (hint != null && watchTimer) scheduleWatch(hint);
    } catch (e) {
      setStatus("树加载失败: " + (e.message || e), "err");
    }
  }

  async function openFile(path) {
    if (!slug || !path) return;
    // 生成中允许只读打开
    try {
      setStatus(`打开 ${path}…`, "busy");
      const file = await Vault().readFile(slug, path);
      editRevisions.bump();
      openPath = file.path;
      openMtime = file.mtime || 0;
      dirty = false;
      setSelected(file.path, "file");
      const ed = $("wsEditor");
      if (ed) {
        ed.value = file.content || "";
      }
      $("wsFilePath") && ($("wsFilePath").textContent = file.path);
      const meta = $("wsFileMeta");
      if (meta) {
        meta.dataset.fileDetails = `${file.size || 0} B · ${new Date(file.mtime || 0).toLocaleString()}`;
      }
      const readOnlyReason = syncReadOnly();
      updatePreview();
      paintTree();
      setStatus(
        readOnlyReason
          ? `只读打开 · ${file.name} · ${readOnlyReason.message}`
          : `已打开 · ${file.name}`,
        readOnlyReason ? "warn" : "ok"
      );
      if (filesDrawerIsCompact()) setFilesDrawer(false);
    } catch (e) {
      setStatus(String(e.message || e), "err");
      alert("打开失败: " + (e.message || e));
    }
  }

  function captureSaveState() {
    const ed = $("wsEditor");
    return {
      slug,
      path: openPath,
      revision: editRevisions.read(),
      content: ed?.value || "",
    };
  }

  function saveStateIsCurrent(snapshot) {
    const ed = $("wsEditor");
    return !!(
      snapshot &&
      snapshot.slug === slug &&
      snapshot.path === openPath &&
      editRevisions.matches(undefined, snapshot.revision) &&
      (ed?.value || "") === snapshot.content
    );
  }

  async function saveCurrent() {
    if (guardFileMutate("保存")) return false;
    if (!slug || !openPath) {
      alert("未打开文件");
      return false;
    }
    const ed = $("wsEditor");
    if (!ed) return false;
    const snapshot = captureSaveState();
    try {
      setStatus("保存中…", "busy");
      const res = await Vault().writeFile(snapshot.slug, snapshot.path, snapshot.content);
      const sameDocument = snapshot.slug === slug && snapshot.path === openPath;
      if (sameDocument) openMtime = res.mtime || openMtime;
      const current = saveStateIsCurrent(snapshot);
      if (current) {
        dirty = false;
        setStatus(`已保存 · ${snapshot.path}`, "ok");
      } else if (sameDocument) {
        dirty = true;
        setStatus(`较早版本已保存 · ${snapshot.path} 仍有未保存修改`, "warn");
      }
      // 章节 md 或 book.json 必须同步工程内存，避免写章台被旧缓存覆盖
      if (shouldNotifyBookMutated(snapshot.path)) {
        await notifyBookMutated(snapshot.slug);
      }
      if (sameDocument) await refreshTree(true);
      return true;
    } catch (e) {
      setStatus("保存失败", "err");
      alert("保存失败: " + (e.message || e));
      throw e;
    }
  }

  async function newNote() {
    if (guardGenMutate("新建笔记")) return;
    if (!slug) return alert("请先选择一本书");
    // P2-5：尊重当前选中目录（targetDir）；无选中时默认 章节/
    const base = targetDir() || "章节";
    const raw = prompt(`新笔记名称（将放在 ${base || "书根"}/ 下）`, "新笔记");
    if (raw === null) return;
    const name = ensureMdExt(raw);
    if (!name) return alert("名称不能为空");
    const path = joinPath(base, name);
    const title = name.replace(/\.md$/i, "");
    try {
      setStatus(`新建 ${path}…`, "busy");
      await Vault().fsCreate(slug, path, noteTemplate(title));
      if (base) expanded.add(base);
      // 展开祖先路径
      const parts = base.split("/").filter(Boolean);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        expanded.add(acc);
      }
      await refreshTree(true);
      await openFile(path);
      setStatus(`已新建 · ${path}`, "ok");
      await notifyBookMutated();
    } catch (e) {
      setStatus("新建失败", "err");
      alert("新建笔记失败: " + (e.message || e));
    }
  }

  async function newFolder() {
    if (guardGenMutate("新建文件夹")) return;
    if (!slug) return alert("请先选择一本书");
    const base = targetDir() || "";
    const hint = base ? `在「${base}/」下新建文件夹` : "在书根下新建文件夹";
    const raw = prompt(hint, "新文件夹");
    if (raw === null) return;
    const name = String(raw).trim().replace(/[\\/]/g, "");
    if (!name) return alert("名称不能为空");
    const path = joinPath(base, name);
    try {
      setStatus(`新建文件夹 ${path}…`, "busy");
      await Vault().fsMkdir(slug, path);
      if (base) expanded.add(base);
      expanded.add(path);
      setSelected(path, "dir");
      await refreshTree(true);
      setStatus(`已新建文件夹 · ${path}`, "ok");
    } catch (e) {
      setStatus("新建文件夹失败", "err");
      alert("新建文件夹失败: " + (e.message || e));
    }
  }

  async function renameSelected() {
    if (guardGenMutate("重命名")) return;
    if (!slug) return alert("请先选择一本书");
    const from = selectedPath || openPath;
    if (!from) return alert("请先在文件树选中一项");
    if (guardFileMutate("重命名", from)) return;
    const oldName = baseName(from);
    const raw = prompt("新名称", oldName);
    if (raw === null) return;
    let name = String(raw).trim().replace(/[\\/]/g, "");
    if (!name) return alert("名称不能为空");
    if (name === oldName) return;
    // 文件保留扩展名习惯：用户没写扩展且原文件有扩展 → 补上
    if (selectedKind !== "dir" && oldName.includes(".") && !name.includes(".")) {
      const ext = oldName.slice(oldName.lastIndexOf("."));
      name = name + ext;
    }
    const to = joinPath(parentDir(from), name);
    if (to === from) return;
    try {
      if (dirty && openPath === from) {
        if (!confirm("当前文件未保存。重命名前先保存？\n确定=保存后重命名；取消=丢弃修改并重命名")) {
          dirty = false;
        } else {
          await saveCurrent();
        }
      }
      setStatus(`重命名 ${from} → ${to}…`, "busy");
      await Vault().fsRename(slug, from, to);
      if (openPath === from) {
        openPath = to;
        $("wsFilePath") && ($("wsFilePath").textContent = to);
      } else if (openPath && openPath.startsWith(from + "/")) {
        openPath = to + openPath.slice(from.length);
        $("wsFilePath") && ($("wsFilePath").textContent = openPath);
      }
      if (expanded.has(from)) {
        expanded.delete(from);
        expanded.add(to);
      }
      setSelected(to, selectedKind || (to.includes(".") ? "file" : "dir"));
      await refreshTree(true);
      if (openPath === to) await openFile(to);
      setStatus(`已重命名 · ${to}`, "ok");
      if (shouldNotifyBookMutated(from) || shouldNotifyBookMutated(to)) {
        await notifyBookMutated();
      }
    } catch (e) {
      setStatus("重命名失败", "err");
      alert("重命名失败: " + (e.message || e));
    }
  }

  async function deleteSelected() {
    if (guardGenMutate("删除")) return;
    if (!slug) return alert("请先选择一本书");
    const path = selectedPath || openPath;
    if (!path) return alert("请先在文件树选中一项");
    if (guardFileMutate("删除", path)) return;
    const kindLabel = selectedKind === "dir" ? "文件夹" : "文件";
    if (!confirm(`删除${kindLabel}「${path}」？\n不可恢复。`)) return;
    try {
      setStatus(`删除 ${path}…`, "busy");
      await Vault().fsDelete(slug, path);
      const wasOpen =
        openPath === path || (openPath && openPath.startsWith(path + "/"));
      if (wasOpen) {
        openPath = "";
        dirty = false;
        if ($("wsEditor")) $("wsEditor").value = "";
        if ($("wsPreview")) $("wsPreview").innerHTML = "";
        if ($("wsFilePath")) $("wsFilePath").textContent = "未打开文件";
        if ($("wsFileMeta")) {
          $("wsFileMeta").dataset.fileDetails = "";
          $("wsFileMeta").textContent = "";
        }
      }
      if (selectedPath === path) setSelected("", "");
      syncReadOnly();
      expanded.delete(path);
      await refreshTree(true);
      setStatus(`已删除 · ${path}`, "ok");
      if (shouldNotifyBookMutated(path)) {
        await notifyBookMutated();
      }
    } catch (e) {
      setStatus("删除失败", "err");
      alert("删除失败: " + (e.message || e));
    }
  }

  function formatSnapshotTime(s) {
    if (!s) return "";
    if (typeof s === "number") {
      try {
        return new Date(s < 1e12 ? s * 1000 : s).toLocaleString();
      } catch (_) {
        return String(s);
      }
    }
    return String(s);
  }

  function closeSnapshotModal() {
    const m = $("snapshotModal");
    if (m) m.hidden = true;
    window.NOVEL_MODAL_A11Y?.sync?.();
    snapshotReturnFocus?.focus?.();
    snapshotReturnFocus = null;
  }

  function snapshotSubLine(s) {
    const t = formatSnapshotTime(s.createdAt || s.mtime || s.time || s.created);
    const reason = s.reason || s.label || "";
    const ch =
      s.chapters != null
        ? s.chapters
        : s.chapterCount != null
          ? s.chapterCount
          : s.chapter_count != null
            ? s.chapter_count
            : null;
    const chLabel = ch != null && ch !== "" ? `${ch} 章` : "";
    return [t, reason, chLabel].filter(Boolean).join(" · ");
  }

  async function showSnapshots() {
    if (!slug) return alert("请先选择一本书");
    const modal = $("snapshotModal");
    const list = $("snapshotList");
    const empty = $("snapshotEmpty");
    const hint = $("snapshotModalHint");
    if (!modal || !list) {
      // 无弹层时退回 prompt 列表
      try {
        const res = await Vault().listSnapshots(slug);
        const items = res.snapshots || res.items || res || [];
        const arr = Array.isArray(items) ? items : [];
        if (!arr.length) return alert("暂无快照，请先点创建快照");
        const lines = arr.map((s, i) => {
          const id = s.id || s.name || s;
          const sub = snapshotSubLine(s);
          return `${i + 1}. ${id}${sub ? " · " + sub : ""}`;
        });
        const pick = prompt(`快照列表（输入序号恢复）：\n${lines.join("\n")}`, "1");
        if (pick === null) return;
        const idx = Number(pick) - 1;
        if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return alert("无效序号");
        const id = arr[idx].id || arr[idx].name || arr[idx];
        await doRestore(id);
      } catch (e) {
        alert("加载快照失败: " + (e.message || e));
      }
      return;
    }

    list.innerHTML = "";
    if (empty) {
      empty.hidden = true;
      empty.textContent = "暂无快照，请先点创建快照";
    }
    if (hint) hint.textContent = `书目：${slug} · 恢复会覆盖当前书稿文件（恢复前会自动备份）`;
    snapshotReturnFocus = document.activeElement;
    modal.hidden = false;
    window.NOVEL_MODAL_A11Y?.sync?.(modal);
    window.setTimeout(() => modal.querySelector(".modal")?.focus(), 0);
    try {
      setStatus("加载快照…", "busy");
      const res = await Vault().listSnapshots(slug);
      const items = res.snapshots || res.items || res || [];
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) {
        if (empty) empty.hidden = false;
        setStatus("暂无快照", "warn");
        return;
      }
      arr.forEach((s) => {
        const id = s.id || s.name || String(s);
        const sub = snapshotSubLine(s);
        const li = document.createElement("li");
        li.className = "snapshot-item";
        li.innerHTML = `
          <div class="snapshot-item-meta">
            <span class="snapshot-item-id">${escapeHtml(id)}</span>
            <span class="snapshot-item-sub">${escapeHtml(sub)}</span>
          </div>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn primary xs";
        btn.textContent = "恢复";
        btn.addEventListener("click", async () => {
          await doRestore(id, s);
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
      setStatus(`快照 ${arr.length} 个`, "ok");
    } catch (e) {
      closeSnapshotModal();
      setStatus("加载快照失败", "err");
      alert("加载快照失败: " + (e.message || e));
    }
  }

  async function doRestore(id, meta) {
    if (guardGenMutate("恢复快照")) return;
    if (!slug || !id) return;
    const extra = meta ? snapshotSubLine(meta) : "";
    if (
      !confirm(
        `恢复快照「${id}」？${extra ? "\n" + extra : ""}\n当前书稿文件将被覆盖；写章台未存盘正文也会被快照替换。恢复前会自动备份当前状态。`
      )
    )
      return;
    try {
      setStatus(`恢复 ${id}…`, "busy");
      const res = await Vault().restoreSnapshot(slug, id);
      closeSnapshotModal();
      dirty = false;
      openPath = "";
      if ($("wsEditor")) $("wsEditor").value = "";
      if ($("wsPreview")) $("wsPreview").innerHTML = "";
      if ($("wsFilePath")) $("wsFilePath").textContent = "未打开文件";
      await refreshTree(true);
      await notifyBookMutated(slug, { source: "snapshot" });
      // 恢复后自动打开 README 或第一章
      const prefer =
        findFile(treeData?.tree, (n) => n.name === "README.md") ||
        findFile(treeData?.tree, (n) => n.path.startsWith("章节/") && n.ext === ".md");
      if (prefer) await openFile(prefer.path);
      setStatus(`已恢复快照 · ${id}`, "ok");
      const backupId =
        res?.backupId ||
        res?.preRestoreId ||
        res?.beforeRestore ||
        res?.pre_restore_id ||
        null;
      const backupLine = backupId
        ? `恢复前备份快照：${backupId}`
        : "恢复前已自动创建备份快照（.history / before-restore）";
      const ch =
        res?.book?.chapters?.length ??
        res?.chapters ??
        meta?.chapters ??
        meta?.chapterCount ??
        null;
      const chLine = ch != null ? `\n章节数：${Array.isArray(ch) ? ch.length : ch}` : "";
      alert(`已恢复到快照「${id}」\n${backupLine}${chLine}`);
    } catch (e) {
      setStatus("恢复失败", "err");
      alert("恢复失败: " + (e.message || e));
    }
  }

  function scheduleWatch(ms) {
    if (watchTimer) clearInterval(watchTimer);
    pollIntervalMs = Math.max(300, Number(ms) || 800);
    watchTimer = setInterval(pollWatch, pollIntervalMs);
  }

  async function pollWatch() {
    if (!slug || document.getElementById("view-workspace")?.classList.contains("active") === false) return;
    try {
      const w = await Vault().fileWatch(slug);
      const files = w.files || {};
      // 服务端可下发 pollHintMs 建议轮询间隔
      const hint = w.pollHintMs ?? w.poll_hint_ms ?? w.hintMs;
      if (hint != null) {
        const next = Math.max(300, Number(hint) || 800);
        if (next !== pollIntervalMs && watchTimer) {
          scheduleWatch(next);
        }
      }
      // epoch 短路：未变则跳过 keys 对比（每 10 次仍强制全量，防漏）
      // 旧后端无 epoch 字段时 lastEpoch 保持 null，行为与原先全量对比一致
      const hasEpoch = w != null && Object.prototype.hasOwnProperty.call(w, "epoch") && w.epoch != null;
      if (hasEpoch) {
        const ep = w.epoch;
        if (lastEpoch != null && ep === lastEpoch) {
          epochSkipCount += 1;
          if (epochSkipCount < 10) return;
          // 第 10 次：强制全量 mtime 对比
          epochSkipCount = 0;
        } else {
          lastEpoch = ep;
          epochSkipCount = 0;
        }
      }
      const keys = new Set([...Object.keys(files), ...Object.keys(lastWatch)]);
      const changedKeys = [];
      for (const k of keys) {
        if ((files[k] || 0) !== (lastWatch[k] || 0)) changedKeys.push(k);
      }
      if (changedKeys.length) {
        const bookTouched = changedKeys.some((k) => shouldNotifyBookMutated(k));
        lastWatch = files;
        await refreshTree(true);
        // 当前文件被外部改且本地不脏 → 自动重载
        if (openPath && files[openPath] && files[openPath] !== openMtime && !dirty) {
          await openFile(openPath);
          setStatus(`外部更新已同步 · ${openPath}`, "ok");
        } else if (openPath && files[openPath] && files[openPath] !== openMtime && dirty) {
          setStatus(`磁盘已变且本地未保存 · ${openPath}`, "warn");
        } else {
          setStatus("文件树已更新（磁盘变化）", "ok");
        }
        // P0-4：生成中不 notifyBookMutated（避免覆盖流式正文）；树刷新已在上方完成
        if (bookTouched && !isGenLocked()) {
          await notifyBookMutated();
        } else if (bookTouched && isGenLocked()) {
          setStatus("生成中，跳过工程重载（树已刷新）", "warn");
        }
      }
    } catch (_) {
      /* ignore transient */
    }
  }

  function startWatch() {
    stopWatch();
    scheduleWatch(pollIntervalMs || 800);
    // 立即扫一次
    pollWatch();
  }
  function stopWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  function onVisibilityOrFocus() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (!document.getElementById("view-workspace")?.classList.contains("active")) return;
    pollWatch();
  }

  async function bindBook(nextSlug, opts = {}) {
    editRevisions.bump();
    slug = nextSlug || "";
    openPath = "";
    selectedPath = "";
    selectedKind = "";
    dirty = false;
    lastEpoch = null;
    epochSkipCount = 0;
    lastWatch = {};
    if ($("wsEditor")) $("wsEditor").value = "";
    if ($("wsPreview")) $("wsPreview").innerHTML = "";
    if ($("wsFilePath")) $("wsFilePath").textContent = "未打开文件";
    if ($("wsFileMeta")) {
      $("wsFileMeta").dataset.fileDetails = "";
      $("wsFileMeta").textContent = "";
    }
    syncReadOnly();
    if (!slug) {
      if ($("wsTree")) $("wsTree").innerHTML = "";
      treeData = null;
      setStatus("请先选择一本书", "warn");
      stopWatch();
      return;
    }
    await refreshTree();
    startWatch();
    // 自动打开 README 或第一章
    if (opts.autoOpen !== false) {
      const prefer =
        findFile(treeData?.tree, (n) => n.name === "README.md") ||
        findFile(treeData?.tree, (n) => n.path.startsWith("章节/") && n.ext === ".md");
      if (prefer) await openFile(prefer.path);
    }
  }

  function findFile(nodes, pred) {
    for (const n of nodes || []) {
      if (n.type === "file" && pred(n)) return n;
      if (n.type === "dir") {
        const hit = findFile(n.children, pred);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** 树中是否已有 path（file 或 dir） */
  function pathExistsInTree(nodes, path) {
    const target = String(path || "");
    if (!target) return false;
    for (const n of nodes || []) {
      if (n.path === target) return true;
      if (n.type === "dir" && n.children?.length) {
        if (pathExistsInTree(n.children, target)) return true;
      }
    }
    return false;
  }

  function init(hooks = {}) {
    onStatus = hooks.onStatus || onStatus;
    onBookMutated = hooks.onBookMutated || null;

    $("btnWsToggleFiles")?.addEventListener("click", () => {
      const layout = document.querySelector("#view-workspace .ws-layout");
      setFilesDrawer(!layout?.classList.contains("files-open"));
    });
    $("wsFilesScrim")?.addEventListener("click", () => setFilesDrawer(false, { restoreFocus: true }));
    window.addEventListener("resize", syncFilesDrawerAccessibility);
    syncFilesDrawerAccessibility();

    $("wsEditor")?.addEventListener("input", () => {
      const readOnlyReason = workspaceReadOnlyReason();
      if (readOnlyReason) {
        setStatus(readOnlyReason.message, "warn");
        syncReadOnly();
        return;
      }
      editRevisions.bump();
      dirty = true;
      schedulePreview();
      setStatus(`未保存 · ${openPath || ""}`, "warn");
    });

    $("btnWsSave")?.addEventListener("click", () => {
      void saveCurrent().catch(() => {});
    });
    $("btnWsReload")?.addEventListener("click", async () => {
      if (dirty && !confirm("丢弃未保存修改并重载？")) return;
      if (openPath) await openFile(openPath);
      else await refreshTree();
    });
    $("btnWsReveal")?.addEventListener("click", async () => {
      if (!slug) {
        alert("请先选择一本书");
        return;
      }
      try {
        setStatus("打开资源管理器…", "busy");
        // 优先打开当前文件（或选中项），否则打开书根目录
        const rel = openPath || selectedPath || "";
        if (rel) {
          try {
            await Vault().reveal(`books/${slug}/${String(rel).replace(/^\/+/, "")}`);
            setStatus(`已打开 · ${rel}`, "ok");
            return;
          } catch (e1) {
            console.warn("reveal rel failed, fallback book", e1);
          }
        }
        await Vault().revealBook(slug);
        setStatus(`已打开书目录 · ${slug}`, "ok");
      } catch (e) {
        setStatus("打开失败", "err");
        alert("打开资源管理器失败: " + (e.message || e));
      }
    });
    $("btnWsRefreshTree")?.addEventListener("click", async () => {
      if (!slug) {
        alert("请先选择一本书");
        return;
      }
      try {
        setStatus("刷新文件树…", "busy");
        await refreshTree(true);
        setStatus("文件树已刷新", "ok");
      } catch (e) {
        setStatus("刷新失败", "err");
        alert("刷新失败: " + (e.message || e));
      }
    });

    $("btnWsNewNote")?.addEventListener("click", () => newNote());
    $("btnWsNewFolder")?.addEventListener("click", () => newFolder());
    $("btnWsRename")?.addEventListener("click", () => renameSelected());
    $("btnWsDelete")?.addEventListener("click", () => deleteSelected());
    $("btnWsSnapshots")?.addEventListener("click", () => showSnapshots());
    $("btnCloseSnapshots")?.addEventListener("click", () => closeSnapshotModal());
    $("snapshotModal")?.addEventListener("click", (e) => {
      if (e.target === $("snapshotModal")) closeSnapshotModal();
    });

    document.querySelectorAll("[data-split]").forEach((b) => {
      b.addEventListener("click", () => {
        splitMode = b.dataset.split;
        applySplit();
      });
      b.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const tabs = [...document.querySelectorAll("[data-split]")];
        const index = tabs.indexOf(b);
        const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        splitMode = next.dataset.split;
        applySplit();
        next.focus();
      });
    });
    applySplit();

    document.addEventListener("keydown", (e) => {
      if (!document.getElementById("view-workspace")?.classList.contains("active")) return;
      if (e.key === "Escape") {
        hideCtxMenu();
        const layout = document.querySelector("#view-workspace .ws-layout");
        if (layout?.classList.contains("files-open")) setFilesDrawer(false, { restoreFocus: true });
      }
    });

    // 点击别处关闭右键菜单
    document.addEventListener("click", (e) => {
      if (ctxMenuEl && !ctxMenuEl.contains(e.target)) hideCtxMenu();
    });
    document.addEventListener(
      "contextmenu",
      (e) => {
        if (ctxMenuEl && !ctxMenuEl.contains(e.target) && !e.target.closest?.(".ws-row")) {
          hideCtxMenu();
        }
      },
      true
    );
    window.addEventListener("blur", hideCtxMenu);
    window.addEventListener("scroll", hideCtxMenu, true);

    // focus / 可见时立即 poll，外部改文件更快反映
    window.addEventListener("focus", onVisibilityOrFocus);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    syncReadOnly();
  }

  function isDirty() {
    return dirty;
  }

  function markClean(snapshot) {
    if (snapshot && !saveStateIsCurrent(snapshot)) return false;
    dirty = false;
    return true;
  }

  return {
    init,
    bindBook,
    refreshTree,
    openFile,
    saveCurrent,
    startWatch,
    stopWatch,
    pollWatch,
    isDirty,
    markClean,
    captureSaveState,
    syncReadOnly,
    generatedMirrorInfo,
    showSnapshots,
    newNote,
    newFolder,
    renameSelected,
    deleteSelected,
    getOpenPath: () => openPath,
    getSelectedPath: () => selectedPath,
    getSlug: () => slug,
  };
})();
