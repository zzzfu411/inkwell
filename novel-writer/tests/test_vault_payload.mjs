import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {
  window: {
    NOVEL_RAG: {
      serializeIndex: (index) => ({
        version: index.version,
        builtAt: index.builtAt,
        _sig: index._sig,
        docs: index.docs,
      }),
    },
  },
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
const Vault = sandbox.window.NOVEL_VAULT;
const payload = Vault.prepareProjectForSave({
  slug: "book",
  chapters: [{ id: "c1", body: "body" }],
  ragIndex: {
    version: 3,
    builtAt: 1,
    _sig: "sig",
    docs: [{ id: "d1", text: "text" }],
    inverted: { text: [0] },
    docLen: [1],
    N: 1,
  },
  _lastRag: { hits: ["ephemeral"] },
  _saveWarnings: [{ kind: "old" }],
});

assert.equal(payload.slug, "book");
assert.equal(payload.chapters[0].body, "body");
assert.equal(payload.ragIndex._sig, "sig");
assert.equal(payload.ragIndex.inverted, undefined);
assert.equal(payload._lastRag, undefined);
assert.equal(payload._lastContextManifest, undefined);
assert.equal(payload._saveWarnings, undefined);

const localAfterSave = {
  chapters: [{ id: "c1", title: "第一章", order: 1, body: "内存旧稿", _file: "章节/001-第一章.md" }],
};
const diskAfterSave = {
  chapters: [
    { id: "c1", title: "第一章", order: 1, body: "磁盘新版", _file: "章节/001-第一章.md", _fileMtime: 88 },
    { id: "c2", title: "外部新增", order: 2, body: "新增正文", _file: "章节/002-外部新增.md", _fileMtime: 89 },
  ],
};
const reconciled = Vault.reconcileSavedBook(localAfterSave, diskAfterSave, [
  { kind: "externalConflict", path: "章节/001-第一章.md" },
  { kind: "preservedExternal", path: "章节/002-外部新增.md" },
]);
assert.equal(reconciled.conflicts.length, 1);
assert.equal(reconciled.conflicts[0].localChapter.body, "内存旧稿", "reconcile must not silently overwrite memory");
assert.equal(reconciled.conflicts[0].diskChapter.body, "磁盘新版");
assert.equal(reconciled.added.length, 1);
assert.equal(localAfterSave.chapters.length, 2);
assert.equal(localAfterSave.chapters[1].body, "新增正文");

// 保存后必须换基线：否则同一次会话里第二次改同一章会被判成外部修改，作者存不进正文。
const baselineProject = {
  chapters: [
    { id: "c1", title: "第一章", order: 1, _file: "章节/001-第一章.md", _fileMtime: 100 },
    { id: "c2", title: "改过名", order: 2, _file: "章节/002-旧名.md", _fileMtime: 100 },
    { id: "c3", title: "冲突章", order: 3, _file: "章节/003-冲突章.md", _fileMtime: 100 },
    { id: "c4", title: "被保留", order: 4, _file: "章节/004-被保留.md", _fileMtime: 100 },
  ],
};
const adopted = Vault.adoptChapterBaselines(
  baselineProject,
  {
    chapterBaselines: [
      { id: "c1", order: 1, file: "章节/001-第一章.md", mtime: 900 },
      { id: "c2", order: 2, file: "章节/002-新名.md", mtime: 901 },
      { id: "c3", order: 3, file: "章节/003-冲突章.md", mtime: 902 },
      { id: "c4", order: 4, file: "章节/004-被保留.md", mtime: 903 },
    ],
  },
  [
    { kind: "externalConflict", path: "章节/003-冲突章.md" },
    { kind: "preservedExternal", path: "章节/004-被保留.md" },
  ]
);
assert.equal(adopted, 2);
assert.equal(baselineProject.chapters[0]._fileMtime, 900);
assert.equal(
  baselineProject.chapters[1]._file,
  "章节/002-新名.md",
  "改名后必须跟着服务端的新文件名，否则下一次保存找不到旧文件"
);
assert.equal(baselineProject.chapters[1]._fileMtime, 901);
assert.equal(
  baselineProject.chapters[2]._fileMtime,
  100,
  "冲突章不得换基线：磁盘版本还等作者裁决，换了下一次保存就静默覆盖"
);
assert.equal(baselineProject.chapters[3]._fileMtime, 100, "被保留的磁盘章同样不得换基线");
assert.equal(Vault.adoptChapterBaselines({ chapters: [] }, { chapterBaselines: [] }, []), 0);
assert.equal(Vault.adoptChapterBaselines(null, null, null), 0);

vm.runInNewContext(fs.readFileSync(path.join(root, "store.js"), "utf8"), sandbox);
const Store = sandbox.window.NOVEL_STORE;
Store.saveCfg({ apiKey: "must-not-enter-local-storage", theme: "ink-night" });
assert.equal(Store.loadCfg().apiKey || "", "", "API key must not persist in browser localStorage");
assert.equal(Store.loadCfg().theme, "ink-night");
const offlineCache = Store.slimForCache({
  projects: [{ slug: "", chapters: [{ id: "draft", body: "唯一的离线正文" }] }],
});
assert.equal(offlineCache.projects[0].chapters[0].body, "唯一的离线正文");
const vaultCache = Store.slimForCache({
  projects: [{ slug: "book", chapters: [{ id: "saved", body: "磁盘已有正文" }] }],
});
assert.equal(vaultCache.projects[0].chapters[0].body, "");
const dirtyVaultCache = Store.slimForCache({
  projects: [{ slug: "book", _dirty: true, chapters: [{ id: "dirty", body: "未落盘正文" }] }],
});
assert.equal(dirtyVaultCache.projects[0].chapters[0].body, "未落盘正文");

const dirtyProject = {
  id: "book-id",
  slug: "book",
  updatedAt: 200,
  chapters: [{ id: "c1", title: "第一章", order: 1, updatedAt: 200, body: "恢复正文" }],
};
assert.equal(Store.saveRecovery(dirtyProject), true);
const diskState = {
  projects: [
    {
      id: "book-id",
      slug: "book",
      _mtime: 1,
      updatedAt: 1,
      chapters: [{ id: "c1", title: "第一章", order: 1, updatedAt: 1, body: "旧正文" }],
    },
  ],
};
assert.equal(Store.applyRecovery(diskState), 1);
assert.equal(diskState.projects[0].chapters[0].body, "恢复正文");
assert.equal(diskState.projects[0]._dirty, true);
Store.clearRecovery(diskState.projects[0]);
assert.equal(sandbox.localStorage.getItem(Store.RECOVERY), null);

const stubRecovery = {
  id: "stub-book",
  slug: "stub-book",
  updatedAt: 1,
  chapters: [{ id: "c9", title: "章", order: 1, updatedAt: 999, body: "未落盘恢复" }],
};
assert.equal(Store.saveRecovery(stubRecovery), true);
const stubState = {
  projects: [
    {
      id: "stub-book",
      slug: "stub-book",
      _stub: true,
      updatedAt: Date.now(),
      chapters: [],
    },
  ],
};
assert.equal(Store.applyRecovery(stubState), 0);
const recoveryAfterStub = JSON.parse(sandbox.localStorage.getItem(Store.RECOVERY) || "{}");
assert.ok(recoveryAfterStub["stub-book"], "带 recovery 的 stub 不得丢掉该 key");
assert.equal(stubState.projects[0].chapters.length, 0);

console.log("test_vault_payload: OK");
