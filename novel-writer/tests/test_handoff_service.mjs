import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8"), sandbox, {
  filename: path.join(root, "runtime-observability.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "handoff-service.js"), "utf8"), sandbox, {
  filename: path.join(root, "handoff-service.js"),
});
const factory = sandbox.window.NOVEL_HANDOFF_SERVICE;
assert.equal(typeof factory?.create, "function");

const events = [];
const prompts = {
  commonGuard: "guard",
  chapterDigest: {
    system: "digest",
    user: (title, body) => `${title}\n${body}`,
  },
  chapterGraphDelta: {
    system: "graph",
    user: (title, body) => `${title}\n${body}`,
  },
};
const context = {
  packForDigest: () => ({
    prevTitle: "",
    prevTail: "",
    openLoops: [],
    activeWarnings: [],
    storyState: {},
    storyline: [],
    existingCanon: [],
  }),
  mergeStoryState: (_project, digest) => events.push(`memory:${digest.chapter}`),
  mergeGraph: (_current, delta) => ({ nodes: delta.nodes || [], edges: delta.edges || [] }),
};
let productionState = {
  canHandoff: () => ({ ok: true }),
  isQualityBlocked: (chapter) => Boolean(chapter.blocked),
};
const chapterState = {
  startHandoff: (chapter) => {
    chapter.handoffStatus = "pending";
    events.push("state:start");
  },
  markDigestComplete: (_chapter, task) => {
    task.status = "digested";
    events.push("state:digest");
  },
  completeHandoff: (chapter, task) => {
    chapter.handoffStatus = "done";
    task.status = "done";
    events.push("state:complete");
  },
  markHandoffStale: (chapter) => {
    chapter.handoffStatus = "stale";
    events.push("state:stale");
  },
  requestRevision: () => events.push("state:revision"),
};
let failDigest = false;
const api = {
  chatJson: async ({ messages }) => {
    const system = String(messages?.[0]?.content || "");
    if (system.includes("digest")) {
      events.push("api:digest");
      if (failDigest) throw new Error("digest unavailable");
      return { chapter: "第一章", happened: ["抵达旧港"], summary: "抵达旧港" };
    }
    if (system.includes("graph")) {
      events.push("api:graph");
      return { nodes: [{ id: "n1" }], edges: [] };
    }
    throw new Error("unexpected request");
  },
};
const service = factory.create({
  getPrompts: () => prompts,
  getContext: () => context,
  getApi: () => api,
  getChapterState: () => chapterState,
  getProductionState: () => productionState,
  getCraft: () => null,
  getProductionEngine: () => ({ markHandoffComplete: () => events.push("engine:complete") }),
  getRag: () => ({ ensureIndex: () => events.push("rag:index") }),
  getObservability: () => sandbox.window.NOVEL_OBSERVABILITY,
  getApplyCraftSignals: () => () => [],
  textSignature: (text) => `sig:${String(text).length}`,
  log: (_project, message) => events.push(`log:${message}`),
});

const project = { memoryRoll: [], graph: { nodes: [], edges: [] }, chapters: [], tasks: [] };
const chapter = { id: "c1", taskId: "t1", order: 1, title: "第一章", body: "正文" };
const task = { id: "t1", order: 1, status: "written" };
project.chapters.push(chapter);
project.tasks.push(task);

const digest = await service.handoffChapter(
  project,
  { model: "test", productionEngineEnabled: true, productionQualityPolicy: "strict" },
  chapter,
  task,
  { qualityValidated: true }
);
assert.equal(digest.summary, "抵达旧港");
assert.equal(chapter.handoffStatus, "done");
assert.equal(task.status, "done");
assert.equal(project.runtimeDiagnostics.at(-1).type, "handoff");
assert.equal(project.runtimeDiagnostics.at(-1).ok, true);
assert.deepEqual(
  events.filter((event) => /^(?:state|api|engine|rag):/.test(event)),
  ["state:start", "api:digest", "state:digest", "api:graph", "state:complete", "engine:complete", "rag:index"],
  "交接必须按摘要、关系、终态、索引的顺序提交"
);

