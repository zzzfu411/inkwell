import {
  compareQualitySourceManifests,
  validateQualitySourceManifest,
} from "./quality-source-contract.mjs";
import { sha256 } from "./quality-eval-core.mjs";

export const QUALITY_RELEASE_RECORD_SCHEMA_VERSION = 2;
export const QUALITY_RELEASE_EVIDENCE_SCHEMA_VERSION = 1;

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function ratings(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.ratings) ? value.ratings : [];
}

export function buildPromotionEvidence({
  runManifest,
  report,
  artifacts,
  judgeRatings,
  humanRatings,
  blindKey,
} = {}) {
  const sourceValidation = validateQualitySourceManifest(runManifest?.qualitySource);
  if (!sourceValidation.ok) throw new Error(`invalid quality source manifest: ${sourceValidation.errors.join("; ")}`);
  if (runManifest?.provenance !== "live") throw new Error("promotion evidence requires live provenance");
  if (report?.decision !== "pass" || report?.releaseEligible !== true) {
    throw new Error("promotion evidence requires a passing release-eligible report");
  }
  const failedChecks = Array.isArray(report.checks) ? report.checks.filter((row) => row?.ok !== true) : [{ id: "checks-missing" }];
  if (failedChecks.length) throw new Error(`promotion report has failed checks: ${failedChecks.map((row) => row.id).join(", ")}`);
  if (report.runId !== runManifest.runId) throw new Error("promotion report runId does not match run manifest");
  if (report.corpusHash !== runManifest.corpusHash) throw new Error("promotion report corpus hash does not match run manifest");
  if (report.qualitySourceFingerprint !== runManifest.qualitySource.fingerprint) {
    throw new Error("promotion report source fingerprint does not match run manifest");
  }

  const judge = ratings(judgeRatings);
  const human = ratings(humanRatings);
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const judgeRatedPairs = Number(report?.ratings?.judge?.ratedPairs) || 0;
  const humanRatedPairs = Number(report?.ratings?.human?.ratedPairs) || 0;
  const requiredPairs = Number(report.requiredPairs) || 0;
  if (!requiredPairs || judgeRatedPairs !== requiredPairs || humanRatedPairs !== requiredPairs) {
    throw new Error("promotion evidence requires complete judge and human pair coverage");
  }

  return {
    schemaVersion: QUALITY_RELEASE_EVIDENCE_SCHEMA_VERSION,
    decision: "pass",
    run: {
      schemaVersion: runManifest.schemaVersion,
      runId: runManifest.runId,
      provenance: runManifest.provenance,
      corpusId: runManifest.corpusId,
      corpusHash: runManifest.corpusHash,
      model: runManifest.model || null,
      judgeModel: runManifest.judgeModel || null,
      generatedAt: runManifest.generatedAt || null,
      qualitySource: runManifest.qualitySource,
    },
    report,
    digests: {
      reportHash: sha256(report),
      artifactsHash: sha256(artifactList),
      judgeRatingsHash: sha256(judge),
      humanRatingsHash: sha256(human),
      blindKeyHash: sha256(blindKey || {}),
    },
    coverage: {
      artifacts: artifactList.length,
      requiredPairs,
      judgeRatings: judge.length,
      humanRatings: human.length,
      judgeRatedPairs,
      humanRatedPairs,
    },
  };
}

