/**
 * 叙事图谱模型：合并、画像、时间线、过滤、统计、Mermaid（GOAL-ULTIMATE Phase1）。
 * 思想参考 screenplay-analyzer narrativeModel，运行时不依赖该仓库。
 */
window.NOVEL_NARRATIVE = (() => {
  const UNDIRECTED = new Set([
    "同门", "结盟", "敌对", "情侣", "夫妻", "兄弟", "朋友", "竞争", "合作",
    "结义", "结义兄弟", "对手", "好友", "恋人", "师兄弟", "同门师兄弟",
  ]);

  function normalizeId(value) {
    const id = value && typeof value === "object" ? value.id : value;
    return id === null || id === undefined ? null : String(id);
  }

  function unique(arr) {
    return [...new Set((arr || []).filter((x) => x !== null && x !== undefined && x !== ""))];
  }

  function relationshipLabel(edge) {
    return edge?.relationship ?? edge?.label ?? "";
  }

  function edgeChapter(edge) {
    return typeof edge?.chapter === "string" ? edge.chapter : "";
  }

  function edgeOccurrence(edge) {
    const raw = edge?.occurrence;
    const value = typeof raw === "number" ? raw : parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function summarizeNode(node) {
    return {
      id: String(node.id),
      label: node.label ?? "",
      sect: node.sect ?? "",
      chapter: node.chapter ?? "",
      type: node.type ?? "character",
      role: node.role ?? "",
    };
  }

  /**
   * 边合并键：有 chapter 时纳入；无向关系按 source/target 字典序排序。
   * 键格式：source|target|relationship|chapter
   */
  function edgeKey(edge) {
    const rel = relationshipLabel(edge);
    const ch = edgeChapter(edge);
    let s = String(edge.source ?? "");
    let t = String(edge.target ?? "");
    if (UNDIRECTED.has(rel) || edge.directed === false) {
      if (s > t) [s, t] = [t, s];
    }
    return `${s}|${t}|${rel}|${ch}`;
  }

  /**
   * 合并两张图。
   * - 节点：按 id 合并；aliases 并集；label/sect/role/note 等缺省回填
   * - 边：按 source|target|relationship|chapter（无向排序）合并 occurrence
   */
  function mergeGraphs(base, delta) {
    const g = {
      nodes: [...(base?.nodes || [])].map((n) => ({ ...n, aliases: [...(n.aliases || [])] })),
      edges: [...(base?.edges || [])].map((e) => ({ ...e })),
    };

    const byId = new Map(g.nodes.map((n) => [normalizeId(n.id), n]));

    for (const n of delta?.nodes || []) {
      if (!n?.id && !n?.label) continue;
      const nid = normalizeId(n.id) || `n_${(n.label || "x").replace(/\s+/g, "")}`;
      let hit = byId.get(nid);

      // 别名/同名回落
      if (!hit) {
        for (const ex of g.nodes) {
          const names = new Set([ex.label, ...(ex.aliases || [])].filter(Boolean).map(String));
          if (n.label && names.has(String(n.label))) {
            hit = ex;
            break;
          }
          if ((n.aliases || []).some((a) => names.has(String(a)))) {
            hit = ex;
            break;
          }
        }
      }

      if (hit) {
        hit.aliases = unique([
          ...(hit.aliases || []),
          ...(n.aliases || []),
          n.label,
          hit.label,
        ].filter((x) => x && x !== hit.label));
        hit.sect = hit.sect || n.sect || "";
        hit.note = hit.note || n.note || "";
        hit.role = hit.role || n.role || "";
        hit.type = hit.type || n.type || "character";
        hit.chapter = hit.chapter || n.chapter || "";
        if (n.arc) hit.arc = hit.arc || n.arc;
        if (n.voice) hit.voice = hit.voice || n.voice;
        if (n.want) hit.want = hit.want || n.want;
        if (n.need) hit.need = hit.need || n.need;
      } else {
        const node = {
          ...n,
          id: nid,
          aliases: unique([...(n.aliases || [])]),
          occurrence: n.occurrence || 1,
        };
        g.nodes.push(node);
        byId.set(nid, node);
      }
    }

    const eMap = new Map();
    for (const e of g.edges) {
      eMap.set(edgeKey(e), e);
    }

    for (const e of delta?.edges || []) {
      if (!e?.source || !e?.target) continue;
      const rel = relationshipLabel(e);
      if (!rel) continue;
      const normalized = {
        ...e,
        source: String(e.source),
        target: String(e.target),
        relationship: rel,
        chapter: edgeChapter(e),
        occurrence: edgeOccurrence(e),
      };
      const k = edgeKey(normalized);
      if (eMap.has(k)) {
        const old = eMap.get(k);
        old.occurrence = edgeOccurrence(old) + edgeOccurrence(normalized);
        if (normalized.note && !old.note) old.note = normalized.note;
        if (normalized.evidence && !old.evidence) old.evidence = normalized.evidence;
        if (normalized.phase && !old.phase) old.phase = normalized.phase;
      } else {
        g.edges.push(normalized);
        eMap.set(k, normalized);
      }
    }

    g.stats = graphStats(g);
    return g;
  }

  function buildCharacterProfile(nodes = [], edges = [], selectedId) {
    const normalizedSelectedId = normalizeId(selectedId);
    if (normalizedSelectedId === null) return null;

    const nodeById = new Map(nodes.map((node) => [normalizeId(node.id), node]));
    const selectedNode = nodeById.get(normalizedSelectedId);
    if (!selectedNode) return null;

    const neighbors = [];
    for (const edge of edges) {
      const sourceId = normalizeId(edge.source);
      const targetId = normalizeId(edge.target);
      let neighborId = null;

      if (sourceId === normalizedSelectedId) neighborId = targetId;
      else if (targetId === normalizedSelectedId) neighborId = sourceId;

      const neighbor = nodeById.get(neighborId);
      if (neighbor) {
        neighbors.push({
          ...summarizeNode(neighbor),
          relationship: relationshipLabel(edge),
          chapter: edgeChapter(edge),
          occurrence: edgeOccurrence(edge),
        });
      }
    }

    return {
      ...summarizeNode(selectedNode),
      degree: neighbors.length,
      neighbors,
    };
  }

  /**
   * 按人物对分组的时间线条目。
   * 返回 [{ pairKey, pairLabel, source, target, entries: [{label, chapter, edgeOccurrence, key}] }]
   * 同时扁平 tracks 兼容旧调用：若只关心扁平，可用 .flatMap(t => t.entries...)
   * 为兼容测试与 UI，也直接返回扁平 tracks（带 pair 信息）。
   */
  function buildRelationshipTracks(nodes = [], edges = []) {
    const nodeById = new Map(nodes.map((node) => [normalizeId(node.id), node]));
    const pairMap = new Map(); // pairKey -> track group
    const occurrenceBySignature = new Map();
    const flat = [];

    for (const edge of edges) {
      const sourceId = normalizeId(edge.source);
      const targetId = normalizeId(edge.target);
      const source = nodeById.get(sourceId);
      const target = nodeById.get(targetId);
      if (!source || !target) continue;

      const label = relationshipLabel(edge);
      const [a, b] = [sourceId, targetId].sort();
      const pairKey = `${a}|${b}`;
      const pairLabel = [source.label || sourceId, target.label || targetId].sort().join(" · ");

      const signature = JSON.stringify([sourceId, targetId, label]);
      const occurrence = occurrenceBySignature.get(signature) ?? 0;
      occurrenceBySignature.set(signature, occurrence + 1);

      const entry = {
        key: JSON.stringify([sourceId, targetId, label, occurrence]),
        source: summarizeNode(source),
        target: summarizeNode(target),
        label,
        chapter: edgeChapter(edge),
        edgeOccurrence: edgeOccurrence(edge),
        pairKey,
        pairLabel,
      };
      flat.push(entry);

      if (!pairMap.has(pairKey)) {
        pairMap.set(pairKey, {
          pairKey,
          pairLabel,
          source: summarizeNode(source),
          target: summarizeNode(target),
          entries: [],
        });
      }
      pairMap.get(pairKey).entries.push(entry);
    }

    // 附加分组视图，主返回仍为扁平（与 ref narrativeModel 一致），便于 degree/timeline 测试
    flat.groups = [...pairMap.values()];
    return flat;
  }

  /**
   * 过滤图谱。
   * @param {{minOccurrence?, chapterFrom?, chapterTo?, chapterList?}} opts
   *   - minOccurrence: 边 occurrence 下限
   *   - chapterFrom/To: 1-based 章节序号（配合 chapterList 映射）
   *   - chapterList: [{chapter, start}] 或 string[] 章节名列表
   */
  function filterGraph(graph, opts = {}) {
    const nodes = graph?.nodes || [];
    let edges = [...(graph?.edges || [])];

    const minOcc = Number(opts.minOccurrence);
    if (Number.isFinite(minOcc) && minOcc > 0) {
      edges = edges.filter((e) => edgeOccurrence(e) >= minOcc);
    }

    // 章节白名单（字符串列表）
    if (Array.isArray(opts.chapterList) && opts.chapterList.length > 0 && opts.chapterList.every((x) => typeof x === "string")) {
      const allow = new Set(opts.chapterList.map((s) => s.trim()).filter(Boolean));
      edges = edges.filter((e) => allow.has(edgeChapter(e)));
    }

    // 章节序号范围
    const fromRaw = Number(opts.chapterFrom);
    const toRaw = Number(opts.chapterTo);
    const from = Number.isFinite(fromRaw) && fromRaw >= 1 ? Math.floor(fromRaw) : 0;
    const to = Number.isFinite(toRaw) && toRaw >= 1 ? Math.floor(toRaw) : 0;

    if (from || to) {
      const ranges = Array.isArray(opts.chapterList)
        ? opts.chapterList.map((r, i) =>
            typeof r === "string" ? { chapter: r, start: i } : r
          )
        : [];
      if (ranges.length > 0) {
        const chapterToIndex = new Map();
        ranges.forEach((r, i) => {
          const name = typeof r === "string" ? r : r?.chapter;
          if (typeof name === "string" && name && !chapterToIndex.has(name)) {
            chapterToIndex.set(name, i + 1);
          }
        });
        edges = edges.filter((edge) => {
          const ch = edgeChapter(edge);
          if (!ch) return false;
          const idx = chapterToIndex.get(ch);
          if (!idx) return false;
          if (from && idx < from) return false;
          if (to && idx > to) return false;
          return true;
        });
      }
    }

    // 仅保留被边引用的节点（可选：保留全部节点更稳，这里保留引用 + 原节点全集供 profile）
    const referenced = new Set();
    for (const e of edges) {
      if (e.source != null) referenced.add(String(e.source));
      if (e.target != null) referenced.add(String(e.target));
    }
    const keptNodes =
      referenced.size > 0
        ? nodes.filter((n) => referenced.has(String(n.id)))
        : minOcc || from || to
          ? []
          : nodes.slice();

    const out = { nodes: keptNodes, edges };
    out.stats = graphStats(out);
    return out;
  }

  function graphStats(graph) {
    const nodes = graph?.nodes || [];
    const edges = graph?.edges || [];
    const chapters = new Set();
    for (const n of nodes) {
      if (typeof n.chapter === "string" && n.chapter.trim()) chapters.add(n.chapter.trim());
    }
    for (const e of edges) {
      if (typeof e.chapter === "string" && e.chapter.trim()) chapters.add(e.chapter.trim());
    }
    const multi = edges.filter((e) => edgeOccurrence(e) > 1).length;
    return {
      characters: nodes.filter((n) => !n.type || n.type === "character").length,
      nodes: nodes.length,
      relationships: edges.length,
      edges: edges.length,
      multiOccurrenceEdges: multi,
      chapters: chapters.size,
      chapterList: [...chapters],
    };
  }

  function toMermaid(graph, limit = 24) {
    const nodes = (graph?.nodes || []).slice(0, limit);
    const ids = new Set(nodes.map((n) => String(n.id)));
    const edges = (graph?.edges || [])
      .filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)))
      .slice(0, 40);
    const lines = ["graph LR"];
    for (const n of nodes) {
      const label = String(n.label || n.id).replace(/"/g, "'");
      const safeId = String(n.id).replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, "_");
      lines.push(`  ${safeId}["${label}"]`);
    }
    for (const e of edges) {
      const rel = relationshipLabel(e).replace(/"/g, "'");
      const s = String(e.source).replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, "_");
      const t = String(e.target).replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, "_");
      const occ = edgeOccurrence(e);
      const lab = occ > 1 ? `${rel}×${occ}` : rel;
      lines.push(`  ${s} -->|"${lab}"| ${t}`);
    }
    return lines.join("\n");
  }

  return {
    mergeGraphs,
    buildCharacterProfile,
    buildRelationshipTracks,
    filterGraph,
    graphStats,
    toMermaid,
    // helpers exposed for tests / advanced use
    edgeKey,
    edgeOccurrence,
    edgeChapter,
    normalizeId,
  };
})();
