import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALITY_RUNTIME_FILES,
  QUALITY_SOURCE_FILES,
  compareQualitySourceManifests,
  computeQualitySourceManifest,
  validateQualitySourceManifest,
} from "../scripts/quality-source-contract.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const current = computeQualitySourceManifest(root);
const validation = validateQualitySourceManifest(current);
assert.equal(validation.ok, true, validation.errors.join("\n"));
assert.deepEqual(
  current.files.map((entry) => entry.path),
  QUALITY_SOURCE_FILES
);
assert.equal(new Set(QUALITY_SOURCE_FILES).size, QUALITY_SOURCE_FILES.length);
assert.equal(new Set(QUALITY_RUNTIME_FILES).size, QUALITY_RUNTIME_FILES.length);
assert.equal(QUALITY_SOURCE_FILES.includes("quality-release.js"), false, "promotion data must not invalidate its own report");
for (const file of [...QUALITY_RUNTIME_FILES, ...QUALITY_SOURCE_FILES]) {
  assert.equal(fs.existsSync(path.join(root, ...file.split("/"))), true, `quality source file missing: ${file}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-quality-source-"));
try {
  const files = ["a.js", "nested/b.js"];
  fs.mkdirSync(path.join(temp, "nested"), { recursive: true });
  fs.writeFileSync(path.join(temp, "a.js"), "const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(temp, "nested", "b.js"), "const b = 2;\n", "utf8");
  const lf = computeQualitySourceManifest(temp, { files });
  assert.equal(validateQualitySourceManifest(lf, { files }).ok, true);

  fs.writeFileSync(path.join(temp, "a.js"), "const a = 1;\r\n", "utf8");
  fs.writeFileSync(path.join(temp, "nested", "b.js"), "const b = 2;\r\n", "utf8");
  const crlf = computeQualitySourceManifest(temp, { files });
  assert.equal(crlf.fingerprint, lf.fingerprint, "CRLF/LF checkout differences must not invalidate evidence");
  assert.equal(compareQualitySourceManifests(lf, crlf, { files }).ok, true);

  fs.writeFileSync(path.join(temp, "a.js"), "const a = 3;\n", "utf8");
  const changed = computeQualitySourceManifest(temp, { files });
  assert.notEqual(changed.fingerprint, lf.fingerprint);
  assert.equal(compareQualitySourceManifests(lf, changed, { files }).ok, false);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const tampered = structuredClone(current);
tampered.files[0].sha256 = "0".repeat(64);
const tamperedValidation = validateQualitySourceManifest(tampered);
assert.equal(tamperedValidation.ok, false);
assert.ok(tamperedValidation.errors.some((error) => error.includes("fingerprint")));

const incomplete = structuredClone(current);
incomplete.files.pop();
const incompleteValidation = validateQualitySourceManifest(incomplete);
assert.equal(incompleteValidation.ok, false);
assert.ok(incompleteValidation.errors.some((error) => error.includes("file count")));

assert.throws(
  () => computeQualitySourceManifest(root, { files: ["../outside.js"] }),
  /unsafe quality source path/
);

console.log("test_quality_source_contract: OK");
