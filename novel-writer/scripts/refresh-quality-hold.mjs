// Refresh provenance after source repairs without manufacturing promotion evidence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeQualitySourceManifest } from "./quality-source-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "quality-release.js");
const source = fs.readFileSync(file, "utf8");
if (!/decision:\s*"hold"/.test(source) || !/productionDefaultEnabled:\s*false/.test(source)) {
  throw new Error("Only an explicit hold record may be refreshed; promotion requires evaluated evidence.");
}
const manifest = computeQualitySourceManifest(root);
const next = source.replace(/qualitySourceFingerprint: "[a-f0-9]{64}"/, `qualitySourceFingerprint: "${manifest.fingerprint}"`);
if (!next.includes(manifest.fingerprint)) throw new Error("Quality hold fingerprint field is missing");
fs.writeFileSync(file, next);
console.log(`hold/false retained: ${manifest.fingerprint}`);
