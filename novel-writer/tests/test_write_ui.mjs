import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {
  window: {},
  document: {
    createElement() {
      return { querySelector() { return null; }, querySelectorAll() { return []; } };
    },
  },
  console,
};
vm.runInNewContext(fs.readFileSync(path.join(root, "craft.js"), "utf8"), sandbox, {
  filename: path.join(root, "craft.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "write-ui.js"), "utf8"), sandbox, {
  filename: path.join(root, "write-ui.js"),
});
const UI = sandbox.window.NOVEL_WRITE_UI;
assert.ok(UI);

const identity = (text) => text;
assert.equal(UI.continuityPresentation({ body: "draft" }, identity).label, "未审查");
assert.equal(UI.continuityPresentation({ body: "draft", continuityReview: { bodySig: "old", status: "pass" } }, identity).label, "审查已过期");
for (const [status, label] of [["running", "审查中"], ["error", "审查失败"], ["pass", "本章审查通过"], ["skipped", "未审查"]]) {
  const view = UI.continuityPresentation({ body: "draft", continuityReview: { bodySig: "draft", status } }, identity);
  assert.equal(view.label, label);
  assert.equal(view.tone === "success", status === "pass");
}

const host = {
  html: "",
  innerHTML: "",
  querySelectorAll() {
    return [
      {
        querySelector(sel) {
          const field = String(sel).match(/data-beat-field="(\w+)"/)?.[1];
          const values = { place: "冷牢", action: "对质", turn: "被撞破", sensory: "血腥" };
          return { value: values[field] || "" };
        },
      },
    ];
  },
};
Object.defineProperty(host, "innerHTML", {
  set(value) {
    host.html = value;
  },
  get() {
    return host.html;
  },
});
UI.renderBeatPlan(host, { scenes: [{ place: "栈道", action: "潜入" }] }, { label: "推进" });
assert.match(host.html, /栈道/);
UI.renderBeatPlan(
  host,
  { scenes: [{ place: "栈道", action: "潜入" }] },
  { label: "推进" },
  { total: 1, covered: 0, missing: [{ index: 0 }] }
);
assert.match(host.html, /beat-gap/);
const hint = { text: "" };
Object.defineProperty(hint, "textContent", {
  set(value) {
    hint.text = value;
  },
  get() {
    return hint.text;
  },
});
UI.renderCraftHint(hint, { beatCoverage: { covered: 1, total: 2 }, dialogueRate: 0.2 });
assert.match(hint.text, /场面落地 1\/2/);
const collected = UI.collectBeatPlan(host, {});
assert.equal(collected.scenes[0].place, "冷牢");
assert.equal(collected.scenes[0].action, "对质");

assert.equal(UI.handoffPresentation(null).state, "empty");
assert.equal(
  UI.handoffPresentation({ body: "正文", production: { status: "needs_revision" } }).label,
  "待修订"
);
assert.equal(UI.handoffPresentation({ body: "正文", handoffStatus: "done" }).state, "done");
assert.equal(
  UI.handoffStatusSuffix({ body: "正文", handoffError: "模型超时" }, "待交接").suffix,
  "交接失败，待重试"
);
assert.equal(
  UI.chapterSavePresentation({ slug: "book", _dirty: true }, { vaultOnline: true }).state,
  "dirty"
);
assert.equal(
  UI.chapterSavePresentation({ slug: "book" }, { vaultOnline: true, hasPendingConflict: true }).state,
  "conflict"
);

const formControls = {
  ideaInput: { value: "新意向" },
  targetChapters: { value: "30" },
  lockLogline: { value: "锁定主线" },
  lockForbidden: { value: "失忆" },
  lockMust: { value: "兑现承诺" },
  lockWorld: { checked: true },
  stylePacing: { value: "快" },
  styleDialogue: { value: "简洁" },
  graphJson: { value: '{"nodes":[],"edges":[]}' },
};
const captured = UI.captureProjectForm((id) => formControls[id], { graphReady: true });
assert.equal(captured.ideaInput, "新意向");
assert.equal(captured.locks.world, true);
assert.equal(captured.locks.style.dialogue, "简洁");
assert.match(captured.graphJson, /nodes/);

const meter = UI.contextMeterText(
  {
    meta: {
      chars: 100,
      budget: 200,
      tokens: 50,
      tokenBudget: 100,
      used: ["task", "canon"],
      truncated: [{ key: "memory" }],
      omitted: ["rag"],
      rag: { mode: "local", hits: [{ id: 1 }] },
    },
  },
  { body: "正文", handoffStatus: "done" },
  { scenes: 2, completedScenes: 2, status: "accepted", overall: 8.5 }
);
assert.match(meter, /使用块: task, canon/);
assert.match(meter, /裁剪: memory/);
assert.match(meter, /章后记忆: 已交接/);

const chapterList = { html: "", onclick: null };
Object.defineProperty(chapterList, "innerHTML", {
  set(value) {
    this.html = value;
  },
  get() {
    return this.html;
  },
});
let selected = "";
const presenter = UI.createPresenter({
  getElementById: (id) => (id === "chapterList" ? chapterList : null),
});
const total = presenter.renderChapterList(
  { activeChapterId: "c1" },
  [
    { id: "c1", title: "第一章", body: "四个字", handoffStatus: "done" },
    { id: "c2", title: "第二章", body: "正文" },
  ],
  { countWords: (value) => value.length, onSelect: (id) => (selected = id) }
);
assert.equal(total, 5);
assert.match(chapterList.html, /class="chap active"/);
assert.match(chapterList.html, /已交接/);
chapterList.onclick({
  target: { closest: () => ({ dataset: { chapterId: "c2" } }) },
  preventDefault() {},
});
assert.equal(selected, "c2");
console.log("test_write_ui: OK");
