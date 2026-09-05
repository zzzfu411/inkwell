import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const writer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.dirname(writer);
const tauri = path.join(workspace, "mogao-tauri");

function links(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

const expectedWriterLinks = [
  "./docs/ARCHITECTURE.md",
  "./docs/ENGINEERING-AUDIT-2026-09.md",
  "../mogao-tauri/docs/RELEASE.md",
];
const expectedTauriLinks = [
  "../novel-writer/docs/ARCHITECTURE.md",
  "../novel-writer/docs/ENGINEERING-AUDIT-2026-09.md",
  "./docs/RELEASE.md",
];
assert.deepEqual(links(fs.readFileSync(path.join(writer, "README.md"), "utf8")), expectedWriterLinks);
assert.deepEqual(links(fs.readFileSync(path.join(tauri, "README.md"), "utf8")), expectedTauriLinks);

for (const relative of ["PLAN.md", "MATURITY.md", "docs/REWRITE-RUST-GO.md"]) {
  assert.equal(fs.existsSync(path.join(writer, relative)), false, `${relative} must not remain at the current root`);
}
for (const name of ["PLAN.md", "MATURITY.md", "REWRITE-RUST-GO.md"]) {
  assert.equal(fs.existsSync(path.join(writer, "docs", "history", name)), true, `${name} must be archived`);
}

const goalNames = [
  "GOAL-0.11-STUDIO.md",
  "GOAL-0.12-HUMAN-AUTOWRITE.md",
  "GOAL-0.16-CRAFT-ACCEPT.md",
  "GOAL-AUDIT-FIX.md",
  "GOAL-AUDIT-R3.md",
  "GOAL-AUDIT-R4.md",
  "GOAL-CONTINUITY-V1.md",
  "GOAL-FRONTEND-V1.md",
  "GOAL-MATURE.md",
  "GOAL-P0-VAULT.md",
  "GOAL-P1-P2.md",
  "GOAL-REMAINING-12.md",
  "GOAL-STABILIZATION-V1.md",
  "GOAL-ULTIMATE.md",
];
for (const name of goalNames) {
  assert.equal(fs.existsSync(path.join(tauri, name)), false, `${name} must not remain at the current root`);
  assert.equal(fs.existsSync(path.join(tauri, "docs", "history", name)), true, `${name} must be archived`);
}

for (const absolute of [
  path.join(writer, "docs", "ARCHITECTURE.md"),
  path.join(writer, "docs", "ENGINEERING-AUDIT-2026-09.md"),
  path.join(tauri, "docs", "RELEASE.md"),
]) {
  assert.equal(fs.existsSync(absolute), true, `current navigation target missing: ${absolute}`);
}

console.log("test_documentation_navigation: OK");
