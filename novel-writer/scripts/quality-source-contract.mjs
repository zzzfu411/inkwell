import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const QUALITY_SOURCE_SCHEMA_VERSION = 1;
export const QUALITY_SOURCE_ALGORITHM = "sha256-lf-v1";

// This is the exact classic-script runtime used by the paid quality experiment.
// quality-release.js is loaded so config.js has the production default, but the release decision
// itself is deliberately excluded from the evaluated source fingerprint: promoting a successful
// report must not retroactively make that same report stale.
export const QUALITY_RUNTIME_FILES = Object.freeze([
  "quality-release-policy.js",
  "quality-release.js",
  "config.js",
  "prompts.js",
  "craft.js",
  "chapter-state.js",
  "project-migrations.js",
  "production-state.js",
  "memory-reducers.js",
  "context-budget.js",
  "context-evidence.js",
  "context.js",
  "rag.js",
  "api.js",
  "planning-service.js",
  "handoff-service.js",
  "legacy-generation-adapter.js",
  "pipeline.js",
  "harness.js",
  "chapter-drafting-service.js",
  "production-quality.js",
  "production-engine.js",
]);

export const QUALITY_TOOL_FILES = Object.freeze([
  "scripts/eval-continuity.mjs",
  "scripts/quality-eval-core.mjs",
  "scripts/quality-ab.mjs",
  "scripts/quality-release-evidence.mjs",
  "scripts/quality-source-contract.mjs",
  "scripts/verify-quality-release.mjs",
]);

export const QUALITY_SOURCE_FILES = Object.freeze([
  ...QUALITY_RUNTIME_FILES.filter((file) => file !== "quality-release.js"),
  ...QUALITY_TOOL_FILES,
]);

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifestPayload(files) {
  return JSON.stringify({
    schemaVersion: QUALITY_SOURCE_SCHEMA_VERSION,
    algorithm: QUALITY_SOURCE_ALGORITHM,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  });
}

export function computeQualitySourceManifest(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const files = Array.isArray(options.files) ? options.files.map(normalizePath) : [...QUALITY_SOURCE_FILES];
  const readFile = typeof options.readFile === "function" ? options.readFile : (filePath) => fs.readFileSync(filePath, "utf8");
  if (!files.length) throw new Error("quality source contract requires at least one file");
  if (new Set(files).size !== files.length) throw new Error("quality source contract contains duplicate files");

  const entries = files.map((relativePath) => {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`unsafe quality source path: ${relativePath || "<empty>"}`);
    }
    const sourcePath = path.resolve(root, ...relativePath.split("/"));
    const relative = normalizePath(path.relative(root, sourcePath));
    if (relative !== relativePath || relative.startsWith("../")) {
      throw new Error(`quality source path escaped root: ${relativePath}`);
    }
    const normalized = normalizeText(readFile(sourcePath));
    return {
      path: relativePath,
      sha256: digest(normalized),
      bytes: Buffer.byteLength(normalized, "utf8"),
    };
  });
  return {
    schemaVersion: QUALITY_SOURCE_SCHEMA_VERSION,
    algorithm: QUALITY_SOURCE_ALGORITHM,
    files: entries,
    fingerprint: digest(manifestPayload(entries)),
  };
}

export function validateQualitySourceManifest(manifest, options = {}) {
  const expectedFiles = Array.isArray(options.files) ? options.files.map(normalizePath) : [...QUALITY_SOURCE_FILES];
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["quality source manifest missing"], fingerprint: "" };
  }
  if (manifest.schemaVersion !== QUALITY_SOURCE_SCHEMA_VERSION) {
    errors.push(`quality source schemaVersion must be ${QUALITY_SOURCE_SCHEMA_VERSION}`);
  }
  if (manifest.algorithm !== QUALITY_SOURCE_ALGORITHM) {
    errors.push(`quality source algorithm must be ${QUALITY_SOURCE_ALGORITHM}`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length !== expectedFiles.length) {
    errors.push(`quality source file count ${files.length} != ${expectedFiles.length}`);
  }
  const seen = new Set();
  files.forEach((file, index) => {
    const filePath = normalizePath(file?.path);
    if (seen.has(filePath)) errors.push(`duplicate quality source file: ${filePath}`);
    seen.add(filePath);
    if (filePath !== expectedFiles[index]) {
      errors.push(`quality source file[${index}] ${filePath || "<missing>"} != ${expectedFiles[index] || "<none>"}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(file?.sha256 || ""))) {
      errors.push(`invalid quality source hash: ${filePath || index}`);
    }
    if (!Number.isSafeInteger(file?.bytes) || file.bytes < 0) {
      errors.push(`invalid quality source byte count: ${filePath || index}`);
    }
  });
  const computed = files.length ? digest(manifestPayload(files)) : "";
  if (!/^[a-f0-9]{64}$/.test(String(manifest.fingerprint || ""))) {
    errors.push("quality source fingerprint missing or invalid");
  } else if (manifest.fingerprint !== computed) {
    errors.push("quality source fingerprint does not match file manifest");
  }
  return { ok: errors.length === 0, errors, fingerprint: computed };
}

export function compareQualitySourceManifests(recorded, current, options = {}) {
  const recordedValidation = validateQualitySourceManifest(recorded, options);
  const currentValidation = validateQualitySourceManifest(current, options);
  const same =
    recordedValidation.ok &&
    currentValidation.ok &&
    recorded.fingerprint === current.fingerprint;
  return {
    ok: same,
    recorded: recorded?.fingerprint || "",
    current: current?.fingerprint || "",
    errors: [...recordedValidation.errors, ...currentValidation.errors],
  };
}
