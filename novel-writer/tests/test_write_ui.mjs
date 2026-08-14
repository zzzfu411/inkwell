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
vm.runInNewContext(fs.readFileSync(path.join(root, "craft.js"), "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root, "write-ui.js"), "utf8"), sandbox);
const UI = sandbox.window.NOVEL_WRITE_UI;
assert.ok(UI);

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
console.log("test_write_ui: OK");
