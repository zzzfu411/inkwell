/**
 * 叙事分析 Runner：切章 → 分块抽取 → 合并图谱（GOAL-ULTIMATE Phase1）。
 * 本身不强制写 vault；通过 onChunk / hooks.writeExtraction 让外部持久化。
 */
window.NOVEL_ANALYSIS = (() => {
  /** 共享暂停标志：外部设 pauseFlag.paused = true 即可在块边界暂停 */
  const pauseFlag = { paused: false };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitWhilePaused(signal) {
    while (pauseFlag.paused) {
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      await sleep(120);
    }
  }

  function emptyGraph() {
    return { nodes: [], edges: [] };
  }

  function ensureMeta(meta, total) {
    return {
      schema_version: meta?.schema_version || 2,
      status: meta?.status || "idle",
      total_chunks: meta?.total_chunks ?? total ?? 0,
      last_completed: Number.isFinite(meta?.last_completed) ? meta.last_completed : -1,
      failed_chunks: Array.isArray(meta?.failed_chunks) ? [...meta.failed_chunks] : [],
      completed_chunks: Array.isArray(meta?.completed_chunks) ? [...meta.completed_chunks] : [],
      extractions: Array.isArray(meta?.extractions) ? meta.extractions : [],
      source_sig: meta?.source_sig || "",
      chunk_size: meta?.chunk_size || 0,
      overlap: meta?.overlap || 0,
      model: meta?.model || "",
      started_at: meta?.started_at || 0,
      updated_at: meta?.updated_at || 0,
      persistence_error: meta?.persistence_error || null,
    };
  }

  function contentHash(value) {
    let fnv = 0x811c9dc5;
    let djb = 0x1505;
    const text = String(value ?? "");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      fnv ^= code;
      fnv = Math.imul(fnv, 0x01000193);
      djb = (Math.imul(djb, 33) ^ code) >>> 0;
    }
    return `${(fnv >>> 0).toString(16).padStart(8, "0")}${djb
      .toString(16)
      .padStart(8, "0")}`;
  }

  function sourceSignature(fullText, cfg = {}) {
    const chunkSize = Math.max(500, Math.floor(Number(cfg.chunkSize) || 3000));
    const overlap = Math.max(0, Math.floor(Number(cfg.overlap) || 200));
    return `analysis-v2:${contentHash(fullText)}:${chunkSize}:${overlap}`;
  }

  function getSplit() {
    return window.NOVEL_CHAPTER_SPLIT;
  }

  function getNarrative() {
    return window.NOVEL_NARRATIVE;
  }

  function getApi() {
    return window.NOVEL_API;
  }

  function getPrompts() {
    return window.NOVEL_PROMPTS;
  }

  function buildMessages(chunk, project, prompts) {
    const P = prompts || getPrompts();
    const analyze = P?.analyzeChunk;
    const guard = P?.commonGuard || "";
    const chapter = chunk.chapter || "未知";
    const system = analyze?.system
      ? (typeof analyze.system === "function" ? analyze.system({ chapter, project }) : analyze.system)
      : [
          "你是叙事关系抽取器。根据给定小说片段抽取人物节点与关系边。",
          "只输出 JSON：{\"nodes\":[...],\"edges\":[...]}",
          "每个 node 含 id,label,aliases,type,sect,chapter,note；",
          "每个 edge 含 source,target,relationship,chapter,evidence,occurrence。",
          "chapter 字段必须填当前章节名。禁止脑补未写情节。",
        ].join("\n");

    const user = analyze?.user
      ? (typeof analyze.user === "function"
          ? analyze.user(chunk, project)
          : String(analyze.user))
      : `[当前章节：${chapter}]\n\n${chunk.text || ""}`;

    const messages = [];
    if (guard) messages.push({ role: "system", content: guard });
    messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    return messages;
  }

  function normalizeExtraction(raw, chunk, index) {
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const edges = Array.isArray(raw?.edges) ? raw.edges : [];
    const chapter = chunk?.chapter || "";
    const chunkId =
      chunk?.id != null
        ? String(chunk.id)
        : index != null
          ? String(index).padStart(4, "0")
          : "0000";
    return {
      chunk_id: chunkId,
      id: chunkId,
      chapter,
      nodes: nodes.map((n) => ({
        ...n,
        chapter: n.chapter || chapter,
      })),
      edges: edges.map((e) => ({
        ...e,
        chapter: e.chapter || chapter,
        relationship: e.relationship || e.label || "",
        occurrence: e.occurrence || 1,
      })),
    };
  }

  /** 落盘文件名：优先 chunk_id / id，否则 0001 形式（禁止塌成 x.json） */
  function extractionFileId(payload, fallbackIndex) {
    const pad = (n) => String(n ?? 0).padStart(4, "0");
    if (payload == null) return pad(fallbackIndex);
    if (typeof payload === "string" || typeof payload === "number") {
      const s = String(payload).trim();
      return s || pad(fallbackIndex);
    }
    const ex = payload.extraction && typeof payload.extraction === "object"
      ? payload.extraction
      : payload;
    const chunk = payload.chunk;
    const idx = payload.index != null ? payload.index : fallbackIndex;
    const raw =
      (ex && (ex.chunk_id || ex.id)) ||
      (chunk && chunk.id) ||
      (idx != null ? pad(idx) : null) ||
      "0000";
    const cleaned = String(raw)
      .replace(/[^\w.\u4e00-\u9fff-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return cleaned || pad(fallbackIndex);
  }

  /**
   * @param {object} opts
   * @param {object} [opts.project]  项目（可含 graph）
   * @param {object} opts.cfg        { baseUrl, apiKey, model, chunkSize?, overlap? }
   * @param {string} opts.fullText   全书/待分析文本
   * @param {AbortSignal} [opts.signal]
   * @param {function} [opts.onProgress] ({completed, total, status, last_completed, failed_chunks, graph})
   * @param {function} [opts.onChunk] (chunkResult)
   * @param {object} [opts.hooks] { writeExtraction?(payload) }
   * @param {object} [opts.meta]  续跑用 { last_completed, failed_chunks, ... }
   * @param {object} [opts.graph] 起始图谱
   * @param {Array}  [opts.chunks] 预切片（可选）
   * @param {boolean} [opts.retryFailedOnly] 仅重试 failed_chunks
   */
  async function runAnalysis(opts = {}) {
    const Split = getSplit();
    const Narrative = getNarrative();
    const API = getApi();
    const P = getPrompts();

    if (!Split?.splitIntoChunks) throw new Error("NOVEL_CHAPTER_SPLIT 未加载");
    if (!Narrative?.mergeGraphs) throw new Error("NOVEL_NARRATIVE 未加载");
    if (!API?.chatJson) throw new Error("NOVEL_API 未加载");

    const cfg = opts.cfg || {};
    const chunkSize = Math.max(500, Math.floor(Number(cfg.chunkSize) || 3000));
    const overlap = Math.max(0, Math.floor(Number(cfg.overlap) || 200));
    const fullText = typeof opts.fullText === "string" ? opts.fullText : "";
    const project = opts.project || {};
    const signal = opts.signal;

    const chunks =
      Array.isArray(opts.chunks) && opts.chunks.length
        ? opts.chunks
        : Split.splitIntoChunks(fullText, { chunkSize, overlap });

    const sourceSig = sourceSignature(fullText, { chunkSize, overlap });
    if (opts.meta?.source_sig && opts.meta.source_sig !== sourceSig) {
      const error = new Error("analysis source or chunk settings changed; start a new analysis");
      error.code = "CHECKPOINT_SOURCE_MISMATCH";
      throw error;
    }

    let graph = opts.graph
      ? Narrative.mergeGraphs(emptyGraph(), opts.graph)
      : Narrative.mergeGraphs(emptyGraph(), project.graph || emptyGraph());

    const meta = ensureMeta(opts.meta, chunks.length);
    meta.total_chunks = chunks.length;
    meta.status = "running";
    meta.source_sig = sourceSig;
    meta.chunk_size = chunkSize;
    meta.overlap = overlap;
    meta.model = cfg.model || meta.model || "";
    meta.started_at = meta.started_at || Date.now();
    meta.updated_at = Date.now();
    meta.persistence_error = null;

    const extractions = Array.isArray(meta.extractions) ? [...meta.extractions] : [];
    const failedSet = new Set(meta.failed_chunks || []);
    const completedSet = new Set(meta.completed_chunks || []);
    if (completedSet.size === 0 && meta.last_completed >= 0) {
      for (let i = 0; i <= meta.last_completed; i++) {
        if (!failedSet.has(i)) completedSet.add(i);
      }
    }

    // 决定要跑的下标
    let indices = [];
    if (opts.retryFailedOnly && failedSet.size > 0) {
      indices = [...failedSet].filter((i) => i >= 0 && i < chunks.length).sort((a, b) => a - b);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        if (!completedSet.has(i) && (opts.includeFailed !== false || !failedSet.has(i))) {
          indices.push(i);
        }
      }
    }

    const fireProgress = (extra = {}) => {
      opts.onProgress?.({
        completed: completedSet.size,
        total: meta.total_chunks,
        status: meta.status,
        last_completed: meta.last_completed,
        failed_chunks: [...meta.failed_chunks],
        completed_chunks: [...completedSet].sort((a, b) => a - b),
        graph,
        ...extra,
      });
    };

    fireProgress();

    if (typeof opts.hooks?.initializeCheckpoint === "function") {
      try {
        await opts.hooks.initializeCheckpoint({
          fullText,
          chunks,
          graph,
          meta: { ...meta, completed_chunks: [...completedSet].sort((a, b) => a - b) },
          source_sig: sourceSig,
        });
      } catch (cause) {
        meta.status = "persistence_error";
        meta.persistence_error = cause?.message || String(cause);
        fireProgress();
        const error = new Error(`analysis checkpoint initialization failed: ${meta.persistence_error}`);
        error.code = "CHECKPOINT_WRITE_FAILED";
        error.cause = cause;
        error.result = { graph, extractions, meta, chunks };
        throw error;
      }
    }

    if (chunks.length === 0) {
      meta.status = "done";
      fireProgress();
      return { graph, extractions, meta, chunks };
    }

    for (const i of indices) {
      if (signal?.aborted) {
        meta.status = "aborted";
        fireProgress();
        const err = new Error("aborted");
        err.name = "AbortError";
        err.result = { graph, extractions, meta, chunks };
        throw err;
      }

      await waitWhilePaused(signal);
      if (pauseFlag.paused) {
        // waitWhilePaused 退出后若再次被设暂停，再检查一次
        await waitWhilePaused(signal);
      }

      const chunk = chunks[i];
      const chunkResult = {
        index: i,
        id: chunk.id ?? i,
        chapter: chunk.chapter,
        ok: false,
        extraction: null,
        error: null,
      };

      try {
        const messages = buildMessages(chunk, project, P);
        const raw = await API.chatJson({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages,
          signal,
        });
        const extraction = normalizeExtraction(raw, chunk, i);
        graph = Narrative.mergeGraphs(graph, extraction);
        chunkResult.ok = true;
        chunkResult.extraction = extraction;
        chunkResult.chunk_id = extraction.chunk_id;
        extractions[i] = extraction;
        failedSet.delete(i);
        completedSet.add(i);
        meta.failed_chunks = [...failedSet].sort((a, b) => a - b);
        meta.completed_chunks = [...completedSet].sort((a, b) => a - b);
        let contiguous = -1;
        while (completedSet.has(contiguous + 1)) contiguous += 1;
        meta.last_completed = contiguous;

        try {
          // A4：payload 含 chunk_id，落盘不得塌成 x.json
          await opts.hooks?.writeExtraction?.({
            index: i,
            chunk,
            extraction,
            chunk_id: extraction.chunk_id,
            graph,
            meta: { ...meta },
          });
        } catch (cause) {
          const error = new Error(`analysis extraction checkpoint failed: ${cause?.message || cause}`);
          error.code = "CHECKPOINT_WRITE_FAILED";
          error.cause = cause;
          throw error;
        }
      } catch (e) {
        if (e?.code === "CHECKPOINT_WRITE_FAILED") {
          meta.status = "persistence_error";
          meta.persistence_error = e.message;
          meta.updated_at = Date.now();
          fireProgress({ index: i });
          e.result = { graph, extractions, meta, chunks };
          throw e;
        }
        if (e?.name === "AbortError") {
          meta.status = "aborted";
          fireProgress({ index: i });
          e.result = { graph, extractions, meta, chunks };
          throw e;
        }
        chunkResult.ok = false;
        chunkResult.error = e?.message || String(e);
        failedSet.add(i);
        completedSet.delete(i);
        meta.failed_chunks = [...failedSet].sort((a, b) => a - b);
        meta.completed_chunks = [...completedSet].sort((a, b) => a - b);
      }

      meta.updated_at = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await opts.hooks?.writeCheckpoint?.({
          index: i,
          chunk,
          chunkResult,
          graph,
          meta: { ...meta },
          chunks,
          source_sig: sourceSig,
        });
      } catch (cause) {
        meta.status = "persistence_error";
        meta.persistence_error = cause?.message || String(cause);
        fireProgress({ index: i, chunkResult });
        const error = new Error(`analysis checkpoint failed: ${meta.persistence_error}`);
        error.code = "CHECKPOINT_WRITE_FAILED";
        error.cause = cause;
        error.result = { graph, extractions, meta, chunks };
        throw error;
      }

      opts.onChunk?.(chunkResult);
      fireProgress({ index: i, chunkResult });
    }

    meta.failed_chunks = [...failedSet].sort((a, b) => a - b);
    meta.extractions = extractions;
    meta.completed_chunks = [...completedSet].sort((a, b) => a - b);
    let finalContiguous = -1;
    while (completedSet.has(finalContiguous + 1)) finalContiguous += 1;
    meta.last_completed = finalContiguous;
    meta.updated_at = Date.now();
    if (meta.failed_chunks.length > 0) {
      meta.status = "partial";
    } else if (completedSet.size >= meta.total_chunks) {
      meta.status = "done";
    } else {
      meta.status = "partial";
    }

    try {
      await opts.hooks?.writeCheckpoint?.({
        index: null,
        phase: "final",
        graph,
        meta: { ...meta },
        chunks,
        source_sig: sourceSig,
      });
    } catch (cause) {
      meta.status = "persistence_error";
      meta.persistence_error = cause?.message || String(cause);
      const error = new Error(`analysis final checkpoint failed: ${meta.persistence_error}`);
      error.code = "CHECKPOINT_WRITE_FAILED";
      error.cause = cause;
      error.result = { graph, extractions, meta, chunks };
      fireProgress();
      throw error;
    }

    fireProgress();
    return { graph, extractions, meta, chunks };
  }

  /**
   * 从 meta.last_completed 续跑。
   */
  async function resumeAnalysis(opts = {}) {
    const meta = ensureMeta(opts.meta, opts.meta?.total_chunks);
    return runAnalysis({
      ...opts,
      meta,
    });
  }

  function setPaused(v) {
    pauseFlag.paused = !!v;
  }

  return {
    runAnalysis,
    resumeAnalysis,
    pauseFlag,
    setPaused,
    extractionFileId,
    normalizeExtraction,
    sourceSignature,
  };
})();
