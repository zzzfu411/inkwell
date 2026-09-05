import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {
  window: { NOVEL_DEFAULTS: { appVersion: "0.19.0" } },
  console,
  Date,
  Math,
  Set,
  TextEncoder,
  performance: { now: () => 0 },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8"), sandbox, {
  filename: path.join(root, "runtime-observability.js"),
});

const Factory = sandbox.window.NOVEL_OBSERVABILITY;
assert.deepEqual(Array.from(Factory.ERROR_CATEGORIES), [
  "model",
  "retrieval",
  "plan",
  "quality",
  "handoff",
  "storage",
  "conflict",
  "cancel",
]);

const cases = [
  [{ name: "AbortError" }, {}, "cancel"],
  [{ code: "RAG_REQUIRED" }, {}, "retrieval"],
  [{ code: "PRODUCTION_PLAN_FAILED" }, {}, "plan"],
  [{ code: "QUALITY_GATE_BLOCKED" }, {}, "quality"],
  [{ code: "PREV_HANDOFF_FAILED" }, {}, "handoff"],
  [{ code: "STORAGE_SAVE_FAILED" }, {}, "storage"],
  [{ code: "ANALYSIS_SAVE_CONFLICT" }, {}, "conflict"],
  [{ code: "UNKNOWN" }, { stage: "model-call" }, "model"],
];
for (const [error, context, category] of cases) {
  assert.equal(Factory.classifyError(error, context).category, category);
}

let wall = Date.parse("2026-09-05T08:00:00.000Z");
let mono = 100;
const Obs = Factory.create({
  clock: () => wall++,
  monotonic: () => mono,
  eventLimit: 500,
});
const bodySentinel = "正文绝不能进入诊断：林玄推门而入";
const promptSentinel = "SYSTEM PROMPT 绝密";
const keySentinel = "sk-do-not-export-123456";
const project = {
  id: "book_1",
  schemaVersion: 2,
  chapters: [],
  tasks: [],
  contextManifests: [
    {
      id: "ctx_42_t2",
      stage: "scene-writing",
      chars: 8120,
      tokens: 4510,
      used: ["canon", "previous", "retrieval"],
      omitted: ["world"],
      truncated: [{ key: "previous" }],
      rag: { hits: [{ id: "private-evidence-text-must-not-export" }] },
    },
  ],
};
const task = { id: "t2", status: "writing" };
const chapter = {
  id: "c2",
  body: bodySentinel,
  bodyRevision: 7,
  bodyAuthority: "chapter.body",
  handoffStatus: "stale",
  production: { status: "needs_revision", stage: "quality-review" },
};
project.chapters.push(chapter);
project.tasks.push(task);

const failureError = new Error(`${keySentinel} ${promptSentinel} ${bodySentinel}`);
failureError.code = "CONTINUITY_REVIEW_FAILED";
const envelope = Obs.captureFailure(project, failureError, {
  chapter,
  task,
  stage: "quality-review",
});
assert.equal(envelope.category, "quality");
assert.equal(envelope.stage, "quality-review");
assert.equal(envelope.state.task, "writing");
assert.equal(envelope.state.production, "needs_revision");
assert.equal(envelope.state.handoff, "stale");
assert.equal(envelope.body.chapterId, "c2");
assert.equal(envelope.body.chars, bodySentinel.length);
assert.match(envelope.body.signature, /^fnv1a_[0-9a-f]{8}$/);
assert.equal(envelope.evidence.manifestId, "ctx_42_t2");
assert.equal(envelope.evidence.usedCount, 3);
assert.equal(envelope.evidence.omittedCount, 1);
assert.equal(envelope.evidence.truncatedCount, 1);
assert.equal(envelope.evidence.ragHits, 1);
assert.equal(envelope.retry.safe, true);
assert.equal(chapter.lastFailure.id, envelope.id);
assert.equal(task.lastFailure.id, envelope.id);
assert.equal(project.lastFailure.id, envelope.id);
assert.equal(Obs.captureFailure(project, failureError, { chapter, task }).id, envelope.id, "same error is recorded once");

const conflict = Obs.failureEnvelope(Object.assign(new Error("conflict"), { code: "SAVE_CONFLICT" }), {
  project,
  chapter,
  task,
  stage: "save-conflict",
});
assert.equal(conflict.category, "conflict");
assert.equal(conflict.retry.safe, false);
assert.equal(conflict.retry.mode, "resolve-conflict");

const started = Obs.startTimer();
mono += 12.375;
Obs.record(
  "context",
  {
    stage: "write",
    durationMs: Obs.elapsedMs(started),
    taskId: task.id,
    chapterId: chapter.id,
    chars: 9000,
    tokens: 5000,
    budget: 14000,
    tokenBudget: 10000,
    used: ["canon", "previous"],
    omitted: ["world"],
    truncated: [],
    ragHits: 4,
    body: bodySentinel,
    messages: [{ content: promptSentinel }],
    apiKey: keySentinel,
    Authorization: `Bearer ${keySentinel}`,
  },
  project
);
mono += 2;
Obs.record("model", {
  stage: "draft",
  durationMs: 20,
  ok: true,
  model: "gemini-test",
  stream: true,
  inputChars: 5000,
  outputChars: 2200,
  finishReason: "stop",
  usage: { prompt_tokens: 1000, completion_tokens: 800, total_tokens: 1800 },
  messages: [{ content: promptSentinel }],
  apiKey: keySentinel,
});
Obs.record("storage", {
  durationMs: 8,
  ok: true,
  bytes: Obs.byteLength(project),
  chapters: project.chapters,
  warnings: 0,
  body: bodySentinel,
});

