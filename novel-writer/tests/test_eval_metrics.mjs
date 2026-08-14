import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareMetrics,
  computeMetrics,
  evaluateThresholds,
  scoreProjectFile,
} from "../scripts/eval-continuity.mjs";

const metrics = computeMetrics({
  tasks: [{ status: "done" }, { status: "pending" }],
  chapters: [
    {
      order: 1,
      body: "夜色沉沉，大雾漫过栈道。",
      openingKind: "weather",
      beatPlan: { scenes: [{ place: "栈道", action: "潜入" }, { place: "冷牢", action: "对质" }] },
      handoffStatus: "done",
    },
    {
      order: 2,
      body: "夜色再次压下来，雾更浓了。",
      openingKind: "weather",
      beatPlan: { scenes: [] },
      handoffStatus: "stale",
    },
  ],
  continuityReviews: [{ issues: [{ severity: "blocker" }, { severity: "major" }] }],
  continuityIssues: [
    { status: "open", type: "style" },
    { status: "handled", type: "repetition" },
  ],
  plotLoops: [{ status: "resolved", reopenCount: 1 }, { status: "open" }],
  detailCanon: { conflicts: [{}] },
  contextManifests: [
    {
      rag: { indexSize: 10, hits: [{ id: "x" }] },
      stale: { previousChapterHandoff: "done" },
      truncated: [{ key: "canon" }],
    },
  ],
});

assert.equal(metrics.tasks.completionRate, 0.5);
assert.equal(metrics.continuity.blockers, 1);
assert.equal(metrics.continuity.canonConflicts, 1);
assert.equal(metrics.plotLoops.resolved, 1);
assert.equal(metrics.plotLoops.reopened, 1);
assert.equal(metrics.retrieval.hitCoverage, 1);
assert.equal(metrics.retrieval.coreTruncations, 1);
assert.equal(metrics.craft.openingCollisions, 1);
assert.equal(metrics.craft.openingCollisionRate, 1);
assert.equal(metrics.craft.beatCoverage, 0.5);
assert.equal(metrics.craft.styleIssues, 2);
assert.equal(metrics.craft.staleHandoffs, 1);

const better = computeMetrics({
  tasks: [{ status: "done" }, { status: "done" }],
  chapters: [
    {
      order: 1,
      body: "「你还要装？」林清问。冷牢潮气贴上她的腕，她把名册甩到石桌上对质。",
      openingKind: "dialogue",
      beatPlan: { scenes: [{ place: "冷牢", action: "对质" }, { place: "石桌", action: "名册" }] },
    },
    {
      order: 2,
      body: "她把药铲按在案上。「今晚不能再拖。」栈道风里有铁锈味，两人撤离时谁也没回头。",
      openingKind: "other",
      beatPlan: { scenes: [{ place: "案上", action: "药铲" }, { place: "栈道", action: "撤离" }] },
    },
  ],
  continuityReviews: [],
  continuityIssues: [],
  plotLoops: [],
  detailCanon: { conflicts: [] },
  contextManifests: [],
});
assert.equal(better.craft.openingCollisions, 0);
assert.equal(better.craft.beatCoverage, 1);
assert.ok(better.craft.beatSceneCoverage >= 0.9);
assert.ok(better.craft.dialogueRate > 0.05);
assert.equal(evaluateThresholds(better).pass, true);
assert.equal(evaluateThresholds(metrics).pass, false);

const compared = compareMetrics(metrics, better);
assert.equal(compared.improved, true);
assert.ok(compared.deltas.some((row) => row.path === "tasks.completionRate" && row.delta > 0));

const worse = compareMetrics(better, metrics);
assert.ok(worse.regressions.includes("continuity.blockers"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-eval-"));
const sample = path.join(tmp, "sample.json");
fs.writeFileSync(
  sample,
  JSON.stringify({
    tasks: [{ status: "done" }],
    chapters: [
      {
        order: 1,
        body: "「站住。」门边的人拦住去路。廊上灯火一晃，两人对峙。",
        openingKind: "dialogue",
        beatPlan: { scenes: [{ place: "门", action: "拦住" }, { place: "廊", action: "对峙" }] },
      },
    ],
    detailCanon: { conflicts: [] },
    continuityReviews: [],
    continuityIssues: [],
  }),
  "utf8"
);
const scored = scoreProjectFile(sample);
assert.equal(scored.metrics.tasks.completionRate, 1);
assert.equal(scored.verdict.pass, true);
fs.rmSync(tmp, { recursive: true, force: true });

const here = path.dirname(fileURLToPath(import.meta.url));
assert.ok(fs.existsSync(path.join(here, "..", "scripts", "eval-continuity.mjs")));
console.log("test_eval_metrics: OK");
