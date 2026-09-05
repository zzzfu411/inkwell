import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {} };
const filename = path.join(root, "production-quality.js");
vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
const Quality = sandbox.window.NOVEL_PRODUCTION_QUALITY;

assert.equal(Quality.VERSION, 1);
assert.deepEqual([...Quality.coverageTokens("")], []);
assert.ok(Quality.coverageTokens("撬锁，立刻撤离").includes("撬锁"));
assert.ok(Quality.coverageTokens("立刻撤离").includes("立刻"), "中文长词必须生成可落地的双字锚点");
assert.deepEqual([...Quality.coverageTokens("alpha beta")], ["alpha", "beta"]);
assert.equal(Quality.anyTokenInBody("跳入暗门", "他最终跳入了暗门"), true);
assert.equal(Quality.anyTokenInBody("跳入暗门", "他留在原地"), false);

assert.deepEqual(
  JSON.parse(JSON.stringify(Quality.sceneContractCoverage("正文", { scenes: [] }))),
  { rate: 0, total: 0, covered: 0, missing: [] }
);
const contract = {
  id: "contract-1",
  wordTarget: 100,
  hookEnd: "门外响起三声敲门",
  scenes: [
    { id: "s1", action: "撬开药柜", turn: "警报响起", outcome: "证据暴露" },
    { id: "s2", goal: "带证据撤离", turn: "电梯停摆", outcome: "跳入暗门" },
  ],
};
const fullBody = "她撬开药柜，警报响起，藏着的证据随即暴露。她带证据撤离时电梯停摆，只能跳入暗门。门外响起三声敲门。";
const grounded = Quality.sceneContractCoverage(fullBody, contract);
assert.equal(grounded.rate, 1);
assert.equal(grounded.lexicalRate, 1);
assert.equal(grounded.structuralRate, 0);
assert.equal(grounded.missing.length, 0);

const independentScene = Quality.sceneContractCoverage("完全无关的正文", contract, [
  { status: "complete", text: "", ledger: { wholeDraft: false } },
  { status: "pending", text: "带证据撤离，电梯停摆", ledger: { wholeDraft: false } },
]);
assert.equal(independentScene.rows[0].covered, true, "独立提交的逐场 checkpoint 可以作为结构证据");
assert.equal(independentScene.rows[1].covered, true);
assert.equal(independentScene.structuralRate, 0.5);
assert.ok(independentScene.rows[1].missing.includes("outcome"));

const wholeDraft = Quality.sceneContractCoverage("人物站着思考，什么也没做。", contract, [
  { status: "complete", text: "", ledger: { wholeDraft: true } },
  { status: "complete", text: "", ledger: { wholeDraft: true } },
]);
assert.equal(wholeDraft.rate, 0, "整章运行状态不得自证契约已经在正文落地");
assert.equal(wholeDraft.structuralRate, 1);
const emptyChecks = Quality.sceneContractCoverage("任意正文", { scenes: [{ id: "empty" }] }, ["not-an-object"]);
assert.equal(emptyChecks.rate, 1, "无可核对字段的场面不应制造假缺失");
assert.equal(emptyChecks.rows[0].generated, false);

let scorerInput;
const craft = {
  scoreChapterCraft(body, plan, options) {
    scorerInput = { body, plan, options };
    return {
      beatCoverage: { rate: 0.4, covered: 1, total: 2, missing: [{ place: "楼梯", action: "撤离" }] },
      dialogueRate: 0.2,
      sensoryCount: 3,
      issues: [{ severity: "blocker" }, { severity: "major" }, { severity: "minor" }],
    };
  },
  recentOpeningKinds: () => ["dialogue"],
};
const project = { styleBible: { voice: "克制" } };
const chapter = { body: fullBody, production: { scenes: [] } };
const local = Quality.localQuality(project, { id: "t1" }, chapter, contract, {}, {
  craft,
  previousChapter: () => ({ body: "上一章结尾" }),
  contractToBeatPlan: (value) => ({ scenes: value.scenes }),
});
assert.equal(scorerInput.body, fullBody);
assert.equal(scorerInput.options.prevBody, "上一章结尾");
assert.deepEqual([...scorerInput.options.recentKinds], ["dialogue"]);
assert.equal(local.beatCoverage.rate, 1, "正文契约覆盖率可以补强 craft 覆盖率");
assert.equal(local.hookPresent, true);
assert.equal(local.localProseScore, 3.75);
assert.equal(local.dialogueRate, 0.2);
assert.equal(local.sensoryCount, 3);

const fallbackLocal = Quality.localQuality({}, {}, { body: "短文" }, { wordTarget: 10, scenes: [], hookEnd: "未出现" });
assert.equal(fallbackLocal.beatCoverage.rate, 0);
assert.equal(fallbackLocal.hookPresent, false);
assert.equal(fallbackLocal.localProseScore, 8);
const sparseCraftLocal = Quality.localQuality({}, {}, { body: "尾声" }, { wordTarget: 0, scenes: [] }, {}, {
  craft: { scoreChapterCraft: () => ({ issues: null }) },
  contractToBeatPlan: null,
  previousChapter: null,
});
assert.equal(sparseCraftLocal.targetChars, 0);
assert.equal(sparseCraftLocal.dialogueRate, 0);

