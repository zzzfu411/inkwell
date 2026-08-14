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

  return { renderSidebar, fetchMeta, escapeHtml };
})();
