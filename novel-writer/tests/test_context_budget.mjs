import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "context-budget.js"), "utf8"), sandbox, {
  filename: path.join(root, "context-budget.js"),
});
const budget = sandbox.window.NOVEL_CONTEXT_BUDGET;
assert.equal(typeof budget?.allocateBlocks, "function");

assert.ok(budget.estimateTokens("中文测试") > budget.estimateTokens("test"));
const clipped = budget.clipToDualBudget("甲".repeat(500), 120, 100);
assert.ok(clipped.length <= 120);
assert.ok(budget.estimateTokens(clipped) <= 100);
assert.match(clipped, /按上下文预算截断/);

const blocks = [
  { k: "lock", t: `【锁定】${"甲".repeat(780)}`, keep: true },
  { k: "task", t: `【任务】${"乙".repeat(580)}`, keep: true },
  { k: "body", t: `【正文】${"丙".repeat(480)}`, keep: true },
  { k: "memory", t: `【摘要】${"丁".repeat(380)}` },
];
const options = {
  budget: 1200,
  tokenBudget: 1100,
  discipline: "【纪律】不得改写锁定事实",
};
const first = budget.allocateBlocks(blocks, options);
const second = budget.allocateBlocks(blocks, options);

assert.deepEqual(first, second, "相同输入的预算分配必须完全可复现");
assert.ok(first.packed.length <= options.budget);
assert.ok(budget.estimateTokens(first.packed) <= options.tokenBudget);
for (const required of ["lock", "task", "body"]) {
  assert.ok(first.used.includes(required), `${required} 必须获得预留预算`);
}
assert.ok(first.truncated.some((item) => item.key === "lock"));
assert.ok(first.omitted.includes("memory"));
assert.equal(first.blockStats.find((item) => item.key === "body").used, true);

const roomy = budget.allocateBlocks(
  [
    { k: "lock", t: "锁定事实", keep: true },
    { k: "task", t: "本章任务", keep: true },
  ],
  { budget: 1000, tokenBudget: 800, discipline: "写作纪律" }
);
assert.ok(roomy.used.includes("discipline"));
assert.match(roomy.packed, /写作纪律/);

console.log("test_context_budget: OK");
