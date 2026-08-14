/**
 * 章节边界检测与智能切片（GOAL-ULTIMATE Phase1）。
 * 思想参考 screenplay-analyzer chapterSplitter，运行时不依赖该仓库。
 */
window.NOVEL_CHAPTER_SPLIT = (() => {
  // 章节识别规则（按优先级）。允许 0–30 字符行内前缀（目录《》、缩进等）。
  const CHAPTER_PATTERNS = [
    /^[^\n]{0,30}?第([零〇一二三四五六七八九十百千万两\d]+)章[ 　]*([^\n\r]{0,40})/,
    /^[^\n]{0,30}?第([零〇一二三四五六七八九十百千万两\d]+)回[ 　]*([^\n\r]{0,40})/,
    /^[^\n]{0,30}?(序章|序言|楔子|引子|终章|番外)[ 　]*([^\n\r]{0,40})?/,
    /^[^\n]{0,30}?序[ 　]*([^\n\r]{0,40})?/,
  ];

  function normalizeNum(zh) {
    if (!zh) return zh;
    if (zh === "零" || zh === "〇") return "一";
    return zh;
  }

  function formatChapter(match) {
    const head = /第([零〇一二三四五六七八九十百千万两\d]+)([章回])/.exec(match[0]);
    if (head) {
      const num = normalizeNum(head[1]);
      const tag = head[2];
      const title = match[0].slice(head.index + head[0].length).trim();
      return title ? `第${num}${tag} ${title}` : `第${num}${tag}`;
    }
    const body = match[0].replace(/^[^\n]{0,30}?/, "");
    const special = /^(序章|序言|楔子|引子|终章|番外)/.exec(body);
    if (special) {
      const tag = special[1];
      const title = body.slice(tag.length).trim();
      return title ? `${tag} ${title}` : tag;
    }
    if (/^序/.test(body)) {
      const tag = "序";
      const title = body.slice(tag.length).trim();
      return title ? `${tag} ${title}` : tag;
    }
    return body.trim() || match[0].trim();
  }

  /**
   * 扫描文本，返回 [{chapter, start}]，按 start 升序去重。
   * 无匹配时返回 []（虚拟段由 splitIntoChunks / buildChapterList 处理）。
   */
  function detectChapterRanges(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    const matches = [];

    for (const regex of CHAPTER_PATTERNS) {
      const re = new RegExp(regex.source, "gm");
      let m;
      while ((m = re.exec(text)) !== null) {
        const chapter = formatChapter(m).replace(/\s+/g, " ").trim();
        if (!chapter) continue;
        matches.push({ chapter, start: m.index });
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }

    if (matches.length === 0) return [];

    matches.sort((a, b) => a.start - b.start);
    const dedup = [];
    for (const m of matches) {
      if (dedup.length === 0 || m.start > dedup[dedup.length - 1].start) {
        dedup.push(m);
      }
    }
    return dedup;
  }

  /**
   * 给定绝对 offset，返回所在章节名（向后就近「上一章」）。
   */
  function chapterAtOffset(offset, ranges) {
    if (!ranges || ranges.length === 0) return "";
    if (offset < ranges[0].start) return ranges[0].chapter;
    let current = ranges[0].chapter;
    for (const r of ranges) {
      if (r.start <= offset) current = r.chapter;
      else break;
    }
    return current;
  }

  /**
   * 构建章节列表：有标记用 detect；无匹配时按 chunkSize 虚拟段。
   * @returns [{chapter, start, end?}]
   */
  function buildChapterList(text, opts = {}) {
    const chunkSize = Math.max(1, Math.floor(Number(opts.chunkSize) || 3000));
    if (typeof text !== "string" || text.length === 0) return [];

    const ranges = detectChapterRanges(text);
    if (ranges.length > 0) {
      const list = ranges.map((r, i) => {
        const end = i + 1 < ranges.length ? ranges[i + 1].start : text.length;
        return { chapter: r.chapter, start: r.start, end };
      });
      // 文首在第一章之前的前缀
      if (ranges[0].start > 0) {
        list.unshift({
          chapter: "前文",
          start: 0,
          end: ranges[0].start,
        });
      }
      return list;
    }

    // 无章节标记 → 虚拟段
    const list = [];
    for (let i = 0, n = 1; i < text.length; i += chunkSize, n += 1) {
      const end = Math.min(i + chunkSize, text.length);
      list.push({ chapter: `段${n}`, start: i, end });
    }
    return list;
  }

  /**
   * 智能切片：优先不跨章；支持 overlap。
   * @returns [{id, chapter, start, end, text}]
   */
  function splitIntoChunks(text, opts = {}) {
    const chunkSize = Math.max(1, Math.floor(Number(opts.chunkSize) || 3000));
    const overlap = Math.max(0, Math.min(chunkSize - 1, Math.floor(Number(opts.overlap) || 200)));
    if (typeof text !== "string" || text.length === 0) return [];

    const ranges = detectChapterRanges(text);
    const chunks = [];
    let id = 0;

    if (ranges.length === 0) {
      // 无章节：等距切 + overlap
      for (let start = 0; start < text.length; ) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push({
          id: id++,
          chapter: `段${chunks.length + 1}`,
          start,
          end,
          text: text.slice(start, end),
        });
        if (end >= text.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      return chunks;
    }

    // 有章节：按章切，章内再按 chunkSize 切，绝不跨章
    const segments = [];
    if (ranges[0].start > 0) {
      segments.push({ chapter: "前文", start: 0, end: ranges[0].start });
    }
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges[i].start;
      const end = i + 1 < ranges.length ? ranges[i + 1].start : text.length;
      segments.push({ chapter: ranges[i].chapter, start, end });
    }

    for (const seg of segments) {
      const segLen = seg.end - seg.start;
      if (segLen <= 0) continue;
      if (segLen <= chunkSize) {
        chunks.push({
          id: id++,
          chapter: seg.chapter,
          start: seg.start,
          end: seg.end,
          text: text.slice(seg.start, seg.end),
        });
        continue;
      }
      for (let local = 0; local < segLen; ) {
        const absStart = seg.start + local;
        const absEnd = Math.min(absStart + chunkSize, seg.end);
        chunks.push({
          id: id++,
          chapter: seg.chapter,
          start: absStart,
          end: absEnd,
          text: text.slice(absStart, absEnd),
        });
        if (absEnd >= seg.end) break;
        local = Math.max(absEnd - seg.start - overlap, local + 1);
      }
    }
    return chunks;
  }

  return {
    detectChapterRanges,
    splitIntoChunks,
    buildChapterList,
    chapterAtOffset,
  };
})();