export function validatePromotionEvidence(evidence, currentQualitySource) {
  const errors = [];
  if (!evidence || typeof evidence !== "object") return { ok: false, errors: ["promotion evidence missing"] };
  if (evidence.schemaVersion !== QUALITY_RELEASE_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`promotion evidence schemaVersion must be ${QUALITY_RELEASE_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (evidence.decision !== "pass") errors.push("promotion evidence decision must be pass");
  if (evidence.run?.provenance !== "live") errors.push("promotion evidence provenance must be live");
  if (!evidence.run?.runId) errors.push("promotion evidence runId missing");
  const sourceComparison = compareQualitySourceManifests(evidence.run?.qualitySource, currentQualitySource);
  if (!sourceComparison.ok) errors.push(`promotion evidence source is stale: ${sourceComparison.errors.join("; ")}`);

  const report = evidence.report;
  if (report?.decision !== "pass" || report?.releaseEligible !== true) {
    errors.push("promotion evidence report must be pass and releaseEligible");
  }
  if (!Array.isArray(report?.checks) || report.checks.some((row) => row?.ok !== true)) {
    errors.push("promotion evidence report contains failed or missing checks");
  }
  if (report?.runId !== evidence.run?.runId) errors.push("promotion evidence report runId mismatch");
  if (report?.corpusHash !== evidence.run?.corpusHash) errors.push("promotion evidence report corpus hash mismatch");
  if (report?.qualitySourceFingerprint !== evidence.run?.qualitySource?.fingerprint) {
    errors.push("promotion evidence report source fingerprint mismatch");
  }
  if (evidence.digests?.reportHash !== sha256(report || {})) errors.push("promotion evidence report hash mismatch");
  for (const field of ["artifactsHash", "judgeRatingsHash", "humanRatingsHash", "blindKeyHash"]) {
    if (!isSha256(evidence.digests?.[field])) errors.push(`promotion evidence ${field} missing or invalid`);
  }
  const requiredPairs = Number(evidence.coverage?.requiredPairs) || 0;
  if (!requiredPairs || requiredPairs !== Number(report?.requiredPairs)) errors.push("promotion evidence requiredPairs mismatch");
  if (Number(evidence.coverage?.judgeRatedPairs) !== requiredPairs) errors.push("promotion evidence judge pair coverage incomplete");
  if (Number(evidence.coverage?.humanRatedPairs) !== requiredPairs) errors.push("promotion evidence human pair coverage incomplete");
  return { ok: errors.length === 0, errors, evidenceHash: sha256(evidence) };
}

export function releaseEvidenceReference(evidence) {
  const validation = validatePromotionEvidence(evidence, evidence?.run?.qualitySource);
  if (!validation.ok) throw new Error(`invalid promotion evidence: ${validation.errors.join("; ")}`);
  return {
    schemaVersion: QUALITY_RELEASE_EVIDENCE_SCHEMA_VERSION,
    runId: evidence.run.runId,
    provenance: "live",
    releaseEligible: true,
    reportHash: evidence.digests.reportHash,
    evidenceHash: validation.evidenceHash,
    corpusHash: evidence.run.corpusHash,
    qualitySourceFingerprint: evidence.run.qualitySource.fingerprint,
    judgeRatedPairs: evidence.coverage.judgeRatedPairs,
    humanRatedPairs: evidence.coverage.humanRatedPairs,
  };
}

export function validateQualityReleaseRecord(record, currentQualitySource, evidence = null) {
  const errors = [];
  if (!record || typeof record !== "object") return { ok: false, errors: ["quality release record missing"] };
  if (record.schemaVersion !== QUALITY_RELEASE_RECORD_SCHEMA_VERSION) {
    errors.push(`quality release schemaVersion must be ${QUALITY_RELEASE_RECORD_SCHEMA_VERSION}`);
  }
  if (record.qualitySourceFingerprint !== currentQualitySource?.fingerprint) {
    errors.push("quality release source fingerprint does not match current source");
  }
  if (record.decision === "hold") {
    if (record.productionDefaultEnabled !== false) errors.push("hold must disable the candidate default");
    if (record.evaluatedReport != null) errors.push("hold must not reference evaluatedReport");
    return { ok: errors.length === 0, errors };
  }
  if (record.decision !== "pass") errors.push("quality release decision must be hold or pass");
  if (record.productionDefaultEnabled !== true) errors.push("pass must enable the candidate default");
  const evidenceValidation = validatePromotionEvidence(evidence, currentQualitySource);
  if (!evidenceValidation.ok) errors.push(...evidenceValidation.errors);
  if (evidenceValidation.ok) {
    const expected = releaseEvidenceReference(evidence);
    if (sha256(record.evaluatedReport || {}) !== sha256(expected)) {
      errors.push("quality release evaluatedReport does not match approved promotion evidence");
    }
  }
  return { ok: errors.length === 0, errors };
}
