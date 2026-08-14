import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "graph-view.js"), "utf8");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const Graph = sandbox.window.NOVEL_GRAPH_VIEW;

assert.ok(Graph, "NOVEL_GRAPH_VIEW must load");

const empty = Graph.layoutNodes([]);
assert.equal(Array.isArray(empty), true);
assert.equal(empty.length, 0);

const one = Graph.layoutNodes([{ id: "a", label: "林清" }], { width: 400, height: 200 });
assert.equal(one.length, 1);
assert.equal(one[0].x, 200);
assert.equal(one[0].y, 100);

const two = Graph.layoutNodes(
  [
    { id: "a", label: "林清" },
    { id: "b", label: "谢宴" },
  ],
  { width: 400, height: 200 }
);
assert.equal(two.length, 2);
assert.ok(two[0].x < two[1].x);

const ring = Graph.layoutNodes(
  Array.from({ length: 8 }, (_, index) => ({ id: `n${index}` })),
  { width: 600, height: 400 }
);
assert.equal(ring.length, 8);
const xs = ring.map((item) => item.x);
const ys = ring.map((item) => item.y);
assert.ok(Math.min(...xs) < 300 && Math.max(...xs) > 300);
assert.ok(Math.min(...ys) < 200 && Math.max(...ys) > 200);

const fat = {
  nodes: Array.from({ length: 50 }, (_, index) => ({ id: `n${index}`, label: `人${index}` })),
  edges: Array.from({ length: 40 }, (_, index) => ({
    source: "n0",
    target: `n${index + 1}`,
  })),
};
const picked = Graph.pickVisibleNodes(fat);
assert.equal(picked.nodes.length, Graph.MAX_VISIBLE_NODES);
assert.equal(picked.truncated, 50 - Graph.MAX_VISIBLE_NODES);
assert.equal(picked.nodes[0].id, "n0");
