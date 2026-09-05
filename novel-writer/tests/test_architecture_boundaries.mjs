import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const executable = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// 临时“债务上限”不是目标架构，只防止继续向现有巨石追加职责。
// 新功能超过上限前，必须先把等量职责抽到有独立测试的模块。
const debtCeilings = [
  ["app.js", 4_500, 180_000],
  ["context.js", 1_500, 60_000],
  ["pipeline.js", 1_400, 62_000],
  ["workspace.js", 1_400, 52_000],
  ["production-engine.js", 1_250, 54_000],
  ["runtime-observability.js", 650, 24_000],
  ["composition-contract.js", 420, 24_000],
  ["server.py", 2_250, 90_000],
];
for (const [name, maxLines, maxBytes] of debtCeilings) {
  const source = read(name);
  const lines = source.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(source, "utf8");
  assert.ok(lines <= maxLines, `${name} exceeded architecture debt ceiling: ${lines} > ${maxLines} lines`);
  assert.ok(bytes <= maxBytes, `${name} exceeded architecture debt ceiling: ${bytes} > ${maxBytes} bytes`);
}

// 领域/取数模块只能接收值并返回值；浏览器、存储和网络属于 adapter/controller。
const pureModules = [
  "chapter-state.js",
  "project-migrations.js",
  "production-state.js",
  "conflict-use-cases.js",
  "persistence-use-cases.js",
  "write-use-cases.js",
  "planning-service.js",
  "handoff-service.js",
  "legacy-generation-adapter.js",
  "chapter-drafting-service.js",
  "production-quality.js",
  "runtime-observability.js",
  "memory-reducers.js",
  "context-budget.js",
  "context-evidence.js",
  "craft.js",
  "story-records.js",
  "graph-panel.js",
  "composer-review.js",
  "text-metrics.js",
  "chapter-format.js",
  "narrative-model.js",
  "chapter-split.js",
];
for (const name of pureModules) {
  const source = executable(read(name));
  assert.doesNotMatch(
    source,
    /document\.|getElementById|innerHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|indexedDB/,
    `${name} crossed the domain boundary; move I/O to a controller or adapter`
  );
}

const html = read("index.html");
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(scripts).size, scripts.length, "composition root must not load a script twice");
for (const name of scripts) {
  assert.ok(fs.existsSync(path.join(root, name)), `composition root references missing script: ${name}`);
}

