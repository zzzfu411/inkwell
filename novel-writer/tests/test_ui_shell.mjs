import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "ui-shell.js"), "utf8"), sandbox);
const UI = sandbox.window.NOVEL_UI_SHELL;

const migrated = UI.migrateUiState({
  activeMode: "graph",
  panels: { library: false, writeTask: true },
  panelWidths: { chapters: 20, inspector: 900 },
});
assert.equal(migrated.schemaVersion, 4);
assert.equal(migrated.activeSection, "story");
assert.equal(migrated.storyMode, "graph");
assert.equal(migrated.libraryOpen, true);
assert.equal(migrated.panels.library, undefined);
assert.equal(migrated.panelWidths.chapters, 190);
assert.equal(migrated.panelWidths.inspector, 420);
assert.equal(UI.primaryModeForState(migrated), "graph");
assert.equal(UI.startupModeForState(migrated), "graph");
assert.equal(UI.startupModeForState({}), "write");
assert.equal(
  UI.startupModeForState({ schemaVersion: 3, activeSection: "workspace" }),
  "workspace",
  "existing users keep an explicitly persisted section"
);
assert.equal(
  UI.startupModeForState({ schemaVersion: 4, activeSection: "workspace", hasChosenSection: true }),
  "workspace"
);

const recentChapter = UI.chooseStartupChapter({
  activeChapterId: "missing",
  chapters: [
    { id: "old", order: 1, updatedAt: 10 },
    { id: "recent", order: 2, updatedAt: 20 },
  ],
});
assert.equal(recentChapter.id, "recent");
assert.equal(
  UI.chooseStartupChapter({ activeChapterId: "old", chapters: [{ id: "old" }, { id: "recent", updatedAt: 20 }] }).id,
  "old"
);

assert.equal(UI.writingPositionKey({ slug: "book" }, { id: "chapter" }), "book::chapter");
const positions = UI.sanitizeWritingPositions({
  old: { selectionStart: -4, selectionEnd: 2, scrollTop: -10, updatedAt: 1 },
  recent: { selectionStart: 5, selectionEnd: 3, scrollTop: 42, updatedAt: 2 },
}, 1);
assert.deepEqual(Object.keys(positions), ["recent"]);
assert.deepEqual(
  { ...positions.recent },
  { selectionStart: 5, selectionEnd: 5, scrollTop: 42, updatedAt: 2 }
);

assert.equal(UI.layoutForWidth(1280).inspector, "rail");
assert.equal(UI.layoutForWidth(1199).inspector, "drawer");
assert.equal(UI.layoutForWidth(1049).chapters, "drawer");

const risks = UI.continuityStats([
  { status: "open", severity: "blocker" },
  { status: "open", severity: "minor" },
  { status: "handled", severity: "major" },
]);
assert.equal(risks.total, 2);
assert.equal(risks.high, 1);
assert.equal(risks.tone, "danger");

const healthy = UI.contextHealth(
  { chars: 5000, budget: 10000, tokens: 2500, tokenBudget: 8000, rag: { mode: "hybrid", hits: [1, 2] } },
  { detailCanon: { facts: [1, 2, 3] } }
);
assert.equal(healthy.state, "healthy");
assert.equal(healthy.percent, 50);
assert.equal(healthy.canonCount, 3);
assert.equal(healthy.ragHits, 2);

assert.equal(UI.contextHealth({ chars: 9500, budget: 10000 }, {}).state, "warning");
assert.equal(UI.contextHealth({ truncated: [{ key: "memory" }] }, {}).state, "trimmed");
assert.equal(UI.contextHealth({ rag: { mode: "failed" } }, {}).state, "degraded");
assert.equal(UI.contextHealth({ rag: { mode: "bm25", hits: [] } }, {}).state, "empty");
assert.equal(UI.contextHealth({ rag: { mode: "stale", hits: [] } }, {}).state, "stale");
assert.equal(UI.contextHealth({ rag: { mode: "blocked", hits: [] } }, {}).state, "blocked");
assert.equal(
  UI.contextHealth(
    { rag: { mode: "unavailable", hits: [] } },
    { activeTaskId: "t2", _lastRag: { taskId: "t2", mode: "blocked", hitCount: 0 } }
  ).ragLabel,
  "严格策略阻断",
  "the last actionable retrieval failure overrides a passive render-time unavailable state"
);
assert.equal(
  UI.contextHealth({ truncated: [{ key: "memory" }], rag: { mode: "failed" } }, {}).state,
  "degraded",
  "retrieval failure must not be hidden behind ordinary budget trimming"
);