const pending = service.pendingHandoffChapters(
  {
    chapters: [
      { id: "old", taskId: "old-task", order: 1, body: "x", handoffStatus: "stale" },
      { id: "blocked", taskId: "blocked-task", order: 2, body: "x", handoffStatus: "stale", blocked: true },
      { id: "done", taskId: "done-task", order: 3, body: "x", handoffStatus: "done" },
      { id: "current", taskId: "current-task", order: 4, body: "x", handoffStatus: "stale" },
    ],
  },
  { id: "current-task", order: 4 }
);
assert.deepEqual(Array.from(pending, (item) => item.id), ["old"]);

productionState = {
  ...productionState,
  canHandoff: () => ({ ok: false, reason: "quality failed" }),
};
await assert.rejects(
  service.handoffChapter(
    project,
    { productionEngineEnabled: true, productionQualityPolicy: "strict" },
    { ...chapter, handoffStatus: "" },
    { ...task, status: "written" }
  ),
  (error) => error?.code === "QUALITY_GATE_BLOCKED"
);
assert.ok(events.includes("state:revision"));
assert.equal(project.lastFailure.category, "quality");
assert.equal(project.lastFailure.retry.safe, true);

productionState = {
  ...productionState,
  canHandoff: () => ({ ok: true }),
};
failDigest = true;
const failedChapter = { id: "c2", title: "第二章", body: "正文二" };
await assert.rejects(
  service.handoffChapter(project, { model: "test" }, failedChapter, { id: "t2", status: "written" }, {
    qualityValidated: true,
  }),
  /digest unavailable/
);
assert.equal(failedChapter.handoffStatus, "stale");
assert.equal(failedChapter.lastFailure.category, "handoff");
assert.equal(failedChapter.lastFailure.stage, "digest");
assert.match(failedChapter.lastFailure.body.signature, /^fnv1a_/);

console.log("test_handoff_service: OK");

// A failed strict review must retry, and changing evidence invalidates completed reviews.
{
  let calls = 0;
  let unavailable = true;
  const reviewPrompts = { commonGuard: "guard", continuityReview: { system: "review", user: (value) => value } };
  const reviewer = factory.create({
    getPrompts: () => reviewPrompts,
    getContext: () => ({ packForContinuityReview: (book) => ({ user: book.locks.logline }) }),
    getApi: () => ({ chatJson: async () => { calls++; if (unavailable) throw new Error("unavailable"); return { issues: [] }; } }),
    getChapterState: () => ({}), getProductionState: () => ({}), getApplyCraftSignals: () => () => [],
    textSignature: (text) => String(text), log() {},
  });
  const book = { locks: { logline: "original" } };
  const draft = { id: "review", body: "same text" };
  const config = { continuityReviewEnabled: true, continuityReviewPolicy: "strict" };
  await assert.rejects(reviewer.reviewAndRepairChapter(book, config, draft), /unavailable/);
  await assert.rejects(reviewer.reviewAndRepairChapter(book, config, draft), /unavailable/);
  assert.equal(calls, 2, "error cache must not bypass strict review");
  unavailable = false;
  assert.equal((await reviewer.reviewAndRepairChapter(book, config, draft)).status, "pass");
  await reviewer.reviewAndRepairChapter(book, config, draft);
  assert.equal(calls, 3, "completed review with identical inputs should be reused");
  book.locks.logline = "changed";
  await reviewer.reviewAndRepairChapter(book, config, draft);
  assert.equal(calls, 4);
  delete reviewPrompts.continuityReview;
  await assert.rejects(reviewer.reviewAndRepairChapter(book, config, draft), (e) => e.code === "CONTINUITY_REVIEW_FAILED");
}