const report = Obs.exportReport(project);
assert.equal(report.product, "Inkwell");
assert.equal(report.appVersion, "0.19.0");
assert.ok(report.summary.events >= 4);
assert.equal(report.summary.failures, 1);
assert.equal(report.summary.byCategory.quality, 1);
assert.ok(report.summary.durationMs.p95 >= 8);
const serialized = JSON.stringify(report);
for (const forbidden of [bodySentinel, promptSentinel, keySentinel, "Authorization", "messages", "apiKey", "private-evidence-text-must-not-export"]) {
  assert.ok(!serialized.includes(forbidden), `diagnostics leaked forbidden value/key: ${forbidden}`);
}
assert.ok(!serialized.includes(failureError.message), "raw exception messages must never be exported");

for (const [stage, category] of [
  ["abort-run", "cancel"],
  ["version-conflict", "conflict"],
  ["checkpoint-write", "storage"],
  ["digest", "handoff"],
  ["continuity-review", "quality"],
  ["context-build", "retrieval"],
  ["beat-contract", "plan"],
  ["unrecognized-stage", "model"],
]) {
  assert.equal(Factory.classifyError({ code: "UNKNOWN" }, { stage }).category, category);
}
assert.equal(Factory.classifyError({ status: 409 }, { stage: "model-call" }).category, "conflict");
assert.equal(Factory.classifyError({ code: "ILLEGAL_CHAPTER_TRANSITION" }).category, "conflict");
assert.equal(Factory.classifyError({ code: "PROJECT_STATE_INVALID" }).category, "conflict");
assert.equal(Factory.classifyError({ stage: "save-file" }).category, "storage");
assert.equal(Factory.classifyError({ lastErrorStage: "handoff-index" }).category, "handoff");

const manifestEnvelope = Obs.failureEnvelope({ code: "RAG_REQUIRED" }, {
  project,
  chapter: { id: "c3", body: "", revision: 2, authoritativeBody: "vault" },
  task: null,
  stage: "context-build",
  manifest: {
    id: "ctx_override",
    blocks: [{ key: "canon" }, { id: "previous" }, {}],
    chars: 100,
    tokens: 50,
    omitted: 2,
    truncated: 1,
    rag: {},
  },
  retrySafe: false,
  retryMode: "author-confirm",
});
assert.equal(manifestEnvelope.body.authoritative, "vault");
assert.equal(manifestEnvelope.evidence.manifestId, "ctx_override");
assert.equal(manifestEnvelope.evidence.usedCount, 3);
assert.equal(manifestEnvelope.retry.safe, false);
assert.equal(manifestEnvelope.retry.mode, "author-confirm");
assert.equal(Obs.failureEnvelope({ code: "UNKNOWN" }).body, null);
assert.equal(Obs.failureEnvelope({ code: "UNKNOWN" }).evidence, null);

assert.equal(Obs.record("not-allowed", { body: bodySentinel }), null);
Obs.record("model", {
  ok: false,
  stage: "model-call",
  code: "MODEL_NETWORK",
  durationMs: -3,
  usage: null,
});
Obs.record("handoff", {
  ok: false,
  stage: "digest",
  code: "HANDOFF_FAILED",
  reviewIssues: 2,
  digestFacts: ["one"],
});
Obs.record("performance", {
  scenario: "scale-400",
  operation: "context-build",
  chapters: 400,
  medianMs: 4,
  p95Ms: 8,
  budgetMs: 120,
  passed: true,
});
assert.equal(Obs.sessionEvents().at(-1).type, "performance");

const cyclic = {};
cyclic.self = cyclic;
assert.equal(Obs.byteLength(cyclic), 0);
const frozenProject = Object.freeze({ id: "future", runtimeDiagnostics: [] });
const frozenChapter = Object.freeze({ id: "future-c", body: "future" });
const sealedError = Object.preventExtensions(Object.assign(new Error("hidden"), { code: "MODEL_ERROR" }));
const frozenFailure = Obs.captureFailure(frozenProject, sealedError, {
  chapter: frozenChapter,
  attachProject: false,
  stage: "model-call",
});
assert.equal(frozenFailure.category, "model");

const sessionBeforeClear = Obs.sessionEvents().length;
assert.ok(sessionBeforeClear > 0);
Obs.clearSession();
assert.equal(Obs.sessionEvents().length, 0);
assert.equal(Obs.exportReport().summary.durationMs.median, 0);

for (let index = 0; index < 260; index += 1) {
  Obs.record("storage", { durationMs: index, ok: true, bytes: index, chapters: 1 }, project);
}
assert.equal(project.runtimeDiagnostics.length, 240, "project diagnostics are bounded");

console.log("test_runtime_observability: OK");
