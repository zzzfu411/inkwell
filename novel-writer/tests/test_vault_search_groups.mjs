import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "vault-ui.js"), "utf8"), sandbox, {
  filename: "vault-ui.js",
});
const UI = sandbox.window.NOVEL_VAULT_UI;

const hits = [
  { path: "章节/001-开场.md" },
  { path: "关系/graph.json" },
  { path: "记忆/entity-states.json" },
  { path: "记忆/canon.json" },
  { path: "记忆/plot-loops.json" },
  { path: "资料/采访.md" },
  { path: "章节/002-转场.md", group: "canon" },
];

assert.equal(UI.searchGroupForHit(hits[0]), "chapter");
assert.equal(UI.searchGroupForHit(hits[1]), "character");
assert.equal(UI.searchGroupForHit(hits[2]), "character");
assert.equal(UI.searchGroupForHit(hits[3]), "canon");
assert.equal(UI.searchGroupForHit(hits[4]), "loop");
assert.equal(UI.searchGroupForHit(hits[5]), "other");
assert.equal(UI.searchGroupForHit(hits[6]), "canon", "an explicit backend group wins");

const grouped = Array.from(UI.groupSearchHits(hits), (group) => ({
  id: group.id,
  count: group.hits.length,
}));
assert.deepEqual(grouped, [
  { id: "chapter", count: 1 },
  { id: "character", count: 2 },
  { id: "canon", count: 2 },
  { id: "loop", count: 1 },
  { id: "other", count: 1 },
]);

console.log("test_vault_search_groups: OK");
