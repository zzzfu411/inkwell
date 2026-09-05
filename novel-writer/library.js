/** 书库操作：列表渲染、切换、删书、重命名、外部 mtime 检测 */
window.NOVEL_LIBRARY = (() => {
  const Vault = () => window.NOVEL_VAULT;

  function renderSidebar(books, activeSlug, { onSelect, onOpen, onDelete, onRename } = {}) {
    const el = document.getElementById("libraryList");
    if (!el) return;
    el.innerHTML = "";
    if (!books?.length) {
      el.innerHTML = `<li class="lib-empty">书库为空<br/><span>新建作品后会显示在这里</span></li>`;
      return;
    }
    // P1-8：生成锁期间侧栏按钮 disabled
    const locked = !!(window.__mogaoGen?.locked);
    books.forEach((b) => {
      const li = document.createElement("li");
      const active = b.slug === activeSlug;
      li.className = "lib-item" + (active ? " active" : "");
      li.innerHTML = `
        <button type="button" class="lib-main" data-slug="${escapeAttr(b.slug)}"${locked ? " disabled" : ""}>
          <span class="lib-title">${escapeHtml(b.title || b.slug)}</span>
          <span class="lib-meta">${escapeHtml(b.chapters || 0)} 章 · ${escapeHtml(b.stage || "—")}</span>
        </button>
        <div class="lib-ops">
          <button type="button" class="lib-op" data-act="open" aria-label="打开目录" title="打开目录"${locked ? " disabled" : ""}><span class="ui-icon icon-folder-open" aria-hidden="true"></span></button>
          <button type="button" class="lib-op" data-act="rename" aria-label="重命名" title="重命名"${locked ? " disabled" : ""}><span class="ui-icon icon-write" aria-hidden="true"></span></button>
          <button type="button" class="lib-op danger" data-act="del" aria-label="删除" title="删除"${locked ? " disabled" : ""}><span class="ui-icon icon-trash" aria-hidden="true"></span></button>
        </div>`;
      if (!locked) {
        li.querySelector(".lib-main").addEventListener("click", () => onSelect?.(b.slug));
        li.querySelector('[data-act="open"]').addEventListener("click", (e) => {
          e.stopPropagation();
          onOpen?.(b.slug);
        });
        li.querySelector('[data-act="rename"]').addEventListener("click", (e) => {
          e.stopPropagation();
          onRename?.(b.slug, b.title);
        });
        li.querySelector('[data-act="del"]').addEventListener("click", (e) => {
          e.stopPropagation();
          onDelete?.(b.slug, b.title);
        });
      }
      el.appendChild(li);
    });
  }

  function buildSidebarModel(libraryBooks, projects, query, vaultOnline) {
    const allBooks = (
      Array.isArray(libraryBooks) && libraryBooks.length
        ? libraryBooks.slice()
        : (projects || []).map((project) => ({
            slug: project.slug,
            title: project.title,
            chapters: (project.chapters || []).length,
            stage: project.stage,
          }))
    ).filter((book) => String(book?.slug || "").trim());
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const books = normalizedQuery
      ? allBooks.filter((book) =>
          [book.title, book.slug].some((value) =>
            String(value || "").toLowerCase().includes(normalizedQuery)
          )
        )
      : allBooks.slice();
    const filteredEmpty = Boolean(normalizedQuery && allBooks.length && !books.length);
    return {
      books,
      query: normalizedQuery,
      clearList: !vaultOnline && !books.length,
      empty: {
        hidden: books.length > 0,
        filtered: filteredEmpty,
        kicker: filteredEmpty ? "没有匹配的作品" : "还没有可写的作品",
        title: filteredEmpty ? "换一个关键词，或清除当前筛选。" : "建立一本新书，或连接已有书库。",
        hint: filteredEmpty
          ? `未找到“${normalizedQuery}”`
          : vaultOnline
            ? "新书会安全写入当前本地书库。"
            : "本地服务未连接。浏览器缓存只能临时保留本机草稿，文件、快照、导入导出和跨书搜索暂不可用。",
      },
    };
  }

  function renderSidebarState(model) {
    const empty = document.getElementById("libraryEmptyState");
    if (empty) {
      empty.hidden = model.empty.hidden;
      const kicker = document.getElementById("libraryEmptyKicker");
      const title = document.getElementById("libraryEmptyTitle");
      const hint = document.getElementById("libraryEmptyHint");
      if (kicker) kicker.textContent = model.empty.kicker;
      if (title) title.textContent = model.empty.title;
      if (hint) hint.textContent = model.empty.hint;
      empty.querySelectorAll("[data-library-action]").forEach((button) => {
        button.hidden = model.empty.filtered
          ? button.dataset.libraryAction !== "clear"
          : button.dataset.libraryAction === "clear";
      });
    }
    if (model.clearList) document.getElementById("libraryList")?.replaceChildren();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  async function fetchMeta(slug) {
    return Vault().req
      ? Vault().req("GET", `/api/books/${encodeURIComponent(slug)}/meta`)
      : fetch(`/api/books/${encodeURIComponent(slug)}/meta`).then((r) => r.json());
  }

  return { renderSidebar, buildSidebarModel, renderSidebarState, fetchMeta, escapeHtml };
})();
