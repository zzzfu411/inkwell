#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { computeQualitySourceManifest } from "./quality-source-contract.mjs";
import { validateQualityReleaseRecord } from "./quality-release-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(here, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadBrowserDecision(root) {
  const sandbox = { window: {}, console };
  for (const file of ["quality-release-policy.js", "quality-release.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
  }
  return {
    policy: sandbox.window.NOVEL_QUALITY_RELEASE_POLICY,
    record: sandbox.window.NOVEL_QUALITY_RELEASE_RECORD,
    effective: sandbox.window.NOVEL_QUALITY_RELEASE,
  };
}

export function verifyQualityRelease(rootDir = defaultRoot) {
  const root = path.resolve(rootDir);
  const currentQualitySource = computeQualitySourceManifest(root);
  const { policy, record, effective } = loadBrowserDecision(root);
  const errors = [];
  const policyValidation = policy?.validate?.(record) || { ok: false, errors: ["quality release policy unavailable"] };
  if (!policyValidation.ok) errors.push(...policyValidation.errors);

  const evidencePath = path.join(root, "evaluation", "approved-quality-release.json");
  let evidence = null;
  if (fs.existsSync(evidencePath)) {
    try {
      evidence = readJson(evidencePath);
    } catch (error) {
      errors.push(`approved quality evidence is not valid JSON: ${error.message}`);
    }
  }
  const recordValidation = validateQualityReleaseRecord(record, currentQualitySource, evidence);
  if (!recordValidation.ok) errors.push(...recordValidation.errors);
  if (effective?.decision !== record?.decision || effective?.productionDefaultEnabled !== record?.productionDefaultEnabled) {
    errors.push("runtime policy downgraded the release record; fix the record instead of shipping the fallback");
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    decision: record?.decision || "invalid",
    productionDefaultEnabled: effective?.productionDefaultEnabled === true,
    qualitySourceFingerprint: currentQualitySource.fingerprint,
    evidencePath: evidence ? path.relative(root, evidencePath).replaceAll("\\", "/") : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyQualityRelease();
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
