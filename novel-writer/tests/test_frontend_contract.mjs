import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const library = fs.readFileSync(path.join(root, "library.js"), "utf8");
const vaultUi = fs.readFileSync(path.join(root, "vault-ui.js"), "utf8");
const workspace = fs.readFileSync(path.join(root, "workspace.js"), "utf8");
const store = fs.readFileSync(path.join(root, "store.js"), "utf8");
const vault = fs.readFileSync(path.join(root, "vault.js"), "utf8");
const analyzeUi = fs.readFileSync(path.join(root, "analyze-ui.js"), "utf8");
const pipeline = fs.readFileSync(path.join(root, "pipeline.js"), "utf8");
const uiShell = fs.readFileSync(path.join(root, "ui-shell.js"), "utf8");
const storyRecords = fs.readFileSync(path.join(root, "story-records.js"), "utf8");
const graphPanel = fs.readFileSync(path.join(root, "graph-panel.js"), "utf8");
const composerReview = fs.readFileSync(path.join(root, "composer-review.js"), "utf8");
const textMetrics = fs.readFileSync(path.join(root, "text-metrics.js"), "utf8");
const productionEngine = fs.readFileSync(path.join(root, "production-engine.js"), "utf8");
const productionQuality = fs.readFileSync(path.join(root, "production-quality.js"), "utf8");
const chapterDrafting = fs.readFileSync(path.join(root, "chapter-drafting-service.js"), "utf8");
const qualityRelease = fs.readFileSync(path.join(root, "quality-release.js"), "utf8");
const config = fs.readFileSync(path.join(root, "config.js"), "utf8");
const productionState = fs.readFileSync(path.join(root, "production-state.js"), "utf8");
const chapterState = fs.readFileSync(path.join(root, "chapter-state.js"), "utf8");
const projectMigrations = fs.readFileSync(path.join(root, "project-migrations.js"), "utf8");
const conflictUseCases = fs.readFileSync(path.join(root, "conflict-use-cases.js"), "utf8");
const persistenceUseCases = fs.readFileSync(path.join(root, "persistence-use-cases.js"), "utf8");
const writeUseCases = fs.readFileSync(path.join(root, "write-use-cases.js"), "utf8");
const planningService = fs.readFileSync(path.join(root, "planning-service.js"), "utf8");
const handoffService = fs.readFileSync(path.join(root, "handoff-service.js"), "utf8");
const legacyGenerationAdapter = fs.readFileSync(path.join(root, "legacy-generation-adapter.js"), "utf8");
const memoryReducers = fs.readFileSync(path.join(root, "memory-reducers.js"), "utf8");
const contextBudget = fs.readFileSync(path.join(root, "context-budget.js"), "utf8");
const contextEvidence = fs.readFileSync(path.join(root, "context-evidence.js"), "utf8");
const writeUi = fs.readFileSync(path.join(root, "write-ui.js"), "utf8");
const runtimeObservability = fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8");
const diagnosticsUi = fs.readFileSync(path.join(root, "runtime-diagnostics-ui.js"), "utf8");

