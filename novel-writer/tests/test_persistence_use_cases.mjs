import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8"), sandbox, {
  filename: path.join(root, "runtime-observability.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "persistence-use-cases.js"), "utf8"), sandbox, {
  filename: path.join(root, "persistence-use-cases.js"),
});
const Factory = sandbox.window.NOVEL_PERSISTENCE_USE_CASES;

// A real first-run project must acquire a durable slug before the first save.
{
  const empty = { id: "first", title: "新书", slug: "", chapters: [{ body: "首次输入" }] };
  const saved = [];
  const persistence = Factory.create({
    isOnline: () => true, getActiveProject: () => empty, assertWritable() {},
    createBook: async () => ({ slug: "first-book", _bookRevision: "initial" }),
    saveCache() {}, ensureWorkspaceSaved() {}, hasPendingConflict: () => false,
    mergeWorkspace: () => null, syncActiveEditor() {}, readRevision: () => 1,
    saveBook: async (slug, project) => { saved.push([slug, project.chapters[0].body]); return {}; },
    reconcileWarnings: async () => ({ conflicts: 0 }), markClean() {},
  });
  await persistence.flushCurrent();
  assert.deepEqual(saved, [["first-book", "首次输入"]]);
  assert.equal(empty._bookRevision, "initial");
}

const project = { id: "p1", slug: "book", updatedAt: 0 };
const calls = [];
let releaseFirst;
let saveCount = 0;
const clean = [];
const deps = {
  isOnline: () => true,
  getActiveProject: () => project,
  assertWritable: (item) => calls.push(["writable", item.id]),
  ensureWorkspaceSaved: async (label) => calls.push(["workspace", label]),
  hasPendingConflict: () => false,
  openNextConflict: () => calls.push(["open-conflict"]),
  setStatus: (label, kind) => calls.push(["status", label, kind]),
  mergeWorkspace: () => true,
  saveWorkspaceOnly: async () => calls.push(["file-only"]),
  syncActiveEditor: () => calls.push(["sync-editor"]),
  readRevision: () => saveCount + 1,
  async saveBook(_slug, item) {
    saveCount += 1;
    const call = saveCount;
    calls.push(["save", call, item.version || 0]);
    if (call === 1) await new Promise((resolve) => (releaseFirst = resolve));
    return { path: `book-${call}`, mtime: call, saveWarnings: [] };
  },
  setDiskMtime: (value) => calls.push(["mtime", value]),
  adoptBaselines: () => calls.push(["baselines"]),
  reconcileWarnings: async () => ({ added: 0, conflicts: 0 }),
  markClean: (message, guard) => clean.push({ message, guard }),
  refreshLibrary: () => calls.push(["library"]),
  bumpRevision: () => calls.push(["bump"]),
  now: () => 123,
  saveRecovery: () => calls.push(["recovery"]),
  saveCache: () => calls.push(["cache"]),
  getObservability: () => sandbox.window.NOVEL_OBSERVABILITY,
};
const Persistence = Factory.create(deps);

project.version = 1;
const first = Persistence.flushCurrent();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(Persistence.isSaving(), true);
project.version = 2;
const second = Persistence.flushCurrent();
releaseFirst();
await Promise.all([first, second]);
assert.deepEqual(
  calls.filter((entry) => entry[0] === "save").map((entry) => entry.slice(1)),
  [
    [1, 1],
    [2, 2],
  ],
  "overlapping saves must serialize and the second run must read the latest project state"
);
assert.equal(Persistence.isSaving(), false);
assert.equal(clean.length, 2);
assert.equal(project.runtimeDiagnostics.filter((event) => event.type === "storage").length, 2);
assert.ok(project.runtimeDiagnostics.every((event) => !JSON.stringify(event).includes("version")));

let bookSaved = false;
const fileOnly = Factory.create({
  ...deps,
  mergeWorkspace: () => false,
  saveWorkspaceOnly: async (_project, options) => {
    assert.equal(options.announce, true);
    calls.push(["file-only-current"]);
  },
  saveBook: async () => {
    bookSaved = true;
    return {};
  },
});
await fileOnly.flushCurrent();
assert.equal(bookSaved, false, "an unmatched chapter file must not be followed by a whole-book overwrite");

