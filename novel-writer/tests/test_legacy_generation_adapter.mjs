import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "legacy-generation-adapter.js"), "utf8"), sandbox, {
  filename: path.join(root, "legacy-generation-adapter.js"),
});
const factory = sandbox.window.NOVEL_LEGACY_GENERATION_ADAPTER;
assert.equal(typeof factory?.create, "function");

const events = [];
let chatMode = "write";
const api = {
  chat: async (request) => {
    events.push(`chat:${chatMode}`);
    const content = chatMode === "rewrite" ? "新段落" : chatMode === "empty" ? "" : "生成正文";
    request.onDelta?.(content, content);
    return { content };
  },
  chatJson: async () => ({ scenes: [{ goal: "进入旧港" }] }),
};
const chapterState = {
  markWriting: (_chapter, task) => {
    task.status = "writing";
    events.push("state:writing");
  },
  markWritten: (_chapter, task) => {
    task.status = "written";
    events.push("state:written");
  },
  markPaused: (_chapter, task) => {
    task.status = "pending";
    events.push("state:paused");
  },
  markHandoffStale: () => events.push("state:stale"),
  completeHandoff: () => events.push("state:complete"),
};
const handoff = {
  recoverStaleHandoffs: async () => events.push("handoff:recover"),
  reviewAndRepairChapter: async () => events.push("handoff:review"),
  digestChapter: async () => events.push("handoff:digest"),
  extractGraphDelta: async () => events.push("handoff:graph"),
  handoffChapter: async (_project, _cfg, chapter) => {
    events.push("handoff:chapter");
    return chapter;
  },
  maybeHandoffAfterRevision: async (_project, _cfg, _task, chapter) => {
    events.push("handoff:revision");
    return chapter;
  },
};
const context = {
  findPrevWrittenChapter: () => null,
  getActivePlotLoops: () => [],
  packForWrite: () => ({
    user: "packed",
    meta: { wordTarget: 1200, chars: 6, budget: 1000, used: ["task"] },
  }),
  recordContextManifest: () => events.push("context:manifest"),
  mergeContinuityIssues: () => events.push("context:issues"),
};
let uid = 0;
const adapter = factory.create({
  getPrompts: () => ({
    commonGuard: "guard",
    writeChapter: { system: () => "write" },
    chapterBeat: { system: "beat", user: (value) => value },
    authorSteer: { system: "steer", user: (value) => value },
  }),
  getContext: () => context,
  getApi: () => api,
  getChapterState: () => chapterState,
  getProductionState: () => ({
    invalidateAfterBodyEdit: () => events.push("production:invalidated"),
  }),
  getUid: () => `chapter-${++uid}`,
  getDefaults: () => ({ chapterTargetWords: 1200, outputReserveTokens: 2000 }),
  getCraft: () => ({
    scoreChapterCraft: () => ({ openingKind: "action", issues: [] }),
    recentOpeningKinds: () => [],
  }),
  getProductionEngine: () => ({
    runChapter: async () => {
      events.push("production:run");
      return { route: "production" };
    },
  }),
  getHarness: () => null,
  getRag: () => null,
  getHandoffService: () => handoff,
  textSignature: (text) => `sig:${String(text).length}`,
  log: (_project, message) => events.push(`log:${message}`),
});

const project = {
  title: "兼容生成",
  chapters: [],
  tasks: [],
  memoryRoll: [],
  pipelineLog: [],
  locks: { logline: "", forbidden: [] },
};
const task = { id: "t1", order: 1, status: "pending", chapter_title: "第一章" };
project.tasks.push(task);

const chapter = await adapter.writeOneChapter(project, {}, task);
assert.equal(chapter.id, "chapter-1");
assert.equal(chapter.body, "生成正文");
assert.equal(task.status, "written");
assert.deepEqual(
  events.filter((event) => event.startsWith("state:")),
  ["state:writing", "state:written"]
);
assert.equal(chapter.craftScore.openingKind, "action");

chatMode = "rewrite";
chapter.body = "前选段后";
await adapter.rewritePassage(project, {}, task, chapter, {
  selection: "选段",
  before: "前",
  after: "后",
  instruction: "更克制",
});
assert.equal(chapter.body, "前新段落后");
assert.equal(chapter.revisionHistory.at(-1).kind, "rewrite");
assert.ok(events.includes("production:invalidated"));
assert.ok(events.includes("handoff:revision"));

chatMode = "empty";
const beforeFailure = chapter.body;
await assert.rejects(
  adapter.reviseChapter(project, {}, task, chapter, {
    originalBody: chapter.body,
    annotation: "调整语气",
  }),
  (error) => error?.code === "REVISION_FAILED"
);
assert.equal(chapter.body, beforeFailure, "失败的流式修订不能覆盖已提交正文");

const routed = await adapter.autoChapterCycle(
  { chapters: [], tasks: [], memoryRoll: [] },
  { productionEngineEnabled: true, chapterBeatEnabled: true },
  { id: "t2", order: 2, status: "pending" }
);
assert.equal(routed.route, "production");
assert.ok(events.includes("handoff:recover"));
assert.ok(events.includes("production:run"));

console.log("test_legacy_generation_adapter: OK");
