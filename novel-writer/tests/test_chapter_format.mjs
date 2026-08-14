import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-format.js"), "utf8"), sandbox);
const F = sandbox.window.NOVEL_CHAPTER_FORMAT;

const raw = [
  "---",
  'id: "c1"',
  'title: "第一章"',
  "order: 1",
  "---",
  "",
  "正文第一段。",
  "---",
  "正文中的分隔线不能被当作 front matter。",
].join("\n");

const parsed = F.parseChapterMarkdown(raw);
assert.equal(parsed.hasFrontMatter, true);
assert.equal(parsed.meta.id, "c1");
assert.equal(parsed.meta.title, "第一章");
assert.equal(parsed.body, "正文第一段。\n---\n正文中的分隔线不能被当作 front matter。");
assert.equal(F.chapterBodyFromMarkdown("普通正文"), "普通正文");
assert.ok(!F.chapterBodyFromMarkdown(raw).startsWith("---"));

console.log("test_chapter_format: OK");
