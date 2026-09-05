import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const clicks = [];
let listener = null;
const sandbox = {
  window: {
    NOVEL_OBSERVABILITY: {
      exportReport: () => ({ summary: { events: 4, failures: 1 }, events: [] }),
    },
  },
  console,
  Date,
  Blob: class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
    }
  },
  URL: {
    createObjectURL: () => "blob:diagnostics",
    revokeObjectURL: () => {},
  },
  document: {
    createElement: () => ({
      href: "",
      download: "",
      click() {
        clicks.push({ href: this.href, download: this.download });
      },
    }),
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-diagnostics-ui.js"), "utf8"), sandbox, {
  filename: path.join(root, "runtime-diagnostics-ui.js"),
});
const UI = sandbox.window.NOVEL_DIAGNOSTICS_UI;

assert.equal(UI.descriptor({ name: "AbortError" }, "cancel").auto, "已停止");
assert.match(UI.descriptor({ code: "REVISION_FAILED", message: "x" }, "quality").alert, /原稿已保留/);
assert.match(UI.descriptor({ message: "x" }, "handoff").alert, /章后交接未完成/);
assert.equal(UI.descriptor({ message: "x" }, "conflict").vault[0], "存在磁盘版本冲突");

const effects = [];
UI.handleWriteFailure({ code: "QUALITY_GATE_BLOCKED", message: "blocked" }, "quality", null, {
  alert: (value) => effects.push(["alert", value]),
  log: (value) => effects.push(["log", value]),
  setStatus: (...value) => effects.push(["status", ...value]),
  setAutoStatus: (value) => effects.push(["auto", value]),
  refreshWrite: () => effects.push(["refresh"]),
  console: { warn: () => effects.push(["warn"]) },
});
assert.ok(effects.some(([type]) => type === "alert"));
assert.ok(effects.some(([type]) => type === "refresh"));

const project = {
  activeChapterId: "c2",
  activeTaskId: "t2",
  chapters: [{ id: "c2", taskId: "t2", production: { stage: "quality-review" } }],
  tasks: [{ id: "t2", lastErrorStage: "revision" }],
};
const context = UI.failureContext(project);
assert.equal(context.chapter.id, "c2");
assert.equal(context.task.id, "t2");
assert.equal(context.stage, "revision");

const meta = { textContent: "" };
const statuses = [];
UI.bindDiagnosticsExport({
  button: { addEventListener: (_type, callback) => (listener = callback) },
  getProject: () => project,
  syncEditor: () => effects.push(["sync"]),
  setStatus: (...value) => statuses.push(value),
  meta,
  alert: (value) => effects.push(["alert", value]),
});
assert.equal(typeof listener, "function");
listener();
assert.equal(clicks.length, 1);
assert.match(clicks[0].download, /^inkwell-diagnostics-\d+\.json$/);
assert.match(meta.textContent, /4 条事件/);
assert.deepEqual(statuses, [["脱敏诊断报告已导出", ""]]);

console.log("test_runtime_diagnostics_ui: OK");