const chapterStateAt = scripts.indexOf("chapter-state.js");
const qualityReleasePolicyAt = scripts.indexOf("quality-release-policy.js");
const qualityReleaseAt = scripts.indexOf("quality-release.js");
const configAt = scripts.indexOf("config.js");
const migrationAt = scripts.indexOf("project-migrations.js");
const stateAt = scripts.indexOf("production-state.js");
const planningAt = scripts.indexOf("planning-service.js");
const handoffAt = scripts.indexOf("handoff-service.js");
const legacyGenerationAt = scripts.indexOf("legacy-generation-adapter.js");
const memoryReducersAt = scripts.indexOf("memory-reducers.js");
const contextBudgetAt = scripts.indexOf("context-budget.js");
const contextEvidenceAt = scripts.indexOf("context-evidence.js");
const writeUseCasesAt = scripts.indexOf("write-use-cases.js");
const chapterDraftingAt = scripts.indexOf("chapter-drafting-service.js");
const productionQualityAt = scripts.indexOf("production-quality.js");
const observabilityAt = scripts.indexOf("runtime-observability.js");
const diagnosticsUiAt = scripts.indexOf("runtime-diagnostics-ui.js");
const compositionContractAt = scripts.indexOf("composition-contract.js");
assert.ok(qualityReleasePolicyAt >= 0, "quality-release-policy.js must be part of the composition root");
assert.ok(chapterStateAt >= 0, "chapter-state.js must be part of the composition root");
assert.ok(qualityReleaseAt >= 0, "quality-release.js must be part of the composition root");
assert.ok(qualityReleasePolicyAt < qualityReleaseAt, "quality release policy must load before release data");
assert.ok(qualityReleaseAt < configAt, "quality release decision must load before defaults");
assert.ok(migrationAt > chapterStateAt, "project migrations must load after the transition boundary");
assert.ok(stateAt >= 0, "production-state.js must be part of the composition root");
assert.ok(stateAt > migrationAt, "production-state.js must load after project migrations");
assert.ok(planningAt >= 0, "planning-service.js must be part of the composition root");
assert.ok(planningAt < scripts.indexOf("pipeline.js"), "planning-service.js must load before pipeline.js");
assert.ok(handoffAt >= 0, "handoff-service.js must be part of the composition root");
assert.ok(handoffAt < scripts.indexOf("pipeline.js"), "handoff-service.js must load before pipeline.js");
assert.ok(legacyGenerationAt >= 0, "legacy-generation-adapter.js must be part of the composition root");
assert.ok(
  legacyGenerationAt < scripts.indexOf("pipeline.js"),
  "legacy-generation-adapter.js must load before pipeline.js"
);
assert.ok(memoryReducersAt >= 0, "memory-reducers.js must be part of the composition root");
assert.ok(memoryReducersAt < scripts.indexOf("context.js"), "memory-reducers.js must load before context.js");
assert.ok(contextBudgetAt >= 0, "context-budget.js must be part of the composition root");
assert.ok(contextBudgetAt < scripts.indexOf("context.js"), "context-budget.js must load before context.js");
assert.ok(contextEvidenceAt >= 0, "context-evidence.js must be part of the composition root");
assert.ok(contextEvidenceAt < scripts.indexOf("context.js"), "context-evidence.js must load before context.js");
assert.ok(writeUseCasesAt >= 0, "write-use-cases.js must be part of the composition root");
assert.ok(writeUseCasesAt < scripts.indexOf("app.js"), "write-use-cases.js must load before app.js");
assert.ok(chapterDraftingAt >= 0, "chapter-drafting-service.js must be part of the composition root");
assert.ok(chapterDraftingAt < scripts.indexOf("production-engine.js"), "chapter drafting must load before production engine");
assert.ok(productionQualityAt >= 0, "production-quality.js must be part of the composition root");
assert.ok(productionQualityAt < scripts.indexOf("production-engine.js"), "production quality must load before production engine");
assert.ok(observabilityAt >= 0, "runtime-observability.js must be part of the composition root");
for (const consumer of ["persistence-use-cases.js", "context.js", "api.js", "handoff-service.js", "app.js"]) {
  assert.ok(observabilityAt < scripts.indexOf(consumer), `runtime observability must precede ${consumer}`);
}
assert.ok(diagnosticsUiAt >= 0 && diagnosticsUiAt < scripts.indexOf("app.js"), "diagnostics UI adapter must precede app.js");
assert.ok(
  compositionContractAt > diagnosticsUiAt && compositionContractAt < scripts.indexOf("app.js"),
  "composition contract must validate all adapters immediately before app.js"
);
for (const consumer of ["store.js", "vault.js", "pipeline.js", "production-engine.js", "app.js"]) {
  assert.ok(stateAt < scripts.indexOf(consumer), `production-state.js must precede ${consumer}`);
}

// task / production / handoff 三个持久化投影只能由 chapter-state.js 写入。
// migration 只允许补齐旧 production 形状，不参与运行时终态切换。
for (const name of [
  "production-state.js",
  "production-engine.js",
  "pipeline.js",
  "harness.js",
  "composer-review.js",
  "app.js",
]) {
  const source = executable(read(name));
  assert.doesNotMatch(
    source,
    /\b(?:production|task)\.status\s*=(?!=)/,
    `${name} writes a persisted status directly; use NOVEL_CHAPTER_STATE`
  );
  assert.doesNotMatch(
    source,
    /\b(?:chapter|ch|localChapter|diskChapter)\.handoffStatus\s*=(?!=)/,
    `${name} writes handoffStatus directly; use NOVEL_CHAPTER_STATE`
  );
}

console.log("test_architecture_boundaries: OK");
