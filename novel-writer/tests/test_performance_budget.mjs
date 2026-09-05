import assert from "node:assert/strict";
import {
  BUDGETS,
  FIXTURE_SEED,
  SIZES,
  createFixture,
  evaluateResults,
} from "../scripts/performance-budget.mjs";

assert.equal(FIXTURE_SEED, "inkwell-scale-v1-2026-09");
assert.deepEqual(Array.from(SIZES), [20, 100, 400]);
for (const chapters of SIZES) {
  const fixture = createFixture(chapters);
  assert.equal(fixture.chapters.length, chapters);
  assert.equal(fixture.tasks.length, chapters);
  assert.equal(fixture.memoryRoll.length, chapters);
  assert.equal(fixture.activeChapterId, fixture.chapters.at(-1).id);
  assert.equal(fixture.activeTaskId, fixture.tasks.at(-1).id);
  assert.ok(BUDGETS[chapters].contextBuild.p95Ms > 0);
}

const passing = SIZES.map((chapters) => ({
  chapters,
  projectBytes: BUDGETS[chapters].maxProjectBytes,
  operations: Object.fromEntries(
    ["contextBuild", "saveSerialize", "exportMarkdown", "diagnosticsExport"].map((operation) => [
      operation,
      {
        medianMs: BUDGETS[chapters][operation].medianMs,
        p95Ms: BUDGETS[chapters][operation].p95Ms,
      },
    ])
  ),
}));
assert.deepEqual(evaluateResults(passing), { passed: true, failures: [] });

const regression = structuredClone(passing);
regression[2].operations.contextBuild.p95Ms = BUDGETS[400].contextBuild.p95Ms + 0.001;
const failed = evaluateResults(regression);
assert.equal(failed.passed, false);
assert.match(failed.failures.join("\n"), /400\/contextBuild: p95/);

console.log("test_performance_budget: OK");
