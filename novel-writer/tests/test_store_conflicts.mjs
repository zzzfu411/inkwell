import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = new Map();
const localStorage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  },
};
const context = {
  window: {},
  localStorage,
  crypto: { randomUUID: () => "test-id" },
  console,
};
for (const file of ["chapter-state.js", "project-migrations.js", "production-state.js", "store.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const Store = context.window.NOVEL_STORE;

const fresh = Store.defaultProject();
assert.equal(fresh.schemaVersion, 1);
assert.deepEqual(Array.from(fresh.schemaMigrationHistory), []);

localStorage.setItem(
  Store.KEY,
  JSON.stringify({ projects: [{ id: "legacy-cache", chapters: [], tasks: [] }], activeId: "legacy-cache" })
);
const migratedCache = Store.loadAll();
assert.equal(migratedCache.projects[0].schemaVersion, 1);
assert.equal(migratedCache.projects[0].schemaMigrationHistory[0].id, "project:0->1");
localStorage.removeItem(Store.KEY);

const pending = [
  {
    projectId: "project-1",
    slug: "book-1",
    detectedRevision: 7,
    warning: { kind: "externalConflict", path: "chapters/001.md" },
    localChapter: { id: "chapter-1", title: "Local", body: "local draft" },
    diskChapter: { id: "chapter-1", title: "Disk", body: "disk draft" },
  },
];

assert.equal(Store.savePendingConflicts(pending), true);
assert.ok(values.has(Store.PENDING_CONFLICTS));
pending[0].localChapter.body = "mutated after save";

const restored = Store.loadPendingConflicts();
assert.equal(restored.length, 1);
assert.equal(restored[0].projectId, "project-1");
assert.equal(restored[0].slug, "book-1");
assert.equal(restored[0].detectedRevision, 7);
assert.equal(restored[0].localChapter.body, "local draft");
assert.equal(restored[0].diskChapter.body, "disk draft");
assert.ok(restored[0].detectedAt > 0);
assert.equal(JSON.parse(values.get(Store.PENDING_CONFLICTS)).schemaVersion, 2);

assert.equal(Store.savePendingConflicts([]), true);
assert.equal(values.has(Store.PENDING_CONFLICTS), false);
assert.deepEqual(Array.from(Store.loadPendingConflicts()), []);

localStorage.setItem(Store.PENDING_CONFLICTS, "not-json");
assert.deepEqual(Array.from(Store.loadPendingConflicts()), []);

const projectOne = {
  id: "recovery-1",
  slug: "recovery-1",
  title: "Older",
  chapters: [{ id: "c1", title: "One", order: 1, updatedAt: 1, body: "a".repeat(2_000_000) }],
};
const projectTwo = {
  id: "recovery-2",
  slug: "recovery-2",
  title: "Newer",
  chapters: [{ id: "c2", title: "Two", order: 1, updatedAt: 2, body: "b".repeat(2_000_000) }],
};
assert.equal(Store.saveRecovery(projectOne), true);
assert.equal(Store.saveRecovery(projectTwo), true);
let recoveryMap = JSON.parse(localStorage.getItem(Store.RECOVERY));
let recoveryChars = Object.values(recoveryMap)
  .flatMap((row) => row.chapters || [])
  .reduce((sum, chapter) => sum + chapter.body.length, 0);
assert.ok(recoveryChars <= Store.RECOVERY_MAX_CHARS);
assert.ok(recoveryMap["recovery-2"], "newest recovery must survive global eviction");
assert.equal(recoveryMap["recovery-1"], undefined);

const oversized = {
  id: "recovery-3",
  slug: "recovery-3",
  title: "Oversized",
  chapters: [
    {
      id: "c3",
      title: "Three",
      order: 1,
      updatedAt: 3,
      body: "c".repeat(Store.RECOVERY_MAX_CHARS + 100),
    },
  ],
};
assert.equal(Store.saveRecovery(oversized), true);
recoveryMap = JSON.parse(localStorage.getItem(Store.RECOVERY));
assert.equal(recoveryMap["recovery-3"].chapters[0].body.length, Store.RECOVERY_MAX_CHARS);
assert.equal(recoveryMap["recovery-2"], undefined);

console.log("test_store_conflicts: OK");
