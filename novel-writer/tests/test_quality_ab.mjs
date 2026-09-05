import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDeterministicMetrics,
  evaluateReleaseGate,
  sha256,
  validateArtifacts,
  validateCorpus,
} from "../scripts/quality-eval-core.mjs";
import { computeQualitySourceManifest } from "../scripts/quality-source-contract.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "evaluation", "corpus-v1.json"), "utf8"));
const meta = validateCorpus(corpus);
assert.equal(meta.seedCount, 6);
assert.equal(meta.pairCount, 48);
assert.equal(meta.artifactCount, 96);
assert.ok(corpus.seeds.every((seed) => seed.chapters.length === 8));
assert.equal(new Set(corpus.seeds.map((seed) => seed.genre)).size, 6);

const output = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-quality-ab-"));
const cli = path.join(root, "scripts", "quality-ab.mjs");
const fixtureRun = spawnSync(process.execPath, [cli, "fixture", "--out", output], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(fixtureRun.status, 0, fixtureRun.stderr || fixtureRun.stdout);

const runManifest = JSON.parse(fs.readFileSync(path.join(output, "run.json"), "utf8"));
const artifacts = JSON.parse(fs.readFileSync(path.join(output, "artifacts.json"), "utf8"));
const packet = JSON.parse(fs.readFileSync(path.join(output, "blind-packet.json"), "utf8"));
const key = JSON.parse(fs.readFileSync(path.join(output, "blind-key.json"), "utf8"));
const judgeRatings = JSON.parse(fs.readFileSync(path.join(output, "judge-ratings.json"), "utf8")).ratings;
const humanRatings = JSON.parse(fs.readFileSync(path.join(output, "human-ratings.fixture.json"), "utf8")).ratings;
const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
const currentQualitySource = computeQualitySourceManifest(root);

assert.equal(runManifest.provenance, "fixture");
assert.equal(runManifest.corpusHash, sha256(corpus));
assert.equal(artifacts.length, 96);
assert.equal(packet.pairs.length, 48);
assert.equal(key.assignments.length, 48);
assert.equal(report.decision, "calibration-pass");
assert.equal(report.releaseEligible, false, "fixture calibration can never approve the default engine");
assert.equal(report.checks.find((row) => row.id === "quality-source-manifest").ok, true);
assert.equal(report.checks.find((row) => row.id === "quality-source-current").ok, true);
assert.equal(runManifest.qualitySource.fingerprint, currentQualitySource.fingerprint);
assert.equal(validateArtifacts(corpus, artifacts).ok, true);
assert.equal(
  fs.readdirSync(path.join(output, "artifacts"), { recursive: true }).filter((entry) => String(entry).endsWith(".json")).length,
  96
);

const serializedBlindPacket = JSON.stringify(packet);
assert.doesNotMatch(serializedBlindPacket, /"variant"\s*:/i);
assert.doesNotMatch(serializedBlindPacket, /0\.19 Harness|Contract \+ coherent chapter/);
assert.match(JSON.stringify(key), /baseline/);
assert.match(JSON.stringify(key), /candidate/);
assert.ok(artifacts.every((artifact) => !/api[_-]?key|authorization/i.test(JSON.stringify(artifact.promptRequests))));

const noFixtureOverride = evaluateReleaseGate({
  corpus,
  runManifest,
  currentQualitySource,
  artifacts,
  blindKey: key,
  judgeRatings,
  humanRatings,
});
assert.equal(noFixtureOverride.releaseEligible, false);
assert.equal(noFixtureOverride.decision, "hold");
assert.equal(noFixtureOverride.checks.find((row) => row.id === "live-provenance").ok, false);

const legacyRun = structuredClone(runManifest);
delete legacyRun.qualitySource;
const legacyGate = evaluateReleaseGate({
  corpus,
  runManifest: legacyRun,
  currentQualitySource,
  artifacts,
  blindKey: key,
  judgeRatings,
  humanRatings,
  allowFixture: true,
});
assert.equal(legacyGate.decision, "hold");
assert.equal(legacyGate.checks.find((row) => row.id === "quality-source-manifest").ok, false);

const driftedSource = computeQualitySourceManifest(root, {
  readFile(filePath) {
    const source = fs.readFileSync(filePath, "utf8");
    return filePath.endsWith("config.js") ? `${source}\n// simulated source drift\n` : source;
  },
});
const driftedGate = evaluateReleaseGate({
  corpus,
  runManifest,
  currentQualitySource: driftedSource,
  artifacts,
  blindKey: key,
  judgeRatings,
  humanRatings,
  allowFixture: true,
});
assert.equal(driftedGate.decision, "hold");
assert.equal(driftedGate.checks.find((row) => row.id === "quality-source-manifest").ok, true);
assert.equal(driftedGate.checks.find((row) => row.id === "quality-source-current").ok, false);

const tampered = structuredClone(artifacts);
tampered[0].body += "篡改";
const invalid = validateArtifacts(corpus, tampered);
assert.equal(invalid.ok, false);
assert.ok(invalid.errors.some((error) => error.includes("bodyHash mismatch")));
const leakedCredential = structuredClone(artifacts);
leakedCredential[0].promptRequests[0].apiKey = "must-not-be-recorded";
assert.ok(
  validateArtifacts(corpus, leakedCredential).errors.some((error) => error.includes("credential fields")),
  "artifact validation must reject credential-bearing audit records"
);

const cases = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "fixtures", "quality", "v1", "regression-cases.json"), "utf8")
).cases;
for (const item of cases) {
  const measured = computeDeterministicMetrics({ body: item.body, targetChars: item.targetChars || 1400 });
  if (item.expectedBlocker) assert.ok(measured.blockers.includes(item.expectedBlocker), item.id);
  if (Number.isFinite(item.minRepeatedNgramRate)) {
    assert.ok(measured.repeatedNgramRate >= item.minRepeatedNgramRate, item.id);
    assert.ok(measured.repeatedNgramRate <= item.maxRepeatedNgramRate, item.id);
  }
}

const gateRun = spawnSync(process.execPath, [cli, "gate", "--run", output], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(gateRun.status, 2, "normal gate must reject fixture provenance");
const held = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
assert.equal(held.decision, "hold");
assert.equal(held.releaseEligible, false);

const refusedPromotion = path.join(output, "should-not-exist-promotion.json");
const promoteRun = spawnSync(process.execPath, [cli, "promote", "--run", output, "--out", refusedPromotion], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(promoteRun.status, 1, "fixture evidence must never create a promotion bundle");
assert.equal(fs.existsSync(refusedPromotion), false);

fs.rmSync(output, { recursive: true, force: true });
console.log("test_quality_ab: OK");
