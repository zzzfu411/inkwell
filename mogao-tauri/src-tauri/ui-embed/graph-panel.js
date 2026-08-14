/**
 * 关系图面板的纯取数层。
 *
 * 负责：节点 id 归一、按选中人物收缩子图、把边上的章节名排成故事顺序、
 * 以及把人物档案和关系演化整理成视图模型。
 * 绘制交给 graph-view.js，DOM 交给 app.js。
 */
(function () {
  const EDGE_LIMIT = 200;
  const TRACK_LIMIT = 40;

  function nodeId(value) {
    return String(value?.id ?? value ?? "").trim();
  }

  function normalizeTitle(value) {
    return String(value || "")
      .replace(/\s+/g, "")
      .toLocaleLowerCase("zh-CN");
  }

  /** 只保留与选中人物直接相连的边，避免大书里一屏几百条线。 */
  function subgraphForNode(graph, selectedId) {
    const id = nodeId(selectedId);
    if (!id) return graph;
    const edges = (graph?.edges || []).filter(
      (edge) => nodeId(edge.source) === id || nodeId(edge.target) === id
    );
    const ids = new Set([id]);
    for (const edge of edges) {
      ids.add(nodeId(edge.source));
      ids.add(nodeId(edge.target));
    }
    return {
      nodes: (graph?.nodes || []).filter((node) => ids.has(nodeId(node))),
      edges,
    };
  }

  /**
   * 边上的 chapter 是模型写的自由文本，可能是「第三章」也可能是章节标题。
   * 先按书里的章节标题匹配，再退回「第 N 章」数字，最后按出现次序兜底。
   */
  function chapterList(project, graph) {
    const names = [
      ...new Set((graph?.edges || []).map((edge) => String(edge.chapter || "").trim()).filter(Boolean)),
    ];
    const chapters = (project?.chapters || [])
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const rank = (name, fallback) => {
      const normalized = normalizeTitle(name);
      for (let index = 0; index < chapters.length; index++) {
        const chapter = chapters[index];
        const title = normalizeTitle(chapter.title);
        const order = Number(chapter.order) || index + 1;
        if (title && (normalized === title || normalized.includes(title) || title.includes(normalized))) {
          return order;
        }
        if (normalized.includes(`第${order}章`)) return order;
      }
      const match = normalized.match(/第\s*(\d+)\s*章/);
      return match ? Number(match[1]) : 100000 + fallback;
    };
    return names
      .map((name, index) => ({ name, rank: rank(name, index), index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((item) => item.name);
  }

  function label(value, fallback = "") {
    return String(value?.label ?? value ?? fallback);
  }

  /** 关系表：把 source/target 换成人物显示名，并合并重复出现次数。 */
  function buildEdgeRows(scopedGraph, filteredGraph) {
    const findNode = (ref) =>
      (filteredGraph?.nodes || []).find((node) => nodeId(node) === nodeId(ref));
    return (scopedGraph?.edges || []).slice(0, EDGE_LIMIT).map((edge) => {
      const occurrence = Number(edge.occurrence) || 1;
      return {
        source: label(findNode(edge.source), nodeId(edge.source)),
        target: label(findNode(edge.target), nodeId(edge.target)),
        relationship: String(edge.relationship || edge.label || ""),
        evidence: String(edge.chapter || edge.note || edge.evidence || "未标注"),
        occurrence,
      };
    });
  }

  function buildNodeButtons(filteredGraph, selectedId, labelType) {
    const selected = nodeId(selectedId);
    return (filteredGraph?.nodes || []).map((node) => {
      const role = node.role || (node.type ? labelType(node.type) : "");
      return {
        id: node.id,
        active: nodeId(node) === selected,
        text: role ? `${node.label || node.id} · ${role}` : String(node.label || node.id),
      };
    });
  }

  /** 关系演化有两种返回形状：分组的 groups，或平铺的数组。这里统一成一种。 */
  function buildTracks(tracks, selectedId) {
    if (!tracks) return null;
    const id = nodeId(selectedId);
    const hit = (track) => !id || nodeId(track.source) === id || nodeId(track.target) === id;
    const groups = (tracks.groups || []).filter(hit);
    if (groups.length) {
      return {
        kind: "grouped",
        groups: groups.slice(0, TRACK_LIMIT).map((track) => ({
          title: String(track.pairLabel || track.pair || "人物关系"),
          events: (track.entries || []).map((entry) => ({
            chapter: String(entry.chapter || "未标注章节"),
            label: String(entry.label || entry.relationship || "关系更新"),
          })),
        })),
      };
    }
    const flat = (Array.isArray(tracks) ? tracks : []).filter(hit);
    if (!flat.length) return { kind: "empty", scoped: Boolean(id), groups: [] };
    return {
      kind: "flat",
      groups: flat.slice(0, TRACK_LIMIT).map((track) => ({
        source: label(track.source),
        target: label(track.target),
        label: String(track.label || track.relationship || ""),
        chapter: String(track.chapter || ""),
      })),
    };
  }

  function statsLine(stats, filteredGraph, chapters, selectedNode) {
    const characters = stats?.characters ?? stats?.nodes ?? (filteredGraph?.nodes || []).length;
    const relationships = stats?.relationships ?? stats?.edges ?? (filteredGraph?.edges || []).length;
    const chapterCount = stats?.chapters ?? chapters.length;
    const selected = selectedNode ? ` · 已选 ${selectedNode.label || selectedNode.id}` : "";
    return `人物 ${characters} · 关系 ${relationships} · 章节 ${chapterCount}${selected}`;
  }

  window.NOVEL_GRAPH_PANEL = {
    EDGE_LIMIT,
    TRACK_LIMIT,
    nodeId,
    subgraphForNode,
    chapterList,
    buildEdgeRows,
    buildNodeButtons,
    buildTracks,
    statsLine,
  };
})();
