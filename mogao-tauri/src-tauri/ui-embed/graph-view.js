/**
 * Inkwell relationship constellation.
 * Layout is pure; render() writes into a host element.
 */
window.NOVEL_GRAPH_VIEW = (() => {
  "use strict";

  const MAX_VISIBLE_NODES = 36;

  function nodeId(value) {
    if (value && typeof value === "object") return String(value.id || "").trim();
    return String(value ?? "").trim();
  }

  function nodeLabel(node) {
    return String(node?.label || node?.id || "未命名").trim() || "未命名";
  }

  function degreeMap(graph) {
    const degrees = new Map();
    for (const node of graph.nodes || []) degrees.set(nodeId(node), 0);
    for (const edge of graph.edges || []) {
      const source = nodeId(edge.source);
      const target = nodeId(edge.target);
      if (source) degrees.set(source, (degrees.get(source) || 0) + 1);
      if (target) degrees.set(target, (degrees.get(target) || 0) + 1);
    }
    return degrees;
  }

  function pickVisibleNodes(graph) {
    const degrees = degreeMap(graph);
    const nodes = [...(graph.nodes || [])];
    if (nodes.length <= MAX_VISIBLE_NODES) return { nodes, truncated: 0, degrees };
    const ranked = nodes
      .map((node, index) => ({
        node,
        index,
        degree: degrees.get(nodeId(node)) || 0,
      }))
      .sort((a, b) => b.degree - a.degree || a.index - b.index);
    const kept = ranked.slice(0, MAX_VISIBLE_NODES).map((item) => item.node);
    return { nodes: kept, truncated: nodes.length - kept.length, degrees };
  }

  function visibleEdges(graph, visibleIds) {
    return (graph.edges || []).filter((edge) => {
      const source = nodeId(edge.source);
      const target = nodeId(edge.target);
      return source && target && source !== target && visibleIds.has(source) && visibleIds.has(target);
    });
  }

  /**
   * Place nodes on an ellipse. 1 node centered, 2 nodes split left/right.
   */
  function layoutNodes(nodes, size = {}) {
    const width = Math.max(240, Number(size.width) || 640);
    const height = Math.max(180, Number(size.height) || 360);
    const cx = width / 2;
    const cy = height / 2;
    const list = Array.isArray(nodes) ? nodes : [];
    if (!list.length) return [];
    if (list.length === 1) {
      return [{ id: nodeId(list[0]), x: cx, y: cy, node: list[0] }];
    }
    if (list.length === 2) {
      const span = Math.min(width * 0.28, 140);
      return [
        { id: nodeId(list[0]), x: cx - span, y: cy, node: list[0] },
        { id: nodeId(list[1]), x: cx + span, y: cy, node: list[1] },
      ];
    }
    const rx = width * 0.38;
    const ry = height * 0.34;
    return list.map((node, index) => {
      const angle = (Math.PI * 2 * index) / list.length - Math.PI / 2;
      return {
        id: nodeId(node),
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle),
        node,
      };
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function edgePath(from, to, cx, cy) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const pull = Math.min(48, length * 0.18);
    const nx = -dy / length;
    const ny = dx / length;
    const towardCenter = (cx - mx) * nx + (cy - my) * ny;
    const side = towardCenter >= 0 ? -1 : 1;
    const qx = mx + nx * pull * side;
    const qy = my + ny * pull * side;
    return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
  }

  function render(el, graph, opts = {}) {
    if (!el) return { visible: 0, truncated: 0 };
    const host = el;
    const width = Math.max(280, host.clientWidth || opts.width || 640);
    const height = Math.max(220, Number(opts.height) || 360);
    const selectedId = nodeId(opts.selectedId);
    const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
    const picked = pickVisibleNodes(graph || { nodes: [], edges: [] });
    const placed = layoutNodes(picked.nodes, { width, height });
    const byId = new Map(placed.map((item) => [item.id, item]));
    const ids = new Set(byId.keys());
    const edges = visibleEdges(graph || {}, ids);

    host.classList.add("graph-constellation");
    host.style.minHeight = `${height}px`;
    host.replaceChildren();

    if (!placed.length) {
      host.innerHTML = `<div class="graph-empty"><span class="empty-kicker">关系星图</span><strong>还没有可绘制的人物</strong><p>写几章并交接，或在分析页抽取关系后，名字会围坐在这里。</p></div>`;
      return { visible: 0, truncated: picked.truncated };
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "presentation");
    svg.classList.add("graph-constellation-svg");

    for (const edge of edges) {
      const from = byId.get(nodeId(edge.source));
      const to = byId.get(nodeId(edge.target));
      if (!from || !to) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", edgePath(from, to, width / 2, height / 2));
      path.setAttribute("class", "graph-edge");
      if (selectedId && (from.id === selectedId || to.id === selectedId)) {
        path.classList.add("is-active");
      }
      svg.appendChild(path);
    }
    host.appendChild(svg);

    for (const item of placed) {
      const degree = picked.degrees.get(item.id) || 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "graph-star" + (item.id === selectedId ? " is-selected" : "");
      button.style.left = `${(item.x / width) * 100}%`;
      button.style.top = `${(item.y / height) * 100}%`;
      button.dataset.nodeId = item.id;
      button.setAttribute("aria-pressed", item.id === selectedId ? "true" : "false");
      button.title = `${nodeLabel(item.node)} · ${degree} 条关系`;
      button.innerHTML = `<span class="graph-star-name">${escapeHtml(nodeLabel(item.node))}</span><span class="graph-star-meta">${degree}</span>`;
      button.addEventListener("click", () => {
        onSelect?.(item.node);
      });
      host.appendChild(button);
    }

    if (picked.truncated > 0) {
      const note = document.createElement("p");
      note.className = "graph-truncate-note";
      note.textContent = `星图只画出度数最高的 ${MAX_VISIBLE_NODES} 人，其余 ${picked.truncated} 人仍在右侧名单。`;
      host.appendChild(note);
    }

    return { visible: placed.length, truncated: picked.truncated };
  }

  return {
    MAX_VISIBLE_NODES,
    nodeId,
    degreeMap,
    pickVisibleNodes,
    layoutNodes,
    render,
  };
})();
