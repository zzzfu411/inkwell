import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "analyze-ui.js"), "utf8");

function loadWith(deleteImpl) {
  const window = {
    NOVEL_VAULT: { fsDelete: deleteImpl },
  };
  const context = {
    window,
    document: { getElementById: () => null },
    console,
    alert: () => {},
  };
  vm.runInNewContext(source, context, { filename: "analyze-ui.js" });
  const ui = window.NOVEL_ANALYZE_UI;
  ui.init({ vaultOnline: () => true });
  return ui;
}

const missingPaths = [];
const missing = loadWith(async (_slug, path) => {
  missingPaths.push(path);
  const error = new Error("missing");
  error.status = 404;
  throw error;
});
await missing.clearCheckpoint("book-one");
assert.equal(missingPaths.length, 6, "all optional checkpoint paths should be attempted");
assert.ok(missingPaths.includes("分析/report.md"), "the generated author report is cleared with its checkpoint");

const tauriMissing = loadWith(async () => {
  const error = new Error("not found: 分析/meta.json");
  error.status = 400;
  throw error;
});
await tauriMissing.clearCheckpoint("book-two");

let attempts = 0;
const denied = loadWith(async () => {
  attempts += 1;
  const error = new Error("permission denied");
  error.status = 500;
  throw error;
});
await assert.rejects(
  denied.clearCheckpoint("book-three"),
  /无法清理旧分析检查点 分析\/extractions：permission denied/
);
assert.equal(attempts, 1, "cleanup must stop before starting a mixed old/new analysis state");

console.log("test_analyze_cleanup: OK");
