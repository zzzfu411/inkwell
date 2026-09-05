import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, document: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "library.js"), "utf8"), sandbox);
const Library = sandbox.window.NOVEL_LIBRARY;

const fallback = Library.buildSidebarModel(
  [],
  [
    { slug: "alpha", title: "甲书", chapters: [{}, {}], stage: "draft" },
    { slug: "beta", title: "乙书", chapters: [] },
    { title: "缓存空壳", chapters: [] },
  ],
  "",
  true
);
assert.equal(fallback.books.length, 2);
assert.equal(fallback.books[0].chapters, 2);
assert.equal(fallback.empty.hidden, true);

const filtered = Library.buildSidebarModel(
  [{ slug: "alpha", title: "星河", chapters: 3 }],
  [],
  "不存在",
  true
);
assert.equal(filtered.books.length, 0);
assert.equal(filtered.empty.filtered, true);
assert.match(filtered.empty.hint, /不存在/);

const offline = Library.buildSidebarModel([], [], "", false);
assert.equal(offline.clearList, true);
assert.match(offline.empty.hint, /本地服务未连接/);

console.log("test_library: OK");
