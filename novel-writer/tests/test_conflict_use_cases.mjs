import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "conflict-use-cases.js"), "utf8"), sandbox, {
  filename: path.join(root, "conflict-use-cases.js"),
});
const Conflicts = sandbox.window.NOVEL_CONFLICT_USE_CASES;

const project = {
  id: "project-1",
  slug: "book-1",
  chapters: [
    { id: "chapter-1", _file: "章节/001.md", body: "本地正文" },
    { id: "chapter-2", _file: "章节/002.md", body: "相同正文" },
  ],
};
const queue = [];
const fresh = {
  chapters: [
    { id: "chapter-1", _file: "章节/001.md", body: "磁盘正文" },
    { id: "chapter-2", _file: "章节/002.md", body: "相同正文" },
  ],
};

const enqueued = Conflicts.enqueueDiverged(queue, project, fresh, {
  diverges: (left, right) => left?.body !== right?.body,
  detectedRevision: 7,
  now: () => 99,
});
assert.equal(enqueued.added, 1);
assert.equal(queue.length, 1);
assert.equal(queue[0].detectedRevision, 7);
assert.equal(queue[0].detectedAt, 99);
assert.equal(queue[0].localChapter.body, "本地正文");
assert.equal(queue[0].diskChapter.body, "磁盘正文");
assert.equal(Conflicts.hasPending(queue, project), true);
assert.equal(Conflicts.chapterMatches(project.chapters[0], queue[0]), true);
assert.equal(Conflicts.findLocalChapter(project, queue[0]), project.chapters[0]);

fresh.chapters[0].body = "磁盘更新二";
assert.equal(Conflicts.refreshDiskSides(queue, project, fresh), 1);
assert.equal(queue[0].diskChapter.body, "磁盘更新二");

const restoredProject = { id: "project-1", slug: "book-1", chapters: [] };
const hydrated = Conflicts.hydrateProject(queue, restoredProject);
assert.equal(hydrated.hydrated, 1);
assert.equal(restoredProject._dirty, true);
assert.equal(restoredProject.chapters[0].body, "本地正文");
assert.equal(queue[0].localChapter, restoredProject.chapters[0]);

assert.equal(Conflicts.filterExisting(queue, [restoredProject]).length, 1);
assert.equal(Conflicts.filterExisting(queue, [{ id: "other", slug: "other" }]).length, 0);
const dropped = Conflicts.dropProject(queue, restoredProject, ["old-slug"]);
assert.equal(dropped.entries.length, 0);
assert.equal(dropped.removed.length, 1);

const original = { nested: { value: 1 } };
const cloned = Conflicts.clonePlain(original);
cloned.nested.value = 2;
assert.equal(original.nested.value, 1);

// 应用用例实例持有队列，但所有 I/O/生产状态/UI 都只经端口发生。
const managedProject = {
  id: "managed-project",
  slug: "managed-book",
  chapters: [{ id: "managed-chapter", _file: "章节/001.md", body: "当前正文", taskId: "task-1" }],
  tasks: [{ id: "task-1" }],
};
let persisted = [
  {
    warning: { kind: "externalConflict", path: "章节/001.md" },
    localChapter: { ...managedProject.chapters[0] },
    diskChapter: { ...managedProject.chapters[0], body: "磁盘正文", _fileMtime: 8 },
    projectId: managedProject.id,
    slug: managedProject.slug,
    detectedRevision: 1,
  },
];
let invalidated = "";
let flushed = 0;
const Manager = Conflicts.create({
  getProjects: () => [managedProject],
  getActiveProject: () => managedProject,
  loadPending: () => persisted,
  savePending: (entries) => {
    persisted = entries.map((entry) => ({ ...entry }));
    return true;
  },
  saveRecovery() {},
  clearRecovery() {},
  saveCache() {},
  setStatus() {},
  pickLocalChapter: (queued, live) => queued || live,
  revisionMatches: () => false,
  invalidateAfterAuthorEdit: (_chapter, _task, reason) => {
    invalidated = reason;
  },
  markHandoffStale() {},
  hideConflictModal() {},
  renderAllActive() {},
  async flushProject() {
    flushed += 1;
  },
  openNextConflict() {},
  now: () => 1234,
});
assert.equal(Manager.restore(), 1);
assert.equal(Manager.hasPending(managedProject), true);
const conflictView = Manager.activateNext();
assert.equal(conflictView.count, 1);
assert.equal(conflictView.localChapter.body, "当前正文");
await Manager.resolve("merge", { mergeBody: "作者合并正文" });
assert.equal(managedProject.chapters[0].body, "作者合并正文");
assert.match(invalidated, /手工合并/);
assert.equal(flushed, 1, "裁决后的本地版本必须通过统一保存端口落盘");
assert.equal(Manager.list().length, 0);
assert.equal(persisted.length, 0);

let conflictOpened = 0;
const reconciler = Conflicts.create({
  getProjects: () => [managedProject],
  getActiveProject: () => managedProject,
  reloadBook: async () => ({ chapters: [] }),
  reconcileSavedBook: () => ({
    added: [],
    conflicts: [
      {
        warning: { kind: "externalConflict", path: "章节/002.md" },
        localChapter: null,
        diskChapter: { id: "disk-2", _file: "章节/002.md", body: "外部正文" },
      },
    ],
  }),
  savePending: () => true,
  saveRecovery() {},
  saveCache() {},
  setActiveDirty() {},
  setStatus() {},
  renderActive() {},
  openNextConflict: () => {
    conflictOpened += 1;
  },
  now: () => 88,
});
const reconciled = await reconciler.reconcileWarnings(
  managedProject,
  [{ kind: "externalConflict", path: "章节/002.md" }],
  9
);
assert.equal(reconciled.conflicts, 1);
assert.equal(reconciler.list()[0].detectedRevision, 9);
assert.equal(conflictOpened, 1);

console.log("test_conflict_use_cases: OK");
