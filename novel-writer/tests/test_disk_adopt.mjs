import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {
  window: {},
  URLSearchParams,
  location: { search: "", pathname: "/", hash: "" },
  history: { replaceState: () => {} },
  fetch: async () => {
    throw new Error("network is not used in this unit test");
  },
  localStorage: (() => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
  })(),
  console,
};

vm.runInNewContext(fs.readFileSync(path.join(root, "vault.js"), "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root, "store.js"), "utf8"), sandbox);
const Vault = sandbox.window.NOVEL_VAULT;
const Store = sandbox.window.NOVEL_STORE;

const clean = Vault.classifyDiskAdopt({});
assert.equal(clean.ok, true);
assert.equal(clean.code, "ok");

const flagCases = [
  ["generating", "generating"],
  ["saveInFlight", "saveInFlight"],
  ["pendingConflict", "conflict"],
  ["dirty", "dirty"],
  ["editorDesynced", "editorDesynced"],
  ["workspaceChapterDirty", "workspaceDirty"],
];
for (const [flag, code] of flagCases) {
  const verdict = Vault.classifyDiskAdopt({ [flag]: true });
  assert.equal(verdict.ok, false, `${flag} must block silent disk adopt`);
  assert.equal(verdict.code, code, `${flag} must report code ${code}`);
  assert.ok(String(verdict.reason || "").trim(), `${flag} must have an author-facing reason`);
}

const queued = { id: "c1", body: "作者还没存的句子" };
const disk = { id: "c1", body: "磁盘旧稿" };
const liveReplaced = { id: "c1", body: "磁盘旧稿" };
const liveEdited = { id: "c1", body: "作者继续改过" };
assert.equal(
  Vault.pickLocalChapterForConflictDisplay(queued, liveReplaced, disk).body,
  "作者还没存的句子",
  "memory already replaced by disk must still show the queued local draft"
);
assert.equal(Vault.pickLocalChapterForConflictDisplay(queued, liveEdited, disk).body, "作者继续改过");
assert.equal(Vault.pickLocalChapterForConflictDisplay(null, liveEdited, disk).body, "作者继续改过");
assert.equal(Vault.pickLocalChapterForConflictDisplay(queued, null, disk).body, "作者还没存的句子");
assert.equal(Vault.chapterBodiesDiverge(queued, disk), true);
assert.equal(Vault.chapterBodiesDiverge(queued, { body: queued.body }), false);
assert.equal(Vault.chapterBodiesDiverge(null, disk), false);

const localBook = {
  _path: "old",
  chapters: [{ id: "c1", body: "内存未存盘正文", _file: "章节/001.md", _fileMtime: 10 }],
};
const diskBook = {
  _path: "new-path",
  _mtime: 99,
  chapters: [{ id: "c1", body: "磁盘会盖掉的正文", _file: "章节/001.md", _fileMtime: 88 }],
};
assert.equal(Vault.adoptDiskConcurrencyMeta(localBook, diskBook), 1);
assert.equal(localBook.chapters[0].body, "内存未存盘正文", "rename meta adopt must never copy body");
assert.equal(localBook.chapters[0]._fileMtime, 88);
assert.equal(localBook._path, "new-path");

const applySame = Store.shouldApplyRecoveredChapter(
  { body: "same", updatedAt: 1 },
  { body: "same", updatedAt: 9 }
);
assert.equal(applySame.apply, false);
assert.equal(applySame.keep, false);
const applyNewer = Store.shouldApplyRecoveredChapter(
  { body: "recovery", updatedAt: 50 },
  { body: "disk", updatedAt: 10 }
);
assert.equal(applyNewer.apply, true);
assert.equal(applyNewer.keep, true);
const keepBoth = Store.shouldApplyRecoveredChapter(
  { body: "recovery", updatedAt: 10 },
  { body: "disk", updatedAt: 50 }
);
assert.equal(keepBoth.apply, false);
assert.equal(keepBoth.keep, true);
const orphan = Store.shouldApplyRecoveredChapter({ body: "orphan", updatedAt: 1 }, null);
assert.equal(orphan.apply, false);
assert.equal(orphan.keep, true);

const recovered = {
  id: "rename-clock",
  slug: "rename-clock",
  chapters: [{ id: "c1", title: "第一章", order: 1, updatedAt: 500, body: "改书名后仍应救回的未存盘正文" }],
};
assert.equal(Store.saveRecovery(recovered), true);
const map = JSON.parse(sandbox.localStorage.getItem(Store.RECOVERY) || "{}");
map["rename-clock"].savedAt = 10;
sandbox.localStorage.setItem(Store.RECOVERY, JSON.stringify(map));
const afterRenameClock = {
  projects: [
    {
      id: "rename-clock",
      slug: "rename-clock",
      _mtime: 99999,
      updatedAt: 99999,
      chapters: [{ id: "c1", title: "第一章", order: 1, updatedAt: 100, body: "磁盘旧正文" }],
    },
  ],
};
assert.equal(
  Store.applyRecovery(afterRenameClock),
  1,
  "book.json mtime from rename must not expire a newer chapter recovery"
);
assert.equal(afterRenameClock.projects[0].chapters[0].body, "改书名后仍应救回的未存盘正文");
assert.equal(afterRenameClock.projects[0]._dirty, true);
const kept = JSON.parse(sandbox.localStorage.getItem(Store.RECOVERY) || "{}");
assert.ok(kept["rename-clock"], "applied recovery must stay until markClean/clearRecovery");

Store.clearRecovery(afterRenameClock.projects[0]);
const identical = {
  id: "same-body",
  slug: "same-body",
  chapters: [{ id: "c2", title: "二", order: 1, updatedAt: 1, body: "已在磁盘" }],
};
assert.equal(Store.saveRecovery(identical), true);
const identicalState = {
  projects: [
    {
      id: "same-body",
      slug: "same-body",
      _mtime: 1,
      chapters: [{ id: "c2", title: "二", order: 1, updatedAt: 9, body: "已在磁盘" }],
    },
  ],
};
assert.equal(Store.applyRecovery(identicalState), 0);
assert.equal(identicalState.projects[0]._dirty, undefined);
const afterSame = JSON.parse(sandbox.localStorage.getItem(Store.RECOVERY) || "{}");
assert.equal(afterSame["same-body"], undefined, "chapters already on disk drop the recovery key");

console.log("test_disk_adopt: OK");
