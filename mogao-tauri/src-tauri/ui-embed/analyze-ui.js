/**
 * 叙事分析工作台 UI。
 * 切章预览 · 长任务分析 · 进度续跑 · 图谱筛选 · 档案 · 时间线
 */
window.NOVEL_ANALYZE_UI = (() => {
  const $ = (id) => document.getElementById(id);
  let deps = {};
  let running = false;
  let lastMeta = null;
  let displayGraph = null;
  let selectedNodeId = null;
  let checkpointGraph = null;
  let checkpointChunks = null;
  let checkpointSlug = null;
  let checkpointLoadPromise = null;
  let analysisWriter = null;
  function writeAnalysisFile(slug, path, content) {
    return analysisWriter?.slug === slug
      ? analysisWriter.write(path, content)
      : Vault().writeFile(slug, path, content);
  }
  const ANALYSIS_STATUS_LABELS = Object.freeze({
    idle: "等待识别",
    detected: "识别完成",
    running: "正在分析",
    finalizing: "正在聚合结果",
    done: "分析完成",
    partial: "部分完成 · 可续跑",
    paused: "已暂停",
    aborted: "已中止 · 可续跑",
    failed: "分析失败",
    persistence_error: "聚合失败 · 结果待保存",
  });

  function analysisStatusLabel(status) {
    const key = String(status || "idle");
    return ANALYSIS_STATUS_LABELS[key] || "状态待确认";
  }

  function Split() {
    return window.NOVEL_CHAPTER_SPLIT;
  }
  function Narr() {
    return window.NOVEL_NARRATIVE;
  }
  function Analysis() {
    return window.NOVEL_ANALYSIS;
  }
  function Vault() {
    return window.NOVEL_VAULT;
  }

  function setStatus(msg, kind) {
    if (typeof deps.setStatus === "function") deps.setStatus(msg, kind);
    const el = $("anStatus");
    if (el) {
      el.textContent = msg || "";
      el.className = "an-status" + (kind ? ` ${kind}` : "");
      el.setAttribute("aria-live", kind === "err" ? "assertive" : "polite");
      el.setAttribute("aria-busy", kind === "busy" ? "true" : "false");
    }
  }

  function project() {
    return typeof deps.project === "function" ? deps.project() : null;
  }

  function cfg() {
    return typeof deps.getCfg === "function" ? deps.getCfg() : window.NOVEL_STORE?.loadCfg?.() || {};
  }

  /** 从当前书章节拼接全文 */
  function textFromProject(p) {
    const chs = (p?.chapters || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!chs.length) return "";
    return chs
      .map((c) => {
        const title = c.title || `第${c.order || "?"}章`;
        const body = String(c.body || "").trim();
        return `第${c.order || ""}章 ${title}\n\n${body}`;
      })
      .join("\n\n");
  }

  function getSourceText() {
    const src = $("anSourceText")?.value || "";
    if (src.trim()) return src;
    return textFromProject(project());
  }

  function renderChapterPreview(text) {
    const el = $("anChapterList");
    if (!el) return;
    const S = Split();
    if (!S) {
      el.innerHTML = "<li>切章模块未加载</li>";
      if (!running && $("anProgressLabel")) $("anProgressLabel").textContent = "识别不可用 · 请检查切章模块";
      return;
    }
    const ranges = S.detectChapterRanges(text);
    const list =
      ranges.length > 0
        ? ranges
        : S.buildChapterList?.(text, { chunkSize: 3000 }) || [];
    if (!list.length) {
      el.innerHTML = "<li class='muted'>未识别到章节（将按字数虚拟分块）</li>";
      if (!running && $("anProgressLabel")) $("anProgressLabel").textContent = "识别完成 · 将按字数分块";
      if (!running && $("anSummaryStatus")) $("anSummaryStatus").textContent = "章节已识别";
      return;
    }
    el.innerHTML = list
      .map((r, i) => {
        const title = r.chapter || r.title || `段${i + 1}`;
        const start = r.start != null ? r.start : "";
        return `<li><span class="an-ch-title">${escapeHtml(title)}</span><span class="an-ch-meta">@${start}</span></li>`;
      })
      .join("");
    if (!running && $("anProgressLabel")) $("anProgressLabel").textContent = `识别完成 · ${list.length} 个章节范围`;
    if (!running && $("anSummaryStatus")) $("anSummaryStatus").textContent = "章节已识别";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateProgress(meta) {
    lastMeta = meta;
    const bar = $("anProgressBar");
    const lab = $("anProgressLabel");
    const total = Math.max(1, meta?.total_chunks || 1);
    const done = Array.isArray(meta?.completed_chunks)
      ? meta.completed_chunks.length
      : (meta?.last_completed ?? -1) + 1;
    const pct = Math.min(100, Math.round((done / total) * 100));
    if (bar) bar.style.width = `${pct}%`;
    if (lab)
      lab.textContent = `${analysisStatusLabel(meta?.status)} · ${done}/${meta?.total_chunks || 0} 块` +
        (meta?.failed_chunks?.length ? ` · 失败 ${meta.failed_chunks.length}` : "");
    renderAnalysisSummary(displayGraph || project()?.graph || { nodes: [], edges: [] }, meta);
  }

  function applyFilterAndRender() {
    const N = Narr();
    const p = project();
    let g = displayGraph || p?.graph || { nodes: [], edges: [] };
    if (N?.filterGraph) {
      const minOcc = Number($("anMinOcc")?.value || 1);
      const chFrom = $("anChapFrom")?.value?.trim() || "";
      const chTo = $("anChapTo")?.value?.trim() || "";
      g = N.filterGraph(g, {
        minOccurrence: minOcc,
        chapterFrom: chFrom || undefined,
        chapterTo: chTo || undefined,
      });
    }
    renderGraphPanels(g);
  }

  function nodeId(value) {
    return String(value?.id ?? value ?? "").trim();
  }

  function graphForSelectedEntity(graph, selectedId) {
    const id = nodeId(selectedId);
    if (!id) return graph;
    const edges = (graph?.edges || []).filter(
      (edge) => nodeId(edge.source) === id || nodeId(edge.target) === id
    );
    const visibleIds = new Set([id]);
    for (const edge of edges) {
      visibleIds.add(nodeId(edge.source));
      visibleIds.add(nodeId(edge.target));
    }
    return {
      nodes: (graph?.nodes || []).filter((node) => visibleIds.has(nodeId(node))),
      edges,
    };
  }

  function renderAnalysisSummary(graph, meta) {
    const N = Narr();
    const stats = N?.graphStats?.(graph) || {};
    const total = Number(meta?.total_chunks) || 0;
    const done = Array.isArray(meta?.completed_chunks)
      ? meta.completed_chunks.length
      : Math.max(0, Number(meta?.last_completed ?? -1) + 1);
    if ($("anSummaryStatus")) {
      $("anSummaryStatus").textContent = analysisStatusLabel(meta?.status);
    }
    if ($("anSummaryChunks")) $("anSummaryChunks").textContent = `${done} / ${total}`;
    if ($("anSummaryCharacters")) {
      $("anSummaryCharacters").textContent = String(stats.characters ?? stats.nodes ?? (graph?.nodes || []).length);
    }
    if ($("anSummaryRelations")) {
      $("anSummaryRelations").textContent = String(stats.relationships ?? stats.edges ?? (graph?.edges || []).length);
    }
  }

  function renderGraphPanels(g) {
    const N = Narr();
    const nodes = g.nodes || [];
    if (selectedNodeId && !nodes.some((node) => nodeId(node) === nodeId(selectedNodeId))) {
      selectedNodeId = null;
    }
    const selectedNode = nodes.find((node) => nodeId(node) === nodeId(selectedNodeId));
    const scopedGraph = graphForSelectedEntity(g, selectedNodeId);
    const stats = N?.graphStats?.(g) || {
      characters: nodes.length,
      relationships: (g.edges || []).length,
    };
    const st = $("anGraphStats");
    if (st)
      st.textContent = `人物 ${stats.characters ?? stats.nodes ?? nodes.length} · 关系 ${stats.relationships ?? stats.edges ?? (g.edges || []).length}${selectedNode ? ` · 已选 ${selectedNode.label || selectedNode.id}` : ""}`;
    const clear = $("btnAnClearSelection");
    if (clear) clear.hidden = !selectedNodeId;
    renderAnalysisSummary(g, lastMeta);
    if ($("anGraphJson")) $("anGraphJson").value = JSON.stringify(g, null, 2);

    const mer = $("anMermaidBox");
    if (mer && N?.toMermaid) mer.textContent = N.toMermaid(scopedGraph);
    else if (mer && deps.graphToMermaid) mer.textContent = deps.graphToMermaid(scopedGraph);
    window.NOVEL_GRAPH_VIEW?.render?.($("anGraphCanvas"), scopedGraph, {
      selectedId: selectedNodeId,
      onSelect: (node) => {
        selectedNodeId = node?.id || null;
        showProfile(g, selectedNodeId);
        renderGraphPanels(g);
      },
    });

    const nl = $("anNodeList");
    if (nl) {
      nl.innerHTML = "";
      nodes.forEach((n) => {
        const b = document.createElement("button");
        b.type = "button";
        const active = nodeId(n) === nodeId(selectedNodeId);
        b.className = "an-node-btn" + (active ? " active" : "");
        b.setAttribute("aria-pressed", active ? "true" : "false");
        b.textContent = `${n.label || n.id}${n.sect ? " · " + n.sect : ""}`;
        b.addEventListener("click", () => {
          selectedNodeId = n.id;
          showProfile(g, n.id);
          renderGraphPanels(g);
        });
        nl.appendChild(b);
      });
    }

    const tb = $("anEdgeTable")?.querySelector("tbody");
    if (tb) {
      tb.innerHTML = "";
      (scopedGraph.edges || []).slice(0, 200).forEach((e) => {
        const sn =
          nodes.find((n) => nodeId(n) === nodeId(e.source))?.label || e.source;
        const tn =
          nodes.find((n) => nodeId(n) === nodeId(e.target))?.label || e.target;
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(sn)}</td><td>${escapeHtml(e.relationship || e.label || "")}</td><td>${escapeHtml(tn)}</td><td>${escapeHtml(e.chapter || e.note || "")}${e.occurrence > 1 ? " ×" + e.occurrence : ""}</td>`;
        tb.appendChild(tr);
      });
    }

    if (selectedNodeId) showProfile(g, selectedNodeId);
    else if ($("anProfile")) $("anProfile").innerHTML = "<p class='muted'>从人物列表选择一人查看</p>";
    renderTimeline(g, selectedNodeId);
  }

  function showProfile(g, id) {
    const box = $("anProfile");
    if (!box) return;
    const N = Narr();
    const prof = N?.buildCharacterProfile?.(g.nodes || [], g.edges || [], id);
    if (!prof) {
      box.innerHTML = "<p class='muted'>未选中人物</p>";
      return;
    }
    const neigh = (prof.neighbors || [])
      .map(
        (x) =>
          `<li><strong>${escapeHtml(x.label)}</strong> · ${escapeHtml(x.relationship || "")} <span class="muted">${escapeHtml(x.chapter || "")}</span></li>`
      )
      .join("");
    box.innerHTML = `
      <h4>${escapeHtml(prof.label || id)}</h4>
      <p class="muted">度数 ${prof.degree ?? 0}${prof.sect ? " · " + escapeHtml(prof.sect) : ""}${prof.chapter ? " · 首现 " + escapeHtml(prof.chapter) : ""}</p>
      <ul class="an-neigh">${neigh || "<li class='muted'>无邻居</li>"}</ul>`;
  }

  function renderTimeline(g, selectedId) {
    const box = $("anTimeline");
    if (!box) return;
    const N = Narr();
    const tracks = N?.buildRelationshipTracks?.(g.nodes || [], g.edges || []) || [];
    const id = nodeId(selectedId);
    const groups = (tracks.groups || []).filter(
      (track) => !id || nodeId(track.source) === id || nodeId(track.target) === id
    );
    if (groups.length) {
      box.innerHTML = groups
        .slice(0, 40)
        .map((t) => {
          const pair = t.pairLabel || t.pair || "";
          const ev = (t.entries || [])
            .map(
              (e) =>
                `<li>${escapeHtml(e.chapter || "")} · ${escapeHtml(e.label || e.relationship || "")}</li>`
            )
            .join("");
          return `<div class="an-track"><h5>${escapeHtml(pair)}</h5><ul>${ev || "<li class='muted'>—</li>"}</ul></div>`;
        })
        .join("");
      return;
    }
    const filteredTracks = Array.isArray(tracks)
      ? tracks.filter((track) => !id || nodeId(track.source) === id || nodeId(track.target) === id)
      : [];
    if (!filteredTracks.length) {
      box.innerHTML = `<p class='muted'>${id ? "该人物暂无关系演化证据" : "暂无关系演化数据"}</p>`;
      return;
    }
    box.innerHTML = filteredTracks
      .slice(0, 40)
      .map((t) => {
        const sl = t.source?.label || t.source || "";
        const tl = t.target?.label || t.target || "";
        return `<div class="an-track"><p>${escapeHtml(sl)} → ${escapeHtml(tl)} · ${escapeHtml(t.label || "")} <span class="muted">${escapeHtml(t.chapter || "")}</span></p></div>`;
      })
      .join("");
  }

  function metaForDisk(meta) {
    const out = { ...(meta || {}) };
    const extractionIds = Array.isArray(out.extractions)
      ? out.extractions.map((ex, index) =>
          ex ? ex.chunk_id || ex.id || String(index).padStart(4, "0") : null
        )
      : [];
    delete out.extractions;
    out.extraction_ids = extractionIds.filter(Boolean);
    return out;
  }

  function chapterManifest(chunks, sourceSig) {
    return {
      schema_version: 2,
      source_sig: sourceSig || "",
      chunks: (chunks || []).map((chunk, index) => ({
        index,
        id: chunk?.id ?? String(index).padStart(4, "0"),
        chapter: chunk?.chapter || "",
        start: chunk?.start ?? null,
        end: chunk?.end ?? null,
        chars: String(chunk?.text || "").length,
      })),
    };
  }

  async function writeCheckpointFiles(slug, payload, { initialize = false } = {}) {
    const V = Vault();
    if (!V || !slug || !deps.vaultOnline?.()) return;
    await V.fsMkdir?.(slug, "分析");
    await V.fsMkdir?.(slug, "分析/extractions");
    if (initialize) {
      await writeAnalysisFile(slug, "分析/source.txt", String(payload.fullText || ""));
      await writeAnalysisFile(
        slug,
        "分析/chapters.json",
        JSON.stringify(chapterManifest(payload.chunks, payload.source_sig), null, 2)
      );
    }
    // Commit order is intentional: graph first, meta last. A completed run
    // remains "finalizing" until report, extraction mirrors and book.json save.
    await writeAnalysisFile(
      slug,
      "分析/graph.json",
      JSON.stringify(payload.graph || { nodes: [], edges: [] }, null, 2)
    );
    const checkpointMeta =
      payload.phase === "final" && payload.meta?.status === "done"
        ? { ...payload.meta, status: "finalizing", final_status: "done" }
        : payload.meta;
    await writeAnalysisFile(slug, "分析/meta.json", JSON.stringify(metaForDisk(checkpointMeta), null, 2));
  }

  async function readJsonFile(slug, path) {
    const file = await Vault().readFile(slug, path);
    return JSON.parse(file?.content || "null");
  }

  async function loadCheckpoint(force = false) {
    const p = project();
    const slug = p?.slug;
    if (!slug || !deps.vaultOnline?.()) return null;
    if (!force && checkpointSlug === slug && checkpointLoadPromise) return checkpointLoadPromise;
    checkpointSlug = slug;
    checkpointLoadPromise = (async () => {
      try {
        const files = new Set();
        const collect = (nodes) => {
          for (const node of nodes || []) {
            if (node.type === "dir") collect(node.children);
            else files.add(node.path);
          }
        };
        collect((await Vault().fileTree(slug)).tree);
        if (!files.has("分析/meta.json") || !files.has("分析/graph.json")) return null;
        const optional = (path) => files.has(path) ? Vault().readFile(slug, path) : Promise.resolve(null);
        const meta = await readJsonFile(slug, "分析/meta.json");
        if (!meta || meta.schema_version !== 2) return null;
        const [graph, chapters, sourceFile, reportFile] = await Promise.all([
          readJsonFile(slug, "分析/graph.json"),
          optional("分析/chapters.json").then((file) => file ? JSON.parse(file.content) : null),
          optional("分析/source.txt"),
          optional("分析/report.md"),
        ]);
        lastMeta = meta;
        checkpointGraph = graph || { nodes: [], edges: [] };
        checkpointChunks = chapters;
        displayGraph = checkpointGraph;
        if (sourceFile?.content != null && $("anSourceText")) {
          $("anSourceText").value = String(sourceFile.content);
        }
        if (reportFile?.content != null && $("anReport")) {
          $("anReport").value = String(reportFile.content);
        }
        updateProgress(meta);
        applyFilterAndRender();
        setStatus(
          meta.status === "done"
            ? "已载入已完成的分析检查点"
            : `已载入可续跑检查点：${meta.completed_chunks?.length || 0}/${meta.total_chunks || 0}`,
          meta.status === "done" ? "ok" : "warn"
        );
        return {
          meta,
          graph: checkpointGraph,
          chapters,
          source: sourceFile?.content || "",
          report: reportFile?.content || "",
        };
      } catch (_) {
        lastMeta = null;
        checkpointGraph = null;
        checkpointChunks = null;
        return null;
      }
    })();
    return checkpointLoadPromise;
  }

  async function clearCheckpoint(slug) {
    if (!slug || !deps.vaultOnline?.()) return;
    for (const path of [
      "分析/extractions",
      "分析/meta.json",
      "分析/graph.json",
      "分析/chapters.json",
      "分析/source.txt",
      "分析/report.md",
    ]) {
      try {
        await Vault().fsDelete(slug, path);
      } catch (error) {
        const status = Number(error?.status || error?.data?.error?.status) || 0;
        const message = String(error?.message || "");
        const missing = status === 404 || (status === 400 && /^not found:/i.test(message));
        if (!missing) {
          throw new Error(`无法清理旧分析检查点 ${path}：${message || `HTTP ${status || "未知"}`}`, {
            cause: error,
          });
        }
      }
    }
    checkpointGraph = null;
    checkpointChunks = null;
    lastMeta = null;
  }

  async function persistAnalysis(slug, { graph, extractions, meta, reportMd }) {
    const V = Vault();
    if (!V || !slug || !deps.vaultOnline?.()) return;
    try {
      await V.fsMkdir?.(slug, "分析");
      await V.fsMkdir?.(slug, "分析/extractions");
    } catch (_) {
      /* may exist */
    }
    try {
      if (graph) {
        await writeAnalysisFile(slug, "分析/graph.json", JSON.stringify(graph, null, 2));
      }
      if (reportMd)
        await writeAnalysisFile(slug, "分析/report.md", reportMd);
      if (Array.isArray(extractions)) {
        for (let i = 0; i < extractions.length; i++) {
          const ex = extractions[i];
          if (!ex) continue;
          const id =
            (typeof Analysis()?.extractionFileId === "function"
              ? Analysis().extractionFileId(ex, i)
              : null) ||
            ex.chunk_id ||
            ex.id ||
            String(i).padStart(4, "0");
          await writeAnalysisFile(
            slug,
            `分析/extractions/${id}.json`,
            JSON.stringify(ex, null, 2)
          );
        }
      }
    } catch (e) {
      console.warn("persistAnalysis", e);
      setStatus("分析落盘部分失败: " + (e.message || e), "err");
      throw e;
    }
  }

  /** meta.json 是最终提交标记，只能在所有分析产物和项目状态均成功落盘后写入。 */
  async function commitAnalysisMeta(slug, meta) {
    if (!slug || !meta || !deps.vaultOnline?.()) return;
    try {
      await writeAnalysisFile(slug, "分析/meta.json", JSON.stringify(metaForDisk(meta), null, 2));
    } catch (cause) {
      const error = new Error(`analysis final commit failed: ${cause?.message || cause}`);
      error.code = "CHECKPOINT_WRITE_FAILED";
      error.cause = cause;
      throw error;
    }
  }

  function buildReport(p, graph, meta) {
    const N = Narr();
    const st = N?.graphStats?.(graph) || {};
    const lines = [
      `# ${p?.title || p?.slug || "叙事分析报告"}`,
      "",
      `- 状态：${meta?.status || ""}`,
      `- 分块：${(meta?.last_completed ?? -1) + 1}/${meta?.total_chunks || 0}`,
      `- 人物：${st.characters ?? (graph.nodes || []).length}`,
      `- 关系：${st.relationships ?? (graph.edges || []).length}`,
      "",
      "## 核心人物（按度数）",
      "",
    ];
    const scored = (graph.nodes || []).map((n) => {
      const deg = (graph.edges || []).filter(
        (e) => e.source === n.id || e.target === n.id
      ).length;
      return { n, deg };
    });
    scored.sort((a, b) => b.deg - a.deg);
    scored.slice(0, 15).forEach(({ n, deg }) => {
      lines.push(`- **${n.label || n.id}**（${deg}） ${n.sect || ""}`);
    });
    lines.push("", "## Mermaid", "", "```mermaid", N?.toMermaid?.(graph) || "graph LR", "```", "");
    return lines.join("\n");
  }

  async function startAnalysis(resume) {
    const p = project();
    if (!p) return alert("没有当前书稿");
    if (resume) {
      await loadCheckpoint(true);
      if (!lastMeta || !checkpointGraph) {
        return alert("没有可恢复的分析检查点，请开始一次新分析");
      }
    } else if (p?.slug) {
      await clearCheckpoint(p.slug);
    }
    if (!p) return alert("无当前书");
    const text = getSourceText();
    if (!text.trim()) return alert("请先写入分析文本，或确保书中已有章节正文");
    if (!cfg()?.apiKey && !cfg()?.baseUrl) {
      /* still allow; API may not need key for some proxies */
    }
    if (running) return alert("分析进行中");
    running = true;
    Analysis().pauseFlag.paused = false;
    $("btnAnStart") && ($("btnAnStart").disabled = true);
    $("btnAnPause") && ($("btnAnPause").disabled = false);
    if ($("btnAnStop")) {
      $("btnAnStop").hidden = false;
      $("btnAnStop").disabled = false;
    }
    setStatus(resume ? "续跑分析…" : "开始分析…", "busy");

    const ac = new AbortController();
    deps._anAbort = ac;
    let activeHooks = null;

    try {
      analysisWriter = deps.vaultOnline?.() && p.slug ? await Vault().createFileWriter(p.slug, "分析/") : null;
      const hooks = {
        initializeCheckpoint: async (payload) => {
          await writeCheckpointFiles(p.slug, payload, { initialize: true });
        },
        // A4：payload = { index, chunk, extraction, chunk_id }
        writeExtraction: async (payload) => {
          const slug = p.slug;
          if (!slug || !deps.vaultOnline?.()) return;
          try {
            await Vault().fsMkdir?.(slug, "分析/extractions");
            const id =
              (typeof Analysis()?.extractionFileId === "function"
                ? Analysis().extractionFileId(payload, payload?.index)
                : null) ||
              payload?.chunk_id ||
              payload?.extraction?.chunk_id ||
              payload?.chunk?.id ||
              String(payload?.index ?? 0).padStart(4, "0");
            const body = payload?.extraction || payload;
            await writeAnalysisFile(
              slug,
              `分析/extractions/${id}.json`,
              JSON.stringify(body, null, 2)
            );
          } catch (e) {
            console.warn(e);
            throw e;
          }
        },
        writeCheckpoint: async (payload) => {
          await writeCheckpointFiles(p.slug, payload);
        },
      };
      activeHooks = hooks;
      const runner = resume ? Analysis().resumeAnalysis : Analysis().runAnalysis;
      const result = await runner.call(Analysis(), {
        project: p,
        cfg: cfg(),
        fullText: text,
        signal: ac.signal,
        meta: resume ? lastMeta : null,
        graph: resume ? checkpointGraph : { nodes: [], edges: [] },
        onProgress: (m) => updateProgress(m),
        onChunk: () => {},
        hooks,
      });

      displayGraph = result.graph;
      checkpointGraph = result.graph;
      p.graph = result.graph;
      if (typeof deps.markDirty === "function") deps.markDirty(p);
      deps.onGraphUpdated?.(p);
      lastMeta = result.meta;
      updateProgress({ ...result.meta, status: "finalizing" });
      applyFilterAndRender();
      setStatus("正在聚合并保存分析结果…", "busy");

      const report = buildReport(p, result.graph, result.meta);
      if ($("anReport")) $("anReport").value = report;

      await persistAnalysis(p.slug, {
        graph: result.graph,
        extractions: result.extractions,
        meta: result.meta,
        reportMd: report,
      });

      if (typeof deps.saveProject === "function") {
        await deps.saveProject(p);
      } else if (typeof deps.onGraphUpdated === "function") {
        deps.onGraphUpdated(p);
      }
      await commitAnalysisMeta(p.slug, result.meta);
      lastMeta = result.meta;
      updateProgress(result.meta);

      setStatus(
        result.meta?.status === "done" ? "分析完成" : analysisStatusLabel(result.meta?.status),
        result.meta?.status === "done" ? "ok" : "warn"
      );
    } catch (e) {
      if (e?.result) {
        lastMeta = e.result.meta || lastMeta;
        checkpointGraph = e.result.graph || checkpointGraph;
        displayGraph = checkpointGraph || displayGraph;
        updateProgress(lastMeta);
        applyFilterAndRender();
      }
      if (e.name === "AbortError") {
        if (e.result?.meta && activeHooks?.writeCheckpoint) {
          e.result.meta.status = "aborted";
          e.result.meta.updated_at = Date.now();
          try {
            await activeHooks.writeCheckpoint({
              phase: "aborted",
              graph: e.result.graph,
              meta: e.result.meta,
              chunks: e.result.chunks,
            });
          } catch (_) {}
        }
        setStatus("分析已中止，进度检查点已保留", "warn");
        return;
      }
      if (e.code === "CHECKPOINT_SOURCE_MISMATCH") {
        setStatus("分析源或分块参数已变化，不能错误续跑", "err");
        alert("分析源或分块参数已变化。请点击“开始分析”创建新的检查点。");
        return;
      }
      if (e.code === "CHECKPOINT_WRITE_FAILED") {
        setStatus("分析检查点写入失败，任务未标记完成", "err");
        alert("分析检查点写入失败：" + (e.message || e));
        return;
      }
      if (e.code === "ANALYSIS_SAVE_CONFLICT") {
        setStatus("分析结果遇到保存冲突；检查点已保留，处理冲突后可继续", "err");
        alert(e.message || "分析结果保存遇到冲突");
        return;
      }
      if (e.name === "AbortError") setStatus("已中止", "warn");
      else {
        setStatus("分析失败: " + (e.message || e), "err");
        alert("分析失败: " + (e.message || e));
      }
    } finally {
      analysisWriter = null;
      running = false;
      $("btnAnStart") && ($("btnAnStart").disabled = false);
      $("btnAnPause") && ($("btnAnPause").disabled = true);
      if ($("btnAnStop")) {
        $("btnAnStop").disabled = true;
        $("btnAnStop").hidden = true;
      }
      deps._anAbort = null;
    }
  }

  function bind() {
    $("btnAnLoadChapters")?.addEventListener("click", () => {
      const t = textFromProject(project());
      if ($("anSourceText")) $("anSourceText").value = t;
      renderChapterPreview(t);
      setStatus(`已载入 ${t.length} 字`, "ok");
    });
    $("btnAnDetect")?.addEventListener("click", () => {
      renderChapterPreview(getSourceText());
    });
    $("btnAnStart")?.addEventListener("click", () => startAnalysis(false));
    $("btnAnResume")?.addEventListener("click", () => startAnalysis(true));
    $("btnAnPause")?.addEventListener("click", () => {
      if (Analysis()?.pauseFlag) {
        Analysis().pauseFlag.paused = !Analysis().pauseFlag.paused;
        setStatus(
          Analysis().pauseFlag.paused ? "已暂停（当前块结束后生效）" : "继续…",
          "warn"
        );
      }
    });
    $("btnAnStop")?.addEventListener("click", () => {
      deps._anAbort?.abort();
      if (Analysis()?.pauseFlag) Analysis().pauseFlag.paused = false;
    });
    $("anMinOcc")?.addEventListener("change", applyFilterAndRender);
    $("anChapFrom")?.addEventListener("change", applyFilterAndRender);
    $("anChapTo")?.addEventListener("change", applyFilterAndRender);
    $("btnAnApplyFilter")?.addEventListener("click", applyFilterAndRender);
    $("btnAnSyncGraph")?.addEventListener("click", () => {
      const p = project();
      if (!p) return;
      displayGraph = p.graph || displayGraph;
      applyFilterAndRender();
      setStatus("已从项目重载图谱", "ok");
    });
    $("btnAnClearSelection")?.addEventListener("click", () => {
      selectedNodeId = null;
      applyFilterAndRender();
      $("anNodeList")?.querySelector("button")?.focus();
    });
  }

  async function onShow() {
    const p = project();
    const checkpoint = await loadCheckpoint();
    displayGraph = checkpoint?.graph || p?.graph || displayGraph;
    applyFilterAndRender();
    if (!($("anSourceText")?.value || "").trim()) {
      const t = textFromProject(p);
      if (t && $("anSourceText")) $("anSourceText").value = t;
    }
    renderChapterPreview(getSourceText());
  }

  function init(d) {
    deps = d || {};
    bind();
  }

  return { init, onShow, applyFilterAndRender, startAnalysis, loadCheckpoint, clearCheckpoint };
})();