const offlineCalls = [];
const offline = Factory.create({
  ...deps,
  isOnline: () => false,
  bumpRevision: () => offlineCalls.push("bump"),
  saveRecovery: () => offlineCalls.push("recovery"),
  saveCache: () => offlineCalls.push("cache"),
  mergeWorkspace: () => true,
});
await offline.flushProject(project);
assert.deepEqual(offlineCalls, ["bump", "recovery", "cache"]);
assert.equal(project.updatedAt, 123);
assert.equal(project._dirty, true);

const conflicted = Factory.create({ ...deps, hasPendingConflict: () => true });
await assert.rejects(() => conflicted.flushProject(project), /尚未处理的章节保存冲突/);
assert.equal(project.lastFailure.category, "conflict");
assert.equal(project.lastFailure.retry.safe, false);

const failedSave = Factory.create({
  ...deps,
  saveBook: async () => {
    throw new Error("sk-secret and chapter body must stay out");
  },
});
await assert.rejects(() => failedSave.flushProject(project), /sk-secret/);
assert.equal(project.lastFailure.category, "storage");
assert.equal(project.lastFailure.code, "STORAGE_SAVE_FAILED");
assert.ok(!JSON.stringify(project.lastFailure).includes("sk-secret"));

const workspaceProject = {
  slug: "book",
  chapters: [{ id: "c1", title: "开门", _file: "章节/001-开门.md", body: "旧正文", taskId: "t1" }],
};
let changedChapter = null;
const merged = Factory.mergeWorkspaceChapter(
  workspaceProject,
  {
    slug: "book",
    dirty: true,
    path: "章节/001-开门.md",
    content: "# 开门\n\n新正文",
  },
  {
    chapterBodyFromMarkdown: (value) => value.split("\n\n").at(-1),
    onBodyChanged: (chapter) => {
      changedChapter = chapter;
    },
    now: () => 456,
  }
);
assert.equal(merged, true);
assert.equal(workspaceProject.chapters[0].body, "新正文");
assert.equal(workspaceProject.chapters[0].updatedAt, 456);
assert.equal(changedChapter, workspaceProject.chapters[0]);
assert.equal(
  Factory.mergeWorkspaceChapter(workspaceProject, { slug: "other", dirty: true, path: "章节/001.md" }),
  null,
  "另一作品的工作区快照不得串书"
);

const formProject = {
  ideaInput: "旧意向",
  targetChapters: 10,
  locks: { logline: "旧主线", forbidden: [], mustHonor: [], lockedFields: [] },
  styleBible: { pacing: "快", dialogue: "简洁" },
  spine: {},
  graph: { nodes: [], edges: [] },
  _locksFormReady: true,
  _graphFormReady: true,
};
const form = {
  ideaInput: "新意向",
  targetChapters: "20",
  locks: {
    logline: "新主线",
    forbidden: "失忆\n降智",
    mustHonor: "主角主动",
    world: true,
    style: {
      pov: "第三人称",
      pacing: "快；对白简洁",
      dialogue: "简洁",
      rules: "场面优先",
      examples: "例一\n\n例二",
    },
  },
  graphJson: '{"edges":[],"nodes":[{"id":"a"}]}',
};
assert.equal(
  Factory.applyProjectForm(formProject, form, {
    normalizeTargetChapters: Number,
    recoverStylePacing: (value) => value.replace(/；对白简洁$/, ""),
  }),
  true
);
assert.equal(formProject.targetChapters, 20);
assert.equal(formProject.spine.logline, "新主线");
assert.equal(formProject.styleBible.pacing, "快");
assert.equal(formProject.graph.nodes[0].id, "a");
assert.equal(
  Factory.applyProjectForm(formProject, form, {
    normalizeTargetChapters: Number,
    recoverStylePacing: (value) => value.replace(/；对白简洁$/, ""),
  }),
  false,
  "同一表单二次同步必须幂等，不能制造假脏"
);
Factory.applyProjectForm(formProject, { graphJson: "{" });
assert.equal(formProject.graph.nodes[0].id, "a", "半截图谱 JSON 不得覆盖内存图谱");

const markdown = Factory.buildExportMarkdown({
  title: "测试书",
  slug: "test-book",
  chapters: [{ title: "第二章", order: 2, body: "后" }, { title: "第一章", order: 1, body: "先" }],
});
assert.match(markdown, /^# 测试书/);
assert.ok(markdown.indexOf("### 第一章") < markdown.indexOf("### 第二章"));

console.log("test_persistence_use_cases: OK");