const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
assert.deepEqual(duplicateIds, [], `duplicate DOM ids: ${duplicateIds.join(", ")}`);
assert.match(html, /id="btnExportDiagnostics"/);
assert.match(app, /DiagnosticsUI\.bindDiagnosticsExport/);
assert.match(diagnosticsUi, /function handleWriteFailure\(/);
assert.match(runtimeObservability, /const ERROR_CATEGORIES = Object\.freeze\(\[/);
for (const category of ["model", "retrieval", "plan", "quality", "handoff", "storage", "conflict", "cancel"]) {
  assert.match(runtimeObservability, new RegExp(`"${category}"`));
}
assert.doesNotMatch(runtimeObservability, /fields\.(?:body|messages|apiKey|Authorization)/);

const topbar = html.match(/<header class="topbar"[\s\S]*?<\/header>/)?.[0] || "";
assert.ok(topbar, "topbar must exist");
assert.equal((topbar.match(/class="mode(?:\s|")/g) || []).length, 4, "topbar has four primary entries");
for (const section of ["write", "story", "workspace", "analyze"]) {
  assert.match(topbar, new RegExp(`data-section="${section}"`));
}
assert.match(topbar, /id="btnToggleLibrary"[^>]+aria-controls="libraryRail"/);
assert.match(topbar, /id="btnToggleLibrary"[^>]+aria-label="打开书库"/);
assert.match(html, /id="libraryRail"[^>]+aria-hidden="true"[^>]+inert/);
assert.match(html, /id="narrativeRibbon"/);
for (const id of ["writingWelcome", "writingWelcomeTitle", "writingWelcomeHint", "composeSelectionState", "composerReview", "composerReviewMeta", "btnKeepComposerResult", "btnUndoComposerResult"]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing writing experience control ${id}`);
}
const narrativeRibbon = html.match(/<div class="narrative-ribbon"[\s\S]*?<\/div>/)?.[0] || "";
assert.match(narrativeRibbon, /id="ribbonHealth"/);
assert.doesNotMatch(narrativeRibbon, /ribbonHandoff/);
for (const id of ["btnSaveChapter", "chapterSaveState", "chapterHandoffStatus", "chapterHandoffState", "chapterMore"]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing chapter header control ${id}`);
}
assert.match(html, /<option value="annotate">根据批注修订<\/option>/);
assert.match(html, /id="btnMemoryStoryCenter"[^>]+data-go-mode="control"[^>]+data-story-target="memoryView"/);
assert.match(html, /id="generationProgress"[^>]+role="status"[^>]+aria-live="polite"/);
for (const id of ["btnStopPipe", "btnStopAuto", "btnStop", "btnAnStop"]) {
  assert.match(html, new RegExp(`id="${id}"[^>]+hidden[^>]+disabled|id="${id}"[^>]+disabled[^>]+hidden`));
}
for (const id of [
  "canonTypeFilter",
  "canonLockFilter",
  "canonEvidenceFilter",
  "loopTypeFilter",
  "loopStatusFilter",
  "loopEvidenceFilter",
  "continuityTypeFilter",
  "continuityStatusFilter",
  "continuitySeverityFilter",
  "continuityEvidenceFilter",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing structured story filter ${id}`);
}
for (const id of [
  "graphMinOcc",
  "graphChapFrom",
  "graphChapTo",
  "graphStats",
  "graphProfile",
  "graphTimeline",
  "btnGraphApplyFilter",
  "btnGraphClearSelection",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing story graph control ${id}`);
}
assert.match(html, /id="wsStatus"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
assert.match(html, /id="anStatus"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
assert.match(html, /class="inspector-tabs"[^>]+role="tablist"/);
assert.equal((html.match(/data-inspector-target="(?:task|continuity|memory)"/g) || []).length >= 8, true);
for (const target of ["task", "continuity", "memory"]) {
  assert.match(html, new RegExp(`id="tab-inspector-${target}"[^>]+aria-controls="inspector-${target}"`));
  assert.match(html, new RegExp(`id="inspector-${target}"[^>]+aria-labelledby="tab-inspector-${target}"`));
}
assert.match(html, /data-settings-target="retrieval"/);
assert.match(html, /data-settings-panel="retrieval"/);
for (const target of ["appearance", "model", "writing", "continuity", "retrieval", "advanced"]) {
  assert.match(html, new RegExp(`id="settings-tab-${target}"[^>]+aria-controls="settings-panel-${target}"`));
  assert.match(html, new RegExp(`id="settings-panel-${target}"[^>]+aria-labelledby="settings-tab-${target}"`));
}
assert.equal((html.match(/class="theme-swatch"[^>]+role="option"[^>]+aria-selected=/g) || []).length, 3);
assert.match(html, /id="btnOpenChapters"[^>]+aria-controls="writeChaptersDrawer"/);
assert.match(html, /id="btnWsToggleFiles"[^>]+aria-controls="wsFilesDrawer"[^>]+aria-expanded="false"/);
assert.match(html, /id="wsFilesScrim"/);
assert.match(html, /id="cfgOutputTokens"[^>]+min="512"[^>]+max="65536"/);
assert.match(html, /契约化整章生产引擎（候选）/);
assert.match(qualityRelease, /decision:\s*"hold"/);
assert.match(qualityRelease, /productionDefaultEnabled:\s*false/);
assert.match(config, /productionEngineEnabled:\s*qualityRelease\.productionDefaultEnabled === true/);
assert.match(html, /id="cfgKey"[^>]+autocomplete="off"/);
assert.match(html, /id="btnOpenInspector"[^>]+aria-controls="writeTaskDrawer"/);
assert.match(html, /id="ws-tab-both"[^>]+aria-controls="wsEditorPane wsPreviewPane"/);
assert.match(html, /id="wsEditorPane"[^>]+role="tabpanel"/);
assert.match(html, /id="wsPreviewPane"[^>]+role="tabpanel"/);
assert.equal((html.match(/role="dialog"/g) || []).length, 4);
assert.match(html, /id="saveConflictModal"/);
assert.match(html, /id="btnConflictUseDisk"/);
assert.match(html, /id="btnConflictSaveMerge"/);
assert.match(html, /id="btnConflictKeepLocal"/);
assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
assert.match(html, /<script src="ui-shell\.js"><\/script>/);
assert.match(html, /<script src="graph-view\.js"><\/script>/);
assert.match(html, /<script src="write-ui\.js"><\/script>/);
assert.match(html, /<script src="craft\.js"><\/script>/);
assert.match(html, /<script src="chapter-state\.js"><\/script>/);
assert.match(html, /<script src="project-migrations\.js"><\/script>/);
assert.match(html, /<script src="production-state\.js"><\/script>/);
assert.match(html, /<script src="conflict-use-cases\.js"><\/script>/);
assert.match(html, /<script src="production-engine\.js"><\/script>/);
assert.match(html, /<script src="chapter-drafting-service\.js"><\/script>/);
assert.match(html, /<script src="production-quality\.js"><\/script>/);
assert.ok(html.indexOf('src="chapter-drafting-service.js"') < html.indexOf('src="production-engine.js"'));
assert.ok(html.indexOf('src="production-quality.js"') < html.indexOf('src="production-engine.js"'));
assert.ok(html.indexOf('src="production-engine.js"') < html.indexOf('src="app.js"'));
assert.ok(html.indexOf('src="chapter-state.js"') < html.indexOf('src="project-migrations.js"'));
assert.ok(html.indexOf('src="project-migrations.js"') < html.indexOf('src="production-state.js"'));
for (const consumer of ["store.js", "vault.js", "pipeline.js", "harness.js", "production-engine.js", "app.js"]) {
  assert.ok(
    html.indexOf('src="chapter-state.js"') < html.indexOf(`src="${consumer}"`),
    `chapter-state.js must load before ${consumer}`
  );
}
for (const consumer of ["store.js", "vault.js", "pipeline.js", "production-engine.js", "app.js"]) {
  assert.ok(
    html.indexOf('src="production-state.js"') < html.indexOf(`src="${consumer}"`),
    `production-state.js must load before ${consumer}`
  );
}
assert.match(html, /id="cfgProduction"/);
assert.match(html, /id="cfgQualityGate"/);
assert.match(html, /id="productionQuality"/);
assert.match(html, /id="beatPlanBox"/);
assert.match(html, /id="btnRefreshBeat"/);
assert.match(html, /id="cfgChapterBeat"/);
assert.match(html, /id="cfgProseLint"/);
assert.match(html, /id="graphCanvas"/);
assert.match(html, /id="anGraphCanvas"/);

for (const token of [
  "--color-canvas",
  "--color-surface",
  "--color-paper",
  "--color-text",
  "--color-border",
  "--color-accent",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-focus",
]) {
  assert.ok(css.includes(token), `missing semantic token ${token}`);
}
assert.match(css, /\.topbar\s*\{[\s\S]*?height:\s*52px/);
assert.match(css, /@media \(max-width: 1199px\)/);
assert.match(css, /@media \(max-width: 1049px\)/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /:focus-visible/);
assert.match(css, /min-width:\s*min\(680px, 100%\)/);
assert.match(css, /#view-write \.workspace\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\)/);
const componentStart = css.search(/\r?\n\*,\r?\n\*::before,\r?\n\*::after\s*\{/);
assert.ok(componentStart >= 0, "component style boundary must be found regardless of line endings");
const componentCss = css
  .slice(componentStart)
  .replace(/^\.theme-dot\.[^\r\n]+$/gm, "");
assert.doesNotMatch(componentCss, /#[0-9a-fA-F]{3,8}|rgba?\(/, "component styles must use semantic tokens");

assert.match(app, /UiShell\?\.migrateUiState/);
assert.match(app, /UiShell\?\.startupModeForState/);
assert.match(app, /function createManualChapter\(\)/);
assert.match(app, /function captureWritingPosition\(immediate = false\)/);
assert.match(writeUi, /function renderWritingWelcome\(project, chapter\)/);
assert.match(app, /WritingPresenter\.renderWritingWelcome/);
assert.match(app, /\["write", uiState\.storyMode \|\| "control", "workspace", "analyze"\]/);
assert.match(app, /\["pipeline", "control", "graph"\]/);
assert.match(app, /renderWritingInspector/);
assert.match(writeUi, /function renderChapterHeaderState\(project, chapter/);
assert.match(app, /WritingPresenter\.renderChapterHeaderState/);
assert.match(app, /function reviseFromAnnotation\(\)/);
assert.match(app, /WriteCases\.continueDraft/);
assert.match(app, /WriteCases\.revise/);
assert.match(app, /WriteCases\.rewriteSelection/);
assert.match(writeUseCases, /pipe\.reviseChapter/);
assert.match(writeUseCases, /pipe\.rewritePassage/);
assert.match(writeUseCases, /chapter\.handoffStatus !== "done"/);
assert.match(writeUseCases, /ports\.chapterStatus\?\.\("局部修复交接"/);
assert.match(legacyGenerationAdapter, /kind: "author-annotation"/);
assert.match(legacyGenerationAdapter, /修订类操作采用成功后提交/);
assert.match(legacyGenerationAdapter, /chapter.craftScore/);
assert.match(handoffService, /任务未覆盖/);
assert.match(handoffService, /前文《\$\{chapter\.title \|\| chapter\.id\}》交接未完成，先补交接（不改正文）/);
assert.match(handoffService, /const readOnlyCfg = \{ \.\.\.cfg, continuityAutoRepair: false \}/);
assert.match(handoffService, /if \(isAbortError\(e\)\) throw e;/);
assert.match(handoffService, /String\(ch\.handoffStatus \|\| ""\) === "stale"/);
assert.match(handoffService, /function repairableIssues\(review\)[\s\S]*?String\(x\.evidence \|\| ""\)\.trim\(\)/);
assert.match(app, /renderCraftHint/);
assert.match(app, /function initDetailsAccessibility\(\)[\s\S]*?setAttribute\("aria-expanded"/);
assert.match(app, /function saveActiveChapterNow\(\)/);
assert.match(app, /dataset\.storyTarget/);
assert.match(app, /function setChapterCycleStatus\(scope, stage\)/);
assert.match(app, /generationStagePresentation/);
assert.match(app, /productionEngineEnabled/);
assert.match(writeUseCases, /QUALITY_GATE_BLOCKED/);
assert.match(writeUi, /function renderProductionQuality\(chapter\)/);
assert.match(app, /function setGenerationStopControls\(active\)[\s\S]*?control\.hidden = !active/);
assert.match(writeUseCases, /ports\.setStopControls\?\.\(true\)[\s\S]*?ports\.setStopControls\?\.\(false\)/);
assert.match(writeUi, /data-issue-action="repair"/);
assert.match(app, /function renderCanonRecords\(p\)/);
assert.match(app, /function renderLoopRecords\(p\)/);
assert.match(app, /function renderContinuityRecords\(p\)/);
assert.match(app, /const graphForSelectedNode = GraphPanel\.subgraphForNode/);
assert.match(app, /renderGraphProfile\(filteredGraph, graphSelectedNodeId\)/);
assert.match(app, /renderGraphTimeline\(filteredGraph, graphSelectedNodeId\)/);
assert.doesNotMatch(app, /\$\("an(?:Profile|Timeline|GraphStats|NodeList|EdgeTable|MermaidBox)"\)/);
assert.doesNotMatch(app, /NOVEL_ANALYZE_UI\?\.applyFilterAndRender/);
assert.match(app, /function syncResponsiveDrawerAccessibility\(\)/);
assert.match(app, /drawer\.inert = hidden/);
assert.match(app, /function syncModalBackgroundInert\(activeModal\)/);
assert.match(app, /async function reconcileSaveWarnings\([\s\S]*?submittedRevision = projectSaveRevisions\.read\(p\)/);
assert.match(app, /async function resolveActiveSaveConflict\(choice\)/);
assert.match(conflictUseCases, /detectedRevision: submittedRevision/);
assert.match(persistenceUseCases, /deps\.reconcileWarnings\(project, warnings, revision\)/);
// 保存会把磁盘 mtime 推新。两条保存路径都必须换掉乐观并发基线，
// 否则同一次会话里第二次改同一章会撞上自己刚写的文件，冒出假的磁盘冲突。
assert.match(persistenceUseCases, /deps\.adoptBaselines\?\.\(project, result, warnings\)/);
assert.match(app, /adoptBaselines:[\s\S]*?Vault\.adoptChapterBaselines/);
assert.match(vault, /function adoptChapterBaselines\(project, saved, warnings\)/);
assert.match(vault, /blocked\.has\(file\)/, "conflicted chapters must keep their old baseline");
assert.match(conflictUseCases, /!deps\.revisionMatches\?\.\(project, entry\.detectedRevision\)/);
assert.match(app, /assertSyncRequestSucceeded\(fxhr, "资料文件同步保存"\)/);
assert.match(app, /assertSyncRequestSucceeded\(xhr, "作品同步保存"\)/);
assert.match(app, /window\.__mogaoFlushSync[\s\S]*?Vault\.prepareProjectForSave\(p\)/);
assert.match(app, /window\.__mogaoFlushSync[\s\S]*?JSON\.parse\(xhr\.responseText/);
assert.match(app, /window\.__mogaoFlushSync[\s\S]*?"externalConflict"[\s\S]*?"preservedExternal"[\s\S]*?persistSaveConflicts/);
assert.match(app, /window\.__mogaoFlushSync[\s\S]*?"externalConflict"[\s\S]*?"preservedExternal"[\s\S]*?return false/);
assert.match(app, /flushSucceeded[\s\S]*?Ws\?\.isDirty\?\.\(\)/);
assert.doesNotMatch(app, /chapterFileSaved/);
assert.match(app, /window\.NOVEL_MODAL_A11Y = \{ sync: syncModalBackgroundInert \}/);
assert.match(app, /child\.inert = true/);
assert.match(app, /child\.setAttribute\("aria-hidden", "true"\)/);
assert.match(app, /async function prepareVaultSwitch\(\)/);
assert.match(app, /async function ensureWorkspaceSaved\(actionLabel/);
assert.match(app, /async function switchToSlug\(slug\)[\s\S]*?ensureWorkspaceSaved\("切换书目"\)/);
assert.match(app, /function markClean\(extra, guard = \{\}\)[\s\S]*?projectSaveRevisions\.matches/);
assert.match(app, /const saveRevision = projectSaveRevisions\.read\(p\)[\s\S]*?revision: saveRevision/);
assert.match(app, /prepareVaultSwitch,/);
assert.match(app, /#btnOpenVaultDir, #btnNewVaultDir, #btnSettingsOpenVault, #btnSettingsNewVault/);
assert.equal((vaultUi.match(/await D\.prepareVaultSwitch\(\)/g) || []).length, 2);
assert.match(workspace, /async function saveCurrent\(\)[\s\S]*?catch \(e\) \{[\s\S]*?throw e;/);
assert.match(workspace, /async function saveCurrent\(\)[\s\S]*?return true;/);
assert.match(workspace, /aria-live", kind === "err" \? "assertive" : "polite"/);
assert.match(analyzeUi, /aria-live", kind === "err" \? "assertive" : "polite"/);
assert.match(workspace, /const snapshot = captureSaveState\(\)/);
assert.match(workspace, /const current = saveStateIsCurrent\(snapshot\)/);
assert.match(workspace, /较早版本已保存[\s\S]*?dirty = true/);
assert.match(workspace, /function markClean\(snapshot, saved\)[\s\S]*?saveStateIsCurrent\(snapshot\)/);
assert.match(workspace, /if \(dirty && kind === "ok"\) return;/);
assert.match(workspace, /const GENERATED_MIRROR_PATHS = new Set/);
assert.match(workspace, /function generatedMirrorInfo\(path\)/);
assert.match(workspace, /function syncReadOnly\([\s\S]*?ed\.readOnly = readOnly/);
assert.match(workspace, /function saveCurrent\(\)[\s\S]*?guardFileMutate\("保存"\)/);
assert.match(workspace, /function guardFileMutate[\s\S]*?getProjectReadOnlyReason/);
assert.match(workspace, /function doRestore[\s\S]*?guardFileMutate\("恢复快照"/);
assert.match(app, /Ws\?\.syncReadOnly\?\.\(\{ announce: genLocked \}\)/);
assert.doesNotMatch(app, /ed\.readOnly = genLocked/);
assert.match(store, /function savePendingConflicts\(entries\)/);
assert.match(store, /function loadPendingConflicts\(\)/);
assert.match(store, /detectedRevision:/);
assert.match(app, /function restorePersistedSaveConflicts\(\)/);
assert.match(app, /const restoredConflictCount = restorePersistedSaveConflicts\(\)/);
assert.match(app, /hydratePersistedConflictsForProject\(target\)/);
assert.match(analyzeUi, /payload\.phase === "final"[\s\S]*?status: "finalizing"/);
assert.match(analyzeUi, /const ANALYSIS_STATUS_LABELS = Object\.freeze/);
for (const label of ["等待识别", "识别完成", "正在分析", "正在聚合结果", "分析完成"]) {
  assert.ok(analyzeUi.includes(label), `missing author-facing analysis phase ${label}`);
}
assert.doesNotMatch(html, /id="anProgressLabel"[^>]*>idle</);
assert.match(analyzeUi, /async function commitAnalysisMeta\(slug, meta\)/);
assert.match(analyzeUi, /status === 404 \|\| \(status === 400 && \/\^not found:/);
assert.match(analyzeUi, /throw new Error\(`无法清理旧分析检查点/);
assert.match(app, /UiShell\?\.safeCssToken\?\.\(taskStatus, "pending"\)/);
assert.doesNotMatch(app, /class="st \$\{t\.status/);
assert.doesNotMatch(library, /\$\{b\.stage \|\| "—"\}/);
const finalAnalysisFlow = analyzeUi.slice(
  analyzeUi.indexOf("await persistAnalysis(p.slug"),
  analyzeUi.indexOf("setStatus(\n        result.meta", analyzeUi.indexOf("await persistAnalysis(p.slug"))
);
assert.ok(finalAnalysisFlow.indexOf("persistAnalysis") < finalAnalysisFlow.indexOf("deps.saveProject"));
assert.ok(finalAnalysisFlow.indexOf("deps.saveProject") < finalAnalysisFlow.indexOf("commitAnalysisMeta"));
assert.match(app, /saveProject: async \(p\)[\s\S]*?await flushProject\(p\)/);
assert.match(app, /conflictError\.code = "ANALYSIS_SAVE_CONFLICT"/);
assert.equal(
  (workspace.match(/saveCurrent\(\)\.catch/g) || []).length,
  1,
  "workspace only wires its save button; app owns the global shortcut"
);
assert.equal((app.match(/workspace shortcut save/g) || []).length, 1);
assert.match(app, /连写存盘失败[\s\S]*?throw new Error/);
assert.match(app, /saveProject after analysis[\s\S]*?throw e/);
assert.match(app, /function assertMigrationComplete\(result, expected\)/);
assert.equal((app.match(/assertMigrationComplete\(/g) || []).length, 3);
assert.match(workspace, /function applySplit\(\)[\s\S]*?b\.tabIndex = active \? 0 : -1/);
assert.match(workspace, /function syncFilesDrawerAccessibility\(\)/);
assert.match(workspace, /drawer\.inert = !open/);
assert.match(workspace, /ed\.setAttribute\("aria-labelledby", activeTabId\)/);
assert.match(workspace, /pr\.setAttribute\("aria-labelledby", activeTabId\)/);

for (const viewId of ["view-pipeline", "view-control"]) {
  const viewStart = html.indexOf(`<section class="view" id="${viewId}">`);
  const viewEnd = html.indexOf("\n    <!-- ", viewStart);
  const view = html.slice(viewStart, viewEnd < 0 ? undefined : viewEnd);
  assert.equal((view.match(/class="[^"]*\bprimary\b[^"]*"/g) || []).length, 1, `${viewId} must have one primary action`);
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const value = hex.replace("#", "");
  const rgb = [0, 2, 4].map((offset) => channel(Number.parseInt(value.slice(offset, offset + 2), 16)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const selector of [":root,\\s*html\\[data-theme=\"soft-paper\"\\]", "html\\[data-theme=\"ink-night\"\\]", "html\\[data-theme=\"qing-jian\"\\]"]) {
  const block = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`))?.[1] || "";
  const token = (name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const backgrounds = ["color-surface", "color-paper"];
  const foregrounds = ["color-text", "color-text-muted", "color-text-subtle"];
  for (const backgroundName of backgrounds) {
    for (const foregroundName of foregrounds) {
      const foreground = token(foregroundName);
      const background = token(backgroundName);
      assert.ok(foreground && background, `missing ${foregroundName}/${backgroundName} for ${selector}`);
      assert.ok(
        contrast(foreground, background) >= 4.5,
        `${selector} ${foregroundName} on ${backgroundName} contrast must be at least 4.5:1`
      );
    }
  }
}

// 交接文案只有一个出处：章头说「交接失败」时状态条不许说「待交接」。
assert.match(app, /const handoffStatusSuffix = \(chapter, pendingLabel\)/);
assert.match(writeUi, /if \(state === "failed"\) return \{ suffix: "交接失败，待重试", kind: "warn" \}/);
assert.equal((app.match(/handoffStatusSuffix\(/g) || []).length, 5, "定义一次，四条生成路径各用一次");
for (const prefix of ["修订完成", "重写完成", "正文已生成", "局部修复完成"]) {
  assert.match(app, new RegExp(`${prefix} · \\$\\{\\w+\\.suffix\\}`), `${prefix} 必须复用交接文案`);
}
// 前端分层：能单测的取数逻辑必须住在模块里，app.js 只负责拼 DOM 和跨模块事务。
// 下面几条挡的是「图省事又把算法抄回 app.js」。
for (const [name, source, globalName] of [
  ["story-records.js", storyRecords, "NOVEL_STORY_RECORDS"],
  ["graph-panel.js", graphPanel, "NOVEL_GRAPH_PANEL"],
  ["composer-review.js", composerReview, "NOVEL_COMPOSER_REVIEW"],
  ["text-metrics.js", textMetrics, "NOVEL_TEXT_METRICS"],
]) {
  assert.match(source, new RegExp(`window\\.${globalName} = \\{`), `${name} must publish ${globalName}`);
  assert.doesNotMatch(source, /document\.|getElementById|innerHTML/, `${name} must stay DOM-free`);
  assert.match(html, new RegExp(`<script src="${name}"></script>`), `${name} must load before app.js`);
  assert.ok(
    html.indexOf(`src="${name}"`) < html.indexOf('src="app.js"'),
    `${name} must be registered before app.js`
  );
}
for (const builder of ["buildCanonRecords", "buildLoopRecords", "buildContinuityRecords"]) {
  assert.match(storyRecords, new RegExp(`function ${builder}\\(project, filters = \\{\\}\\)`));
  assert.match(app, new RegExp(`Records\\.${builder}\\(p, \\{`), `app.js must consume ${builder}`);
}
assert.doesNotMatch(app, /const severityRank = \{/, "严重度排序住在 story-records.js");
assert.doesNotMatch(app, /const STORY_TYPE_LABELS = \{/, "标签表住在 story-records.js");
assert.match(app, /GraphPanel\.buildEdgeRows\(scopedGraph, filteredGraph\)/);
assert.match(app, /TextMetrics\.countWords\(text\)/);
assert.doesNotMatch(srcBetween(app, "function words(text)", "function writeDeskHasPendingDiskFlush"), /\.match\(/);
assert.match(textMetrics, /function countWords\(text\)/);
assert.match(textMetrics, /charCodeAt/);
assert.doesNotMatch(textMetrics, /\.match\(/);
assert.match(app, /GraphPanel\.buildTracks\(/);
assert.match(app, /ComposerReview\.stillApplies\(composerReviewState, p, chapter\)/);
assert.match(app, /ComposerReview\.restore\(/);
assert.match(composerReview, /NOVEL_CHAPTER_STATE\?\.restoreProjection/);
assert.match(uiShell, /function generationRailState\(label, kind\)/);
assert.match(uiShell, /production-quality|quality-review|scene-writing/);
assert.match(app, /UiShell\?\.generationRailState\?\.\(label, kind\)/);
assert.doesNotMatch(app, /const stages = \["context", "model", "review", "handoff"\]/);
assert.match(productionEngine, /function normalizeContract/);
assert.match(productionEngine, /function sceneContractCoverage/);
assert.match(productionEngine, /function qualityGate/);
assert.match(productionQuality, /window\.NOVEL_PRODUCTION_QUALITY = \(\(\) => \{/);
assert.match(productionEngine, /Quality\(\)\.qualityGate/);
assert.doesNotMatch(
  productionQuality.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  /document\.|getElementById|innerHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|NOVEL_DEFAULTS/,
  "production quality must remain an injected, deterministic domain boundary"
);
assert.match(productionEngine, /generateCoherentChapter/);
assert.match(productionEngine, /productionMode === "chapter"/);
assert.match(productionEngine, /QUALITY_GATE_BLOCKED/);
assert.match(productionEngine, /onCheckpoint/);
assert.match(productionState, /window\.NOVEL_PRODUCTION_STATE = \(\(\) => \{/);
assert.match(chapterDrafting, /window\.NOVEL_CHAPTER_DRAFTING = \(\(\) => \{/);
assert.doesNotMatch(
  chapterDrafting.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  /document\.|getElementById|innerHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest/,
  "chapter drafting service must remain a port-injected, DOM/storage/network-free boundary"
);
const productionStateExecutable = productionState
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
assert.doesNotMatch(
  productionStateExecutable,
  /document\.|getElementById|innerHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest/,
  "production-state.js must remain a DOM-free, storage-free domain boundary"
);
for (const method of [
  "bodySignature",
  "invalidateAfterBodyEdit",
  "reconcileChapter",
  "reconcileProject",
  "canHandoff",
]) {
  assert.match(productionState, new RegExp(`function ${method}\\(`));
}
for (const [name, source, globalName] of [
  ["chapter-state.js", chapterState, "NOVEL_CHAPTER_STATE"],
  ["project-migrations.js", projectMigrations, "NOVEL_PROJECT_MIGRATIONS"],
  ["conflict-use-cases.js", conflictUseCases, "NOVEL_CONFLICT_USE_CASES"],
  ["persistence-use-cases.js", persistenceUseCases, "NOVEL_PERSISTENCE_USE_CASES"],
  ["write-use-cases.js", writeUseCases, "NOVEL_WRITE_USE_CASES"],
  ["planning-service.js", planningService, "NOVEL_PLANNING_SERVICE"],
  ["handoff-service.js", handoffService, "NOVEL_HANDOFF_SERVICE"],
  ["legacy-generation-adapter.js", legacyGenerationAdapter, "NOVEL_LEGACY_GENERATION_ADAPTER"],
  ["memory-reducers.js", memoryReducers, "NOVEL_MEMORY_REDUCERS"],
  ["context-budget.js", contextBudget, "NOVEL_CONTEXT_BUDGET"],
  ["context-evidence.js", contextEvidence, "NOVEL_CONTEXT_EVIDENCE"],
]) {
  const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(source, new RegExp(`window\\.${globalName} = \\(\\(\\) => \\{`));
  assert.doesNotMatch(
    executableSource,
    /document\.|getElementById|innerHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest/,
    `${name} must remain a DOM-free, storage-free domain boundary`
  );
}
for (const method of [
  "requestRevision",
  "markWriting",
  "markWritten",
  "markAccepted",
  "startHandoff",
  "markDigestComplete",
  "completeHandoff",
  "markHandoffStale",
  "captureProjection",
  "restoreProjection",
  "repairProject",
]) {
  assert.match(chapterState, new RegExp(`function ${method}\\(`));
}
assert.match(chapterState, /const PRODUCTION_TRANSITIONS = Object\.freeze/);
assert.match(chapterState, /ILLEGAL_CHAPTER_TRANSITION/);
for (const method of ["inspect", "migrateProject", "compatibility", "assertWritable"]) {
  assert.match(projectMigrations, new RegExp(`function ${method}\\(`));
}
assert.match(vault, /NOVEL_PROJECT_MIGRATIONS\?\.migrateProject/);
assert.match(vault, /NOVEL_PROJECT_MIGRATIONS\?\.assertWritable/);
assert.match(store, /NOVEL_PROJECT_MIGRATIONS\?\.migrateProject/);
assert.match(app, /function projectReadOnlyReason\(p = project\(\)\)/);
assert.match(workspace, /getProjectReadOnlyReason/);
assert.match(app, /SaveConflicts\.enqueueDiverged/);
assert.match(app, /SaveConflicts\.hydrate/);
assert.match(conflictUseCases, /enqueueDiverged\(queue, project, freshBook/);
assert.match(conflictUseCases, /hydrateProject\(queue, project\)/);
assert.match(vault, /function reconcileLoadedBook/);
assert.match(vault, /NOVEL_PRODUCTION_STATE\?\.reconcileProject/);
assert.match(handoffService, /ProductionState\(\)\?\.canHandoff/);
assert.match(productionEngine, /NOVEL_PRODUCTION_STATE\?\.bodySignature/);
assert.match(
  srcBetween(app, "function mergeWorkspaceIntoProject", "async function saveWorkspaceOnly"),
  /invalidateProductionAfterAuthorEdit/
);
assert.match(
  conflictUseCases,
  /reconcileProductionChapter|invalidateAfterAuthorEdit/
);

// 列表面板用事件委托：一次重画上百张卡，不该重新挂上百个监听
assert.match(app, /function bindDelegatedPanelActions\(\)/);
assert.equal((app.match(/bindDelegatedPanelActions\(\)/g) || []).length, 2, "定义一次、启动时绑一次");
for (const selector of ["loopView", "continuityView", "nodeList"]) {
  assert.match(app, new RegExp(`\\$\\("${selector}"\\)\\?\\.addEventListener\\("click"`), `${selector} 走委托`);
}
assert.doesNotMatch(app, /box\.querySelectorAll\("\[data-loop-action\]"\)/);
assert.doesNotMatch(app, /box\.querySelectorAll\("\[data-issue-action\]"\)/);

// 编辑器热路径：打分防抖但落盘前必须补齐；上下文装配只在状态变了才重算
assert.match(app, /scheduleCraftRescore\(ch\.id\)/);
assert.doesNotMatch(
  app,
  /addEventListener\("input", \(\) => \{[\s\S]{0,900}?Pipe\.applyCraftSignals/,
  "craft 打分不许逐键跑全章扫描"
);
assert.match(app, /function flushCraftRescore\(\)/);
assert.match(
  app,
  /function syncEditorToProject\(\)[\s\S]*?flushCraftRescore\(\);/,
  "存盘/生成前必须补齐防抖中的打分"
);
assert.match(app, /function packWriteContext\(p, task, chapter, instruction\)/);
assert.match(app, /if \(writeContextCache\?\.signature === signature\) return writeContextCache\.packed/);
assert.match(app, /function bumpProjectRevision\(p = project\(\)\) \{\s*invalidateWriteContext\(\);/);
for (const field of ["updatedAt", "instruction", "contextBudgetChars", "contextBudgetTokens", "memoryDepth"]) {
  assert.ok(
    app.slice(app.indexOf("function writeContextSignature"), app.indexOf("function packWriteContext")).includes(field),
    `上下文缓存签名必须包含 ${field}，否则计量表会说谎`
  );
}
assert.equal((app.match(/Ctx\.packForWrite\(/g) || []).length, 1, "packForWrite 只从缓存入口调用");
// 细纲列表里有作者正在编辑的输入框，防抖回调只能重画提示条
assert.match(app, /if \(repaintHint && p\.activeChapterId === ch\.id\) paintCraftHint\(ch\)/);

function htmlTagById(id) {
  return html.match(new RegExp(`<[^>]*\\sid="${id}"[^>]*>`))?.[0] || "";
}
for (const [id, label] of [
  ["writeChaptersScrim", "关闭章节列表"],
  ["writeTaskScrim", "关闭故事检查器"],
]) {
  const tag = htmlTagById(id);
  assert.match(tag, /type="button"/, `${id} must be a button`);
  assert.match(tag, /class="drawer-scrim"/, `${id} must reuse drawer-scrim`);
  assert.match(tag, /tabindex="-1"/, `${id} must stay out of tab order`);
  assert.match(tag, new RegExp(`aria-label="${label}"`), `${id} must close by label`);
}
assert.match(html, /id="libraryScrim"[^>]*class="drawer-scrim"|class="drawer-scrim"[^>]*id="libraryScrim"/);
assert.match(app, /\$\("writeChaptersScrim"\)\?\.addEventListener\("click", \(\) => setChapterDrawer\(false, true\)\)/);
assert.match(app, /\$\("writeTaskScrim"\)\?\.addEventListener\("click", \(\) => setInspectorDrawer\(false, true\)\)/);
assert.match(css, /body\.chapters-open #writeChaptersScrim/);
assert.match(css, /body\.inspector-open #writeTaskScrim/);
assert.match(css, /\.shell\.library-open #libraryScrim/);
assert.doesNotMatch(css, /\.shell\.library-open \.drawer-scrim\s*\{/);
assert.doesNotMatch(css, /@media\s*\(\s*max-width:\s*860px\s*\)/);
assert.doesNotMatch(css, /max-height:\s*280px/);
assert.doesNotMatch(css, /^\.tabs\s*\{/m);
assert.doesNotMatch(css, /^\.tab\s*\{/m);
assert.doesNotMatch(css, /^\.tab\.active\s*\{/m);
assert.doesNotMatch(css, /^\.panel\s*\{/m);
assert.doesNotMatch(css, /^\.panel\.active\s*\{/m);
assert.doesNotMatch(css, /^\.action-grid\s*\{/m);
assert.doesNotMatch(css, /^\.action\s*\{/m);
assert.doesNotMatch(css, /^\.action:hover\s*\{/m);
assert.doesNotMatch(css, /\.field\.check\b/);
assert.doesNotMatch(css, /\.vault-bar\b/);
assert.doesNotMatch(css, /\.library-rail\.is-collapsed\b/);
assert.doesNotMatch(css, /\.collapsible-panel\.is-collapsed[^\n{]*\.library-head/);
assert.doesNotMatch(css, /\.collapsible-panel\.is-collapsed[^\n{]*\.library-filter-wrap/);
assert.doesNotMatch(css, /\.collapsible-panel\.is-collapsed[^\n{]*\.library-list/);
assert.doesNotMatch(css, /\.collapsible-panel\.is-collapsed[^\n{]*\.library-foot/);
assert.doesNotMatch(css, /\.step\.skip\b/);
assert.doesNotMatch(css, /\.chip\.busy\b/);
assert.doesNotMatch(css, /\.chip\.err\b/);
assert.doesNotMatch(css, /\.select\.block\b/);

function srcBetween(haystack, start, end) {
  const a = haystack.indexOf(start);
  const b = haystack.indexOf(end, a + start.length);
  assert.ok(a >= 0, `missing start marker: ${start.slice(0, 80)}`);
  assert.ok(b > a, `missing end marker after ${start.slice(0, 80)}`);
  return haystack.slice(a, b);
}

assert.match(vault, /function classifyDiskAdopt\(flags\)/);
assert.match(vault, /function pickLocalChapterForConflictDisplay\(queued, live, diskChapter\)/);
assert.match(vault, /function chapterBodiesDiverge\(localCh, diskCh\)/);
assert.match(store, /function shouldApplyRecoveredChapter\(saved, diskChapter\)/);
assert.match(app, /function diskAdoptFlags\(p\)/);
assert.match(app, /async function replaceMemoryWithDisk\(p, fresh, \{ intent \} = \{\}\)/);
assert.match(app, /function enqueueChapterConflictsIfDiverged\(p, freshBook\)/);
assert.match(app, /function refreshConflictDiskSides\(p, freshBook\)/);
assert.match(app, /Store\.clearRecovery\?\.\(p\)/);

const reloadFn = srcBetween(app, "async function reloadActiveBookFromDisk", "function renderProjects");
assert.match(reloadFn, /classifyDiskAdopt|intent: "silent"/);
assert.doesNotMatch(reloadFn, /adoptChapterBaselines/);
assert.doesNotMatch(reloadFn, /state\.projects\[idx\] = /);

const renameFn = srcBetween(app, "onRename: async (slug, title)", "onDelete:");
assert.match(renameFn, /await flushProject\(target\)/);
assert.doesNotMatch(renameFn, /state\.projects\[idx\] = /);
assert.doesNotMatch(renameFn, /adoptChapterBaselines/);
assert.match(renameFn, /adoptDiskConcurrencyMeta/);

assert.match(app, /function writeDeskHasPendingDiskFlush\(\)/);
assert.match(app, /dirty \|\| p\?._dirty \|\| diskTimer/);
const switchFn = srcBetween(app, "async function switchMode(mode)", "async function reloadActiveBookFromDisk");
assert.match(switchFn, /await flushToDisk\(\)/);
assert.match(switchFn, /bootDone && wasWrite/);
assert.match(switchFn, /writeDeskHasPendingDiskFlush\(\)/);
assert.match(switchFn, /epoch !== switchEpoch/);
assert.doesNotMatch(switchFn, /persistOnly\(\{ immediateDisk/);
assert.ok(
  switchFn.indexOf("++switchEpoch") > switchFn.indexOf("guardGen"),
  "switchEpoch must increment after guardGen"
);
assert.ok(
  switchFn.indexOf("++switchEpoch") > switchFn.indexOf("取消则留在工作区"),
  "switchEpoch must increment after workspace confirm cancel"
);
assert.match(app, /const PROJECT_FORM_FIELDS = \[/);
assert.match(app, /function bindProjectFormPersistence\(\)/);
for (const id of [
  "targetChapters",
  "lockWorld",
  "lockCast",
  "lockSpine",
  "lockLogline",
  "lockForbidden",
  "lockMust",
  "stylePov",
  "styleTense",
  "stylePacing",
  "styleDialogue",
  "styleRules",
  "styleForbidden",
  "styleExamples",
  "ideaInput",
  "authorNote",
  "graphJson",
]) {
  assert.match(app, new RegExp(`PROJECT_FORM_FIELDS[\\s\\S]*?"${id}"`));
}
const formBindFn = srcBetween(app, "function bindProjectFormPersistence()", '["manuscript", "chapterTitle"]');
assert.match(formBindFn, /addEventListener\("input"/);
assert.match(formBindFn, /addEventListener\("change"/);
assert.match(formBindFn, /addEventListener\("blur"/);
assert.match(formBindFn, /markDirty\(\)/);
assert.match(formBindFn, /persistOnly\(\{ immediateDisk: true \}\)/);

const syncFn = srcBetween(app, "function syncEditorToProject()", "function selectChapter");
assert.match(persistenceUseCases, /function projectFormEqual\(/);
assert.match(persistenceUseCases, /function formGraphEqual\(/);
assert.match(app, /function normalizedTargetChapters\(value\)/);
assert.match(syncFn, /WriteUI\.captureProjectForm/);
assert.match(syncFn, /PersistenceFactory\.applyProjectForm/);
assert.match(syncFn, /normalizeTargetChapters: normalizedTargetChapters/);
assert.match(syncFn, /markDirty\(\)/);
assert.match(persistenceUseCases, /formGraphEqual\(project\.graph, graph\)/);
const syncReadIds = [...new Set([...syncFn.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]))];
const captureFormFn = srcBetween(writeUi, "function captureProjectForm", "function handoffPresentation");
const capturedFormIds = [
  ...captureFormFn.matchAll(/(?:byId|value)\("([^"]+)"\)/g),
].map((match) => match[1]);
const formFieldTable = srcBetween(app, "const PROJECT_FORM_FIELDS = [", "function bindProjectFormPersistence");
const listedFormFields = new Set([...formFieldTable.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
const dedicatedDirtyIds = new Set(["manuscript", "chapterTitle", "beatSceneList"]);
const syncReadsWithoutDirtyChain = syncReadIds.filter(
  (id) => !listedFormFields.has(id) && !dedicatedDirtyIds.has(id)
);
assert.deepEqual(
  syncReadsWithoutDirtyChain,
  [],
  `syncEditorToProject reads ${syncReadsWithoutDirtyChain.join(", ")} without a dirty chain`
);
assert.deepEqual(
  capturedFormIds.filter((id) => !listedFormFields.has(id)),
  [],
  "write-ui captureProjectForm may only read controls registered in PROJECT_FORM_FIELDS"
);
assert.ok(listedFormFields.has("graphJson"), "graphJson must be on the form dirty list");
assert.match(app, /\$\("manuscript"\)\.addEventListener\("input"/);

const authorHintFn = srcBetween(app, "function refreshAuthorNameHint()", "function loadPipelineView");
assert.match(authorHintFn, /const ideaEl = \$\("ideaInput"\)/);
assert.match(authorHintFn, /ideaInput: ideaEl \? ideaEl\.value/);
assert.match(authorHintFn, /authorNote: noteEl \? noteEl\.value/);
assert.doesNotMatch(authorHintFn, /\$\("ideaInput"\)\?\.value \|\| project\(\)\?\.ideaInput/);
assert.match(app, /\$\("chapterTitle"\)\.addEventListener\("input"/);
assert.match(app, /syncBeatPlanFromUi\(ch, \{ asUserEdit: true \}\)/);

const loadControlFn = srcBetween(app, "function loadControlView()", "const storyLabel");
assert.match(loadControlFn, /recoverConcatenatedStylePacing/);
assert.match(loadControlFn, /\$\("styleDialogue"\)/);
assert.doesNotMatch(loadControlFn, /\[style\.pacing, style\.dialogue\]/);
assert.match(uiShell, /function recoverConcatenatedStylePacing\(pacing, dialogue\)/);

const digestFn = srcBetween(app, '$("btnDigest")', "function saveActiveChapterNow");
assert.match(digestFn, /WriteCases\.handoffExisting/);
const lockLease = srcBetween(writeUseCases, "function acquireLock", "async function run");
assert.match(lockLease, /const token = runToken/);
assert.match(lockLease, /const current = \(\) => token === runToken/);
assert.match(lockLease, /release\(\)[\s\S]*?if \(current\(\)\) ports\.setLock\?\.\(false\)/);
const handoffUseCase = srcBetween(writeUseCases, "async function handoffExisting", "async function repairIssue");
assert.ok(
  handoffUseCase.indexOf("acquireLock(ports, chapter.id)") >= 0 &&
    handoffUseCase.indexOf("acquireLock(ports, chapter.id)") < handoffUseCase.indexOf("pipe.handoffChapter") &&
    handoffUseCase.indexOf("pipe.handoffChapter") < handoffUseCase.indexOf("lock.release()"),
  "handoff use case must hold its token-owned lock lease across the handoff await"
);
const steerFn = srcBetween(app, '$("btnSteer")', '$("btnAddTask")');
assert.ok(
  steerFn.indexOf("setGenLock(true") >= 0 && steerFn.indexOf("setGenLock(true") < steerFn.indexOf("authorSteer"),
  "steer must lock before steer await"
);
const repairFn = srcBetween(app, 'action === "repair"', "快捷键");
assert.match(repairFn, /WriteCases\.repairIssue/);
const repairUseCase = srcBetween(writeUseCases, "async function repairIssue", "return {");
assert.ok(
  repairUseCase.indexOf("acquireLock(ports, chapter.id)") >= 0 &&
    repairUseCase.indexOf("acquireLock(ports, chapter.id)") < repairUseCase.indexOf("pipe.repairChapterContinuity") &&
    repairUseCase.indexOf("pipe.repairChapterContinuity") < repairUseCase.indexOf("lock.release()"),
  "repair use case must hold its token-owned lock lease across the repair await"
);
assert.doesNotMatch(digestFn, /if \(guardGen\(/);
assert.doesNotMatch(steerFn, /if \(guardGen\(/);

const withAbortFn = srcBetween(app, "function withAbort", "function confirmSpineRisk");
assert.match(withAbortFn, /WriteCases\.run/);
const abortUseCase = srcBetween(writeUseCases, "async function run", "function addWritingHints");
assert.match(abortUseCase, /const token = \+\+runToken/);
assert.match(abortUseCase, /token === runToken/);
const abortCatchAt = abortUseCase.indexOf("} catch (error)");
const abortFinallyAt = abortUseCase.indexOf("} finally {");
assert.ok(abortCatchAt >= 0 && abortFinallyAt > abortCatchAt, "write runner must have catch then finally");
const abortCatch = abortUseCase.slice(abortCatchAt, abortFinallyAt);
const abortFinally = abortUseCase.slice(abortFinallyAt);
assert.ok(
  abortCatch.indexOf("current()") >= 0 && abortCatch.indexOf("current()") < abortCatch.indexOf("onRunError"),
  "superseded write runner must not report an error"
);
assert.ok(abortFinally.indexOf("current()") >= 0, "write runner finally must check the run token");
assert.ok(
  abortFinally.indexOf("current()") < abortFinally.indexOf("abortController = null"),
  "only the current write runner may clear its AbortController"
);
assert.ok(
  abortFinally.indexOf("current()") < abortFinally.indexOf("ports.setLock?.(false)"),
  "only the current write runner may unlock"
);
assert.ok(
  abortFinally.indexOf("ports.flushStream?.()") >= 0 &&
    abortFinally.indexOf("ports.flushStream?.()") < abortFinally.indexOf("ports.persist?.()"),
  "stream flush must run before save copies textarea back onto chapter body"
);
assert.match(
  srcBetween(app, "function paintActiveChapterStreamNow", "function flushActiveChapterStream"),
  /p\.activeChapterId !== ch\.id/
);
const streamPaintFn = srcBetween(app, "function paintActiveChapterStream(", "function addWritingFileHints");
assert.match(streamPaintFn, /requestAnimationFrame/);
assert.doesNotMatch(
  streamPaintFn,
  /p\.activeChapterId !== ch\.id/,
  "anti-bleed guard must run at paint time, not when a delta is scheduled"
);

const graphAssignAt = analyzeUi.indexOf("p.graph = result.graph");
const markDirtyAt = analyzeUi.indexOf("deps.markDirty", graphAssignAt);
const persistAt = analyzeUi.indexOf("persistAnalysis", graphAssignAt);
assert.ok(
  graphAssignAt >= 0 && markDirtyAt > graphAssignAt && markDirtyAt < persistAt,
  "analysis must markDirty before persistAnalysis"
);
assert.match(app, /markDirty: \(\) => markDirty\(\)/);

const openConflictFn = srcBetween(app, "function openNextSaveConflict()", "async function reconcileSaveWarnings");
assert.match(openConflictFn, /SaveConflicts\.activateNext\(\)/);
assert.match(conflictUseCases, /deps\.pickLocalChapter\?\.\(queued, live, diskChapter\)/);
assert.doesNotMatch(openConflictFn, /entry\.localChapter = localChapter/);

const reloadBtnFn = srcBetween(app, '$("btnReloadDisk")', '$("btnMigrate")');
assert.match(reloadBtnFn, /replaceMemoryWithDisk/);
assert.match(reloadBtnFn, /intent: "discard"/);
assert.match(
  srcBetween(app, "async function replaceMemoryWithDisk", "function persistSaveConflicts"),
  /Store\.clearRecovery/
);

const focusFn = srcBetween(app, "async function checkExternalChange()", "function syncEditorToProject");
assert.match(focusFn, /replaceMemoryWithDisk|enqueueChapterConflictsIfDiverged/);
assert.match(focusFn, /diskAdoptFlags/);
assert.match(focusFn, /clearRecovery|enqueueChapterConflictsIfDiverged/);

const flushProjectFn = srcBetween(app, "async function flushProject(p)", "async function prepareVaultSwitch");
assert.match(flushProjectFn, /return Persistence\.flushProject\(p\)/);
assert.match(persistenceUseCases, /async function serialized\(operation\)/);
assert.match(persistenceUseCases, /if \(inFlight\)[\s\S]*?await inFlight/);
assert.match(persistenceUseCases, /deps\.saveBook\(project\.slug, project\)/);

const flushSyncFn = srcBetween(app, "window.__mogaoFlushSync", "const filterMigrateProjects");
assert.match(flushSyncFn, /Vault\.adoptChapterBaselines\?\.\(p, saveResult, warnings\)/);
assert.match(flushSyncFn, /Persistence\.isSaving\(\)/);

assert.equal(
  (app.match(/await Vault\.saveBook\(/g) || []).length,
  0,
  "async whole-book PUTs belong to persistence-use-cases, not the controller"
);
assert.match(app, /btnImportSeed[\s\S]*?await flushProject\(seed\)/);
assert.match(app, /btnExport[\s\S]*?await flushToDisk\(\)/);
assert.match(app, /syncBeatPlanFromUi\(ch, \{ asUserEdit: true \}\)/);
assert.match(workspace, /source: "snapshot"/);
assert.match(workspace, /写章台未存盘正文也会被快照替换/);

console.log("test_frontend_contract: OK");
