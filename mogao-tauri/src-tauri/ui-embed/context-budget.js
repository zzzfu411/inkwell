/** Deterministic dual-budget allocator shared by legacy and production context packs. */
window.NOVEL_CONTEXT_BUDGET = (() => {
  function estimate(text) {
    return String(text || "").length;
  }

  /** 中英混合保守 token 估算：CJK 约 1/token，拉丁文本约 4 chars/token。 */
  function estimateTokens(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const latin = (s.match(/[A-Za-z0-9]+/g) || []).reduce((n, x) => n + x.length, 0);
    const other = Math.max(0, s.length - cjk - latin);
    return Math.max(1, Math.ceil(cjk + latin / 4 + other / 6));
  }

  function clipToDualBudget(text, maxChars, maxTokens) {
    const source = String(text || "");
    const charCap = Math.max(0, Math.floor(maxChars));
    const tokenCap = Math.max(0, Math.floor(maxTokens));
    if (!source || charCap <= 0 || tokenCap <= 0) return "";
    if (source.length <= charCap && estimateTokens(source) <= tokenCap) return source;
    const marker = "\n…[按上下文预算截断]…";
    if (charCap <= marker.length + 12 || tokenCap <= estimateTokens(marker) + 8) {
      return source.slice(0, Math.min(charCap, 24));
    }
    let lo = 0;
    let hi = Math.min(source.length, charCap - marker.length);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = source.slice(0, mid) + marker;
      if (candidate.length <= charCap && estimateTokens(candidate) <= tokenCap) lo = mid;
      else hi = mid - 1;
    }
    return source.slice(0, lo) + marker;
  }

  const DEFAULT_PRIORITY = Object.freeze([
    "lock",
    "task",
    "beat",
    "opening",
    "debt",
    "instr",
    "storyline",
    "canon",
    "warnings",
    "style",
    "rag",
    "progress",
    "story",
    "entity",
    "timeline",
    "prev",
    "loops",
    "body",
    "appear",
    "memory",
    "cast",
    "world",
    "foreshadow",
  ]);
  const DEFAULT_HARD_KEEP = Object.freeze([
    "body",
    "task",
    "beat",
    "opening",
    "debt",
    "instr",
    "lock",
    "prev",
    "story",
    "entity",
    "style",
    "storyline",
    "canon",
    "warnings",
    "rag",
  ]);
  const DEFAULT_MINIMUM_CHARS = Object.freeze({
    lock: 250,
    task: 550,
    beat: 400,
    opening: 120,
    debt: 180,
    instr: 250,
    storyline: 450,
    canon: 650,
    warnings: 250,
    rag: 500,
    story: 450,
    entity: 450,
    style: 350,
    prev: 650,
    body: 350,
  });

  function allocateBlocks(blocks, opts = {}) {
    const budget = Math.max(0, Number(opts.budget) || 0);
    const tokenBudget = Math.max(0, Number(opts.tokenBudget) || 0);
    const priority = Array.isArray(opts.priority) ? opts.priority : DEFAULT_PRIORITY;
    const hardKeep = new Set(Array.isArray(opts.hardKeep) ? opts.hardKeep : DEFAULT_HARD_KEEP);
    const minimumChars = { ...DEFAULT_MINIMUM_CHARS, ...(opts.minimumChars || {}) };
    let packed = "";
    const used = new Set();
    const truncated = [];
    const omitted = [];
    const sourceBlocks = Array.isArray(blocks) ? blocks : [];
    const orderedBlocks = priority.map((key) => sourceBlocks.find((block) => block?.k === key)).filter(Boolean);

    for (let blockIndex = 0; blockIndex < orderedBlocks.length; blockIndex++) {
      const block = orderedBlocks[blockIndex];
      const key = block.k;
      const separator = packed ? "\n\n" : "";
      const futureRequired = orderedBlocks.slice(blockIndex + 1).filter((item) => hardKeep.has(item.k));
      let reservedChars = 0;
      let reservedTokens = 0;
      for (const future of futureRequired) {
        const minChars = Math.min(String(future.t || "").length, minimumChars[future.k] || 220);
        const minText = String(future.t || "").slice(0, minChars);
        reservedChars += minText.length + 2;
        reservedTokens += estimateTokens(minText) + 1;
      }
      const availableChars = Math.max(0, budget - estimate(packed) - separator.length - reservedChars);
      const availableTokens = Math.max(
        0,
        tokenBudget - estimateTokens(packed) - estimateTokens(separator) - reservedTokens
      );
      const full = String(block.t || "");
      if (full.length <= availableChars && estimateTokens(full) <= availableTokens) {
        packed += separator + full;
        used.add(key);
        continue;
      }
      if (block.keep || hardKeep.has(key)) {
        const fragment = clipToDualBudget(full, availableChars, availableTokens);
        if (fragment) {
          packed += separator + fragment;
          used.add(key);
          truncated.push({ key, originalChars: full.length, usedChars: fragment.length });
        } else {
          omitted.push(key);
        }
      } else {
        omitted.push(key);
      }
    }

    const discipline = String(opts.discipline || "");
    if (
      discipline &&
      estimate(packed) + estimate(discipline) + 4 <= budget &&
      estimateTokens(packed) + estimateTokens(discipline) + 1 <= tokenBudget
    ) {
      packed = packed + "\n\n" + discipline;
      used.add("discipline");
    }

    return {
      packed,
      used: [...used],
      truncated,
      omitted,
      blockStats: sourceBlocks.map((block) => ({
        key: block.k,
        originalChars: String(block.t || "").length,
        originalTokens: estimateTokens(block.t || ""),
        used: used.has(block.k),
        truncated: truncated.some((item) => item.key === block.k),
      })),
    };
  }

  return {
    estimate,
    estimateTokens,
    clipToDualBudget,
    allocateBlocks,
  };
})();
