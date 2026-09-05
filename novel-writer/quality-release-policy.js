/**
 * Safe runtime policy for the default writing-engine decision.
 *
 * CI verifies report and source digests. This browser-side boundary is defense in depth: malformed
 * or partially edited promotion data can never turn the candidate engine on by accident.
 */
window.NOVEL_QUALITY_RELEASE_POLICY = (() => {
  "use strict";

  const RECORD_SCHEMA_VERSION = 2;
  const EVIDENCE_SCHEMA_VERSION = 1;
  const SHA256 = /^[a-f0-9]{64}$/;

  function text(value) {
    return String(value ?? "").trim();
  }

  function isSha256(value) {
    return SHA256.test(text(value));
  }

  function validate(record) {
    const errors = [];
    if (!record || typeof record !== "object") return { ok: false, errors: ["quality release record missing"] };
    if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
      errors.push(`quality release schemaVersion must be ${RECORD_SCHEMA_VERSION}`);
    }
    if (!isSha256(record.qualitySourceFingerprint)) errors.push("qualitySourceFingerprint must be SHA-256");
    if (!text(record.reason)) errors.push("quality release reason is required");
    if (!['hold', 'pass'].includes(record.decision)) errors.push("quality release decision must be hold or pass");

    if (record.decision === "hold") {
      if (record.productionDefaultEnabled !== false) errors.push("hold must keep productionDefaultEnabled=false");
      if (record.evaluatedReport != null) errors.push("hold must not claim evaluatedReport evidence");
      return { ok: errors.length === 0, errors };
    }

    if (record.productionDefaultEnabled !== true) errors.push("pass must set productionDefaultEnabled=true");
    const evidence = record.evaluatedReport;
    if (!evidence || typeof evidence !== "object") {
      errors.push("pass requires evaluatedReport evidence");
      return { ok: false, errors };
    }
    if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
      errors.push(`evaluatedReport.schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
    }
    if (evidence.provenance !== "live" || evidence.releaseEligible !== true) {
      errors.push("evaluatedReport must be live and releaseEligible");
    }
    if (!text(evidence.runId)) errors.push("evaluatedReport.runId is required");
    for (const field of ["reportHash", "evidenceHash", "corpusHash", "qualitySourceFingerprint"]) {
      if (!isSha256(evidence[field])) errors.push(`evaluatedReport.${field} must be SHA-256`);
    }
    if (evidence.qualitySourceFingerprint !== record.qualitySourceFingerprint) {
      errors.push("evaluatedReport source fingerprint must match the release record");
    }
    if (!Number.isSafeInteger(evidence.judgeRatedPairs) || evidence.judgeRatedPairs < 1) {
      errors.push("evaluatedReport.judgeRatedPairs must be positive");
    }
    if (!Number.isSafeInteger(evidence.humanRatedPairs) || evidence.humanRatedPairs < 1) {
      errors.push("evaluatedReport.humanRatedPairs must be positive");
    }
    return { ok: errors.length === 0, errors };
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function safeHold(record, errors) {
    return deepFreeze({
      schemaVersion: RECORD_SCHEMA_VERSION,
      decision: "hold",
      productionDefaultEnabled: false,
      evaluatedReport: null,
      qualitySourceFingerprint: isSha256(record?.qualitySourceFingerprint) ? record.qualitySourceFingerprint : "",
      reason: "质量发布记录无效，已安全回退到旧 Harness。",
      policyErrors: errors.slice(0, 12),
    });
  }

  function resolve(record) {
    const result = validate(record);
    return result.ok ? deepFreeze(record) : safeHold(record, result.errors);
  }

  return {
    RECORD_SCHEMA_VERSION,
    EVIDENCE_SCHEMA_VERSION,
    isSha256,
    validate,
    resolve,
  };
})();