assert.equal(Quality.normalizeQualityIssue(null), null);
assert.equal(Quality.normalizeQualityIssue({}), null);
const normalizedIssue = Quality.normalizeQualityIssue({ message: "结构断裂", severity: "unknown", quote: "证据", suggestion: "补因果" });
assert.equal(normalizedIssue.severity, "major");
assert.equal(normalizedIssue.type, "quality");
assert.equal(normalizedIssue.evidence, "证据");
assert.equal(normalizedIssue.fix, "补因果");

const completeScores = {
  causalProgression: 8,
  characterAgency: 8,
  sceneCompletion: 8,
  povConsistency: 8,
  tension: 8,
  voice: 8,
  hook: 8,
  prose: 8,
};
const normalized = Quality.normalizeQuality(
  {
    verdict: "PASS",
    overall: 8.4,
    scores: completeScores,
    issues: [{ type: "voice", severity: "minor", summary: "一句偏直白" }],
    completed_contract: ["目标"],
    missing_contract: ["代价"],
    strengths: [{ summary: "因果清楚" }],
  },
  { beatCoverage: { rate: 1, missing: [] }, localProseScore: 7 },
  contract,
  {},
  { now: () => 1234, defaults: { productionMinSceneCoverage: 0.75 } }
);
assert.equal(normalized.verdict, "pass");
assert.equal(normalized.overall, 8.4);
assert.equal(normalized.at, 1234);
assert.equal(normalized.contractId, "contract-1");
assert.deepEqual([...normalized.completedContract], ["目标"]);
assert.deepEqual([...normalized.strengths], ["因果清楚"]);
assert.ok(normalized.issues.some((issue) => issue.summary === "契约未完成：代价"));
assert.deepEqual([...normalized.missingScores], []);

const incomplete = Quality.normalizeQuality(
  { verdict: "n/a", scores: { causalProgression: 9 }, missingContract: ["场面二", "场面二"] },
  { beatCoverage: { rate: 0.2, missing: [{ place: "后巷", action: "突围" }] }, localProseScore: 6 },
  {},
  { productionMinSceneCoverage: 0.8 },
  { now: () => 99 }
);
assert.equal(incomplete.verdict, "revise");
assert.equal(incomplete.scores.sceneCompletion, 2);
assert.equal(incomplete.scores.prose, 6);
assert.ok(incomplete.missingScores.includes("hook"));
assert.equal(incomplete.issues.filter((issue) => issue.type === "local-coverage").length, 1);
assert.equal(incomplete.issues.filter((issue) => issue.summary === "契约未完成：场面二").length, 1);
const emptyNormalized = Quality.normalizeQuality(null, null, null, {}, { now: () => 7 });
assert.equal(emptyNormalized.overall, 0);
assert.equal(emptyNormalized.at, 7);
assert.equal(emptyNormalized.missingScores.length, 8);
const deduplicatedCoverage = Quality.normalizeQuality(
  { verdict: "pass", issues: [{ type: "local-coverage", summary: "已经记录" }] },
  { beatCoverage: { rate: 0, missing: [] }, localProseScore: 0 },
  null,
  {},
  { now: () => 8 }
);
assert.equal(deduplicatedCoverage.issues.filter((issue) => issue.type === "local-coverage").length, 1);
assert.equal(deduplicatedCoverage.verdict, "revise");

const nullGate = Quality.qualityGate(null, {}, { defaults: {} });
assert.equal(nullGate.accepted, false);
assert.ok(nullGate.reasons.includes("没有可用的质量报告"));
const strictGate = Quality.qualityGate(
  {
    verdict: "revise",
    overall: 4,
    missingScores: ["hook"],
    local: {
      beatCoverage: { rate: 0.2 },
      sceneCoverage: { rate: 0.4 },
      hookPresent: false,
      lengthRatio: 0.3,
    },
    issues: [{ severity: "blocker" }, { severity: "minor" }],
  },
  { productionQualityPolicy: "strict" },
  {
    defaults: {
      productionMinQualityScore: 7,
      productionMinSceneCoverage: 0.75,
      productionMinLengthRatio: 0.55,
    },
  }
);
assert.equal(strictGate.accepted, false);
assert.equal(strictGate.hardIssues.length, 1);
assert.ok(strictGate.reasons.length >= 7);

const passReview = {
  verdict: "pass",
  overall: 8,
  missingScores: [],
  local: {
    beatCoverage: { rate: 1 },
    sceneCoverage: { rate: 1 },
    hookPresent: true,
    lengthRatio: 1,
  },
  issues: [{ severity: "minor" }],
};
assert.equal(Quality.qualityGate(passReview, { productionQualityPolicy: "strict" }).accepted, true);
assert.equal(
  Quality.qualityGate({ ...passReview, verdict: "revise" }, { productionQualityPolicy: "warn" }).accepted,
  true,
  "warn policy must retain reasons but not block a present report"
);
assert.equal(Quality.qualityGate(null, { productionQualityPolicy: "warn" }).accepted, false);

console.log("test_production_quality: OK");