const revisions = UI.createRevisionTracker((item) => item?.id || "default");
const bookA = { id: "book-a" };
const bookB = { id: "book-b" };
assert.equal(revisions.read(bookA), 0);
const savedA = revisions.bump(bookA);
assert.equal(revisions.matches(bookA, savedA), true);
revisions.bump(bookA);
assert.equal(revisions.matches(bookA, savedA), false, "an older save must not clean a newer edit");
assert.equal(revisions.read(bookB), 0, "revisions are isolated per project");
revisions.clear(bookA);
assert.equal(revisions.read(bookA), 0);

for (const status of [200, 201, 204, 299]) {
  assert.equal(UI.isSuccessfulHttpStatus(status), true, `${status} must be treated as success`);
}
for (const status of [0, 199, 300, 409, 500, undefined, "not-a-status"]) {
  assert.equal(UI.isSuccessfulHttpStatus(status), false, `${status} must be treated as failure`);
}
assert.equal(UI.safeCssToken("written"), "written");
assert.equal(UI.safeCssToken("in_progress"), "in_progress");
assert.equal(UI.safeCssToken('pending" onmouseover="alert(1)'), "pending");
assert.equal(UI.safeCssToken("<img>"), "pending");

assert.deepEqual(
  { ...UI.generationStagePresentation("reviewing") },
  { stage: "reviewing", label: "连续性审查中…", kind: "busy" }
);
assert.deepEqual(
  { ...UI.generationStagePresentation("prev-handoff") },
  { stage: "prev-handoff", label: "上一章记忆未交接 · 先补摘要…", kind: "busy" }
);
assert.equal(UI.generationStagePresentation("unknown-stage"), null);

// 状态条四段进度：只认状态文案，三种终态必须分得开
const rail = (label, kind) => UI.generationRailState(label, kind);
const railStages = (label, kind) =>
  rail(label, kind)
    .stages.map((s) => `${s.stage}:${s.done ? "done" : s.active ? "active" : s.failed ? "failed" : "-"}`)
    .join(" ");

assert.equal(rail("闲聊文案"), null, "认不出阶段又不是终态时不动进度条");
assert.equal(rail("装配写作记忆…").current, 0);
assert.equal(rail("请求模型并生成正文…").current, 1);
assert.equal(rail("连续性审查中…").current, 2);
assert.equal(rail("章后交接 · 提炼摘要…").current, 3);
assert.equal(railStages("连续性审查中…"), "context:done model:done review:active handoff:-");

const done = rail("完成 · 记忆已交接");
assert.equal(done.complete, true);
assert.equal(done.failed, false);
assert.equal(done.settled, true);
assert.equal(done.hideAfterMs, 1600);
assert.equal(railStages("完成 · 记忆已交接"), "context:done model:done review:done handoff:done");

// 正文出来了但还没交接：只能绿前两段，不能显示成全绿
const draft = rail("重写完成 · 待重新交接", "warn");
assert.equal(draft.complete, false, "「待交接」不算完成");
assert.equal(draft.draftComplete, true);
assert.equal(railStages("重写完成 · 待重新交接", "warn"), "context:done model:done review:- handoff:-");

// 停止和失败都走失败态，且失败段停在当前阶段
const stopped = rail("已停止", "warn");
assert.equal(stopped.failed, true);
assert.equal(stopped.complete, false);
assert.equal(stopped.hideAfterMs, 2600);
assert.equal(rail("章后交接失败", "err").failed, true);
assert.equal(railStages("连续性审查失败", "err"), "context:done model:done review:failed handoff:-");
assert.equal(railStages("出错了", "err"), "context:failed model:- review:- handoff:-", "认不出阶段的失败落在第一段");
assert.equal(rail("交接未完成").complete, false, "「未完成」不能当完成");

// app.js 的交接失败文案必须带「待」字，否则「修订完成」会让这里误判成全绿
const reviseFailed = rail("修订完成 · 交接失败，待重试", "warn");
assert.equal(reviseFailed.failed, true);
assert.equal(reviseFailed.complete, false, "交接失败不许显示成完成");
assert.equal(
  railStages("修订完成 · 交接失败，待重试", "warn"),
  "context:done model:done review:done handoff:failed",
  "前三段绿、交接段红"
);
assert.equal(rail("修订完成 · 记忆已交接").complete, true);

assert.equal(UI.recoverConcatenatedStylePacing("缓", "对话多"), "缓");
assert.equal(UI.recoverConcatenatedStylePacing("缓；对话多", "对话多"), "缓");
assert.equal(UI.recoverConcatenatedStylePacing("缓；对话多；对话多", "对话多"), "缓");
assert.equal(UI.recoverConcatenatedStylePacing("短段落；对白推进", "对话多"), "短段落；对白推进");
assert.equal(UI.recoverConcatenatedStylePacing("对话多", "对话多"), "对话多");
assert.equal(UI.recoverConcatenatedStylePacing("缓；对话多", ""), "缓；对话多");

console.log("test_ui_shell: OK");
