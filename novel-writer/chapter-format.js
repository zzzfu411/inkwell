/** 章节 Markdown（YAML front matter + 正文）纯函数。 */
window.NOVEL_CHAPTER_FORMAT = (() => {
  /**
   * 解析 Inkwell 章节 Markdown。只把文首完整的 --- ... --- 识别为 front matter。
   * @returns {{ hasFrontMatter: boolean, meta: Record<string,string>, body: string }}
   */
  function parseChapterMarkdown(text) {
    const src = String(text || "").replace(/^\uFEFF/, "");
    const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
    if (!match) return { hasFrontMatter: false, meta: {}, body: src };

    const meta = {};
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes(":")) continue;
      const at = line.indexOf(":");
      const key = line.slice(0, at).trim();
      let value = line.slice(at + 1).trim();
      if (!key) continue;
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
    return {
      hasFrontMatter: true,
      meta,
      body: match[2].replace(/^\r?\n/, ""),
    };
  }

  function chapterBodyFromMarkdown(text) {
    return parseChapterMarkdown(text).body;
  }

  return { parseChapterMarkdown, chapterBodyFromMarkdown };
})();
