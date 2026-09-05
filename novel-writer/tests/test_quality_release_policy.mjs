import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPromotionEvidence,
  releaseEvidenceReference,
  validatePromotionEvidence,
  validateQualityReleaseRecord,
} from "../scripts/quality-release-evidence.mjs";
import { computeQualitySourceManifest } from "../scripts/quality-source-contract.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const previousWindow = globalThis.window;
globalThis.window = {};
await import("../quality-release-policy.js?quality-release-policy-test");
const Policy = globalThis.window.NOVEL_QUALITY_RELEASE_POLICY;
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;
const currentQualitySource = computeQualitySourceManifest(root);
const corpusHash = "a".repeat(64);

const hold = {
  schemaVersion: 2,
  decision: "hold",
  productionDefaultEnabled: false,
  evaluatedReport: null,
  qualitySourceFingerprint: currentQualitySource.fingerprint,
  reason: "真实证据尚未通过。",
};
assert.equal(Policy.validate(hold).ok, true);
assert.equal(Policy.resolve(hold).decision, "hold");
assert.equal(Object.isFrozen(Policy.resolve(hold)), true);
assert.equal(Policy.validate(null).ok, false);
assert.equal(Policy.resolve(null).qualitySourceFingerprint, "");
assert.equal(Policy.resolve(Object.freeze({ ...hold })).decision, hold.decision);

const invalidHold = {
  ...hold,
  schemaVersion: 1,
  productionDefaultEnabled: true,
  evaluatedReport: {},
  qualitySourceFingerprint: "invalid",
  reason: "",
};
const invalidHoldResult = Policy.validate(invalidHold);
assert.equal(invalidHoldResult.ok, false);
for (const phrase of ["schemaVersion", "qualitySourceFingerprint", "reason", "productionDefaultEnabled", "evaluatedReport"]) {
  assert.ok(invalidHoldResult.errors.some((error) => error.includes(phrase)), phrase);
}

const malformedPass = {
  ...hold,
  decision: "pass",
  productionDefaultEnabled: true,
};
const safeFallback = Policy.resolve(malformedPass);
assert.equal(safeFallback.decision, "hold");
assert.equal(safeFallback.productionDefaultEnabled, false);
assert.ok(safeFallback.policyErrors.some((error) => error.includes("evaluatedReport")));

const invalidPassEvidence = {
  ...hold,
  decision: "pass",
  productionDefaultEnabled: false,
  evaluatedReport: {
    schemaVersion: 0,
    provenance: "fixture",
    releaseEligible: false,
    runId: "",
    reportHash: "bad",
    evidenceHash: "bad",
    corpusHash: "bad",
    qualitySourceFingerprint: "b".repeat(64),
    judgeRatedPairs: 0,
    humanRatedPairs: 0,
  },
};
const invalidPassResult = Policy.validate(invalidPassEvidence);
assert.equal(invalidPassResult.ok, false);
for (const phrase of [
  "productionDefaultEnabled",
  "schemaVersion",
  "live",
  "runId",
  "reportHash",
  "evidenceHash",
  "corpusHash",
  "source fingerprint",
  "judgeRatedPairs",
  "humanRatedPairs",
]) {
  assert.ok(invalidPassResult.errors.some((error) => error.includes(phrase)), phrase);
}

const runManifest = {
  schemaVersion: 1,
  runId: "live-test-run",
  provenance: "live",
  corpusId: "test-corpus",
  corpusHash,
  model: "writer-model",
  judgeModel: "judge-model",
  generatedAt: "2026-09-05T00:00:00.000Z",
  qualitySource: currentQualitySource,
};
const report = {
  schemaVersion: 1,
  decision: "pass",
  releaseEligible: true,
  runId: runManifest.runId,
  corpusId: runManifest.corpusId,
  corpusHash,
  qualitySourceFingerprint: currentQualitySource.fingerprint,
  provenance: "live",
  requiredPairs: 2,
  checks: [
    { id: "live-provenance", ok: true },
    { id: "quality-source-current", ok: true },
  ],
  ratings: {
    judge: { ratedPairs: 2 },
    human: { ratedPairs: 2 },
  },
};
const evidence = buildPromotionEvidence({
  runManifest,
  report,
  artifacts: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
  judgeRatings: [{ pairId: "p1" }, { pairId: "p2" }],
  humanRatings: [{ pairId: "p1" }, { pairId: "p2" }],
  blindKey: { assignments: ["p1", "p2"] },
});
const evidenceValidation = validatePromotionEvidence(evidence, currentQualitySource);
assert.equal(evidenceValidation.ok, true, evidenceValidation.errors.join("\n"));

const evaluatedReport = releaseEvidenceReference(evidence);
const pass = {
  schemaVersion: 2,
  decision: "pass",
  productionDefaultEnabled: true,
  evaluatedReport,
  qualitySourceFingerprint: currentQualitySource.fingerprint,
  reason: "受控 live A/B 与人工盲评通过。",
};
assert.equal(Policy.validate(pass).ok, true);
assert.equal(Policy.resolve(pass).productionDefaultEnabled, true);
const passValidation = validateQualityReleaseRecord(pass, currentQualitySource, evidence);
assert.equal(passValidation.ok, true, passValidation.errors.join("\n"));

const mismatchedRecord = structuredClone(pass);
mismatchedRecord.evaluatedReport.reportHash = "b".repeat(64);
assert.equal(validateQualityReleaseRecord(mismatchedRecord, currentQualitySource, evidence).ok, false);

const tamperedEvidence = structuredClone(evidence);
tamperedEvidence.report.requiredPairs = 3;
assert.equal(validatePromotionEvidence(tamperedEvidence, currentQualitySource).ok, false);

const driftedSource = computeQualitySourceManifest(root, {
  readFile(filePath) {
    const source = fs.readFileSync(filePath, "utf8");
    return filePath.endsWith("prompts.js") ? `${source}\n// simulated prompt drift\n` : source;
  },
});
assert.equal(validatePromotionEvidence(evidence, driftedSource).ok, false);
assert.equal(validateQualityReleaseRecord(pass, driftedSource, evidence).ok, false);

console.log("test_quality_release_policy: OK");
