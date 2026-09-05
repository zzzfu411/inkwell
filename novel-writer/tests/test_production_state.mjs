import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "tests", "fixtures", "projects");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-state.js"), "utf8"), sandbox, {
  filename: path.join(root, "chapter-state.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "production-state.js"), "utf8"), sandbox, {
  filename: path.join(root, "production-state.js"),
});

const State = sandbox.window.NOVEL_PRODUCTION_STATE;
const copy = (value) => JSON.parse(JSON.stringify(value));

assert.equal(State.bodySignature("同一正文"), State.bodySignature("同一正文"));
assert.notEqual(State.bodySignature("正文甲"), State.bodySignature("正文乙"));

const accepted = {
  id: "ch-accepted",
  taskId: "task-accepted",
  body: "已经验收的正文",
  handoffStatus: "done",
  qualityReview: { overall: 9 },
  production: {
    status: "done",
    stage: "done",
    bodyAuthoritative: true,
    bodySig: State.bodySignature("已经验收的正文"),
    gate: { accepted: true },
    qualityReview: { overall: 9 },
    localMetrics: { lengthRatio: 1 },
    revisionPasses: 1,
  },
};
const matching = State.reconcileChapter(accepted);
assert.equal(matching.reason, "signature-match");
assert.equal(accepted.production.status, "done");
assert.equal(accepted.handoffStatus, "done");

const externallyEdited = copy(accepted);
externallyEdited.body = "磁盘工具改过的正文";
const mismatch = State.reconcileChapter(externallyEdited, {
  at: 42,
  reason: "外部正文变化",
});
assert.equal(mismatch.reason, "signature-mismatch");
assert.equal(externallyEdited.production.status, "needs_revision");
assert.equal(externallyEdited.production.stage, "quality-review");
assert.equal(externallyEdited.production.bodySig, "");
assert.equal(
  externallyEdited.production.invalidatedBodySig,
  State.bodySignature("磁盘工具改过的正文")
);
assert.equal(
  externallyEdited.production.invalidatedFromBodySig,
  State.bodySignature("已经验收的正文")
);
assert.equal(
  externallyEdited.production.authorEditedAt,
  undefined,
  "a disk reconciliation must not pretend the in-app author editor changed the body"
);
assert.equal(externallyEdited.production.gate, null);
assert.equal(externallyEdited.production.qualityReview, null);
assert.equal(externallyEdited.production.localMetrics, null);
assert.equal(externallyEdited.production.revisionPasses, 0);
assert.equal(externallyEdited.qualityReview, null);
assert.equal(externallyEdited.handoffStatus, "stale");
assert.equal(externallyEdited.handoffError, "外部正文变化");

const earlyV1 = {
  id: "ch-v1",
  taskId: "task-v1",
  body: "旧版已完成正文",
  production: { status: "done", stage: "done" },
};
const baselined = State.reconcileChapter(earlyV1, { at: 99 });
assert.equal(baselined.reason, "signature-baseline");
assert.equal(earlyV1.production.status, "done");
assert.equal(earlyV1.production.bodyAuthoritative, true);
assert.equal(earlyV1.production.bodySig, State.bodySignature(earlyV1.body));
assert.equal(earlyV1.production.signatureMigratedAt, 99);

const slimCacheChapter = {
  id: "ch-slim",
  body: "",
  production: {
    status: "done",
    bodyAuthoritative: true,
    bodySig: State.bodySignature("完整正文只在 Vault"),
  },
};
assert.equal(State.reconcileChapter(slimCacheChapter).reason, "body-not-hydrated");
assert.equal(slimCacheChapter.production.status, "done");

const project = {
  chapters: [
    {
      id: "ch-project",
      taskId: "task-project",
      body: "新版正文",
      production: {
        status: "done",
        bodyAuthoritative: true,
        bodySig: State.bodySignature("旧版正文"),
      },
    },
  ],
  tasks: [{ id: "task-project", status: "written" }],
};
const projectResult = State.reconcileProject(project, { reason: "项目恢复核对" });
assert.equal(projectResult.invalidated, 1);
assert.equal(project.tasks[0].status, "needs_revision");
assert.equal(project.tasks[0].lastErrorStage, "quality-gate");

const finalGuardChapter = copy(accepted);
finalGuardChapter.body = "绕过编辑器写入的新正文";
const strictVerdict = State.canHandoff(finalGuardChapter, {
  productionEngineEnabled: true,
  productionQualityPolicy: "strict",
});
assert.equal(strictVerdict.ok, false);
assert.equal(finalGuardChapter.production.status, "needs_revision");
assert.equal(
  State.canHandoff(finalGuardChapter, { productionQualityPolicy: "warn" }).ok,
  true,
  "warn compatibility policy remains an explicit escape hatch"
);
assert.equal(
  State.canHandoff(finalGuardChapter, {}, { qualityValidated: true }).ok,
  true,
  "a body validated in the current production transaction may hand off"
);

const legacy = { id: "legacy", body: "旧架构正文", handoffStatus: "done" };
assert.equal(State.invalidateAfterBodyEdit(legacy).reason, "legacy-chapter");
assert.equal(State.reconcileChapter(legacy).reason, "legacy-chapter");
assert.equal(State.canHandoff(legacy, { productionQualityPolicy: "strict" }).ok, true);

const externalFixture = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "schema-1-external-edit.json"), "utf8")
);
const externalResult = State.reconcileProject(externalFixture, { at: 77 });
assert.equal(externalResult.invalidated, 1);
assert.equal(externalFixture.tasks[0].status, "needs_revision");
assert.equal(externalFixture.chapters[0].handoffStatus, "stale");

const unvalidated = {
  body: "尚未验收的生产正文",
  production: { schemaVersion: 1, status: "pending", stage: "quality-review" },
};
assert.equal(
  State.canHandoff(unvalidated, {
    productionEngineEnabled: true,
    productionQualityPolicy: "strict",
  }).ok,
  false,
  "strict handoff must require a validated production state, not merely a non-blocked one"
);

console.log("test_production_state: OK");
