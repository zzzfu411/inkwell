import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console, AbortController, setTimeout, TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8"), sandbox, {
  filename: path.join(root, "runtime-observability.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "write-use-cases.js"), "utf8"), sandbox, {
  filename: path.join(root, "write-use-cases.js"),
});
const factory = sandbox.window.NOVEL_WRITE_USE_CASES;
assert.equal(typeof factory?.create, "function");

const events = [];
let failRevision = false;
const pipe = {
  ensureChapterForTask: (project, task) => {
    let chapter = project.chapters.find((item) => item.taskId === task.id);
    if (!chapter) {
      chapter = { id: `c-${task.id}`, taskId: task.id, title: task.chapter_title, body: "" };
      project.chapters.push(chapter);
    }
    project.activeChapterId = chapter.id;
    return chapter;
  },
  autoChapterCycle: async (project, _cfg, task, hooks) => {
    events.push(`cycle:${task.id}`);
    hooks.onCheckpoint?.();
    const chapter = project.chapters.find((item) => item.taskId === task.id);
    chapter.body = "生成正文";
    chapter.handoffStatus = "done";
    task.status = "done";
  },
  reviseChapter: async (_project, _cfg, _task, chapter) => {
    chapter.body = "流式半稿";
    if (failRevision) throw new Error("revision failed");
    chapter.body = "修订终稿";
  },
  continueChapter: async (_project, _cfg, _task, chapterProject) => chapterProject,
  rewritePassage: async (_project, _cfg, _task, chapter, hooks) => {
    chapter.body = hooks.before + "新段落" + hooks.after;
  },
  handoffChapter: async (_project, _cfg, chapter) => {
    chapter.handoffStatus = "done";
    events.push("handoff");
  },
  repairChapterContinuity: async () => ({ applied: 1 }),
};
const flushed = [];
const checkpoints = [];
const cases = factory.create({
  pipe,
  productionState: { isQualityBlocked: () => false },
  uid: () => "manual-id",
  persistCheckpoint: (project) => checkpoints.push(project.activeChapterId),
  flushProject: async (project) => flushed.push(project.activeChapterId),
  getObservability: () => sandbox.window.NOVEL_OBSERVABILITY,
  sleep: async () => {},
});

assert.equal(cases.classifyError({ name: "AbortError" }), "cancel");
assert.equal(cases.classifyError({ code: "QUALITY_GATE_BLOCKED" }), "quality");
assert.equal(cases.classifyError({ code: "PRODUCTION_PLAN_FAILED" }), "plan");
assert.equal(cases.classifyError({ code: "UNKNOWN" }, { stage: "model-call" }), "model");

const project = {
  id: "p1",
  chapters: [],
  tasks: [{ id: "t1", order: 1, status: "pending", chapter_title: "第一章" }],
  locks: { forbidden: [] },
};
const portEvents = [];
await cases.writeTask(
  { project, cfg: {}, task: project.tasks[0], signal: new AbortController().signal },
  {
    setLock: (active) => portEvents.push(`lock:${active}`),
    flushStream: () => portEvents.push("stream:flush"),
    captureReview: () => ({ before: true }),
    taskOutcome: ({ pending }) => portEvents.push(`pending:${pending}`),
  }
);
assert.equal(project.chapters[0].body, "生成正文");
assert.deepEqual(checkpoints, ["c-t1"]);
assert.deepEqual(flushed, ["c-t1"]);
assert.ok(portEvents.indexOf("lock:true") < portEvents.indexOf("lock:false"));
assert.ok(portEvents.includes("pending:false"));

failRevision = true;
const chapter = project.chapters[0];
chapter.body = "作者原稿";
chapter.updatedAt = 10;
await assert.rejects(
  cases.revise(
    {
      project,
      cfg: {},
      chapter,
      signal: new AbortController().signal,
      annotation: "调整节奏",
      originalBody: "作者原稿",
      originalUpdatedAt: 10,
    },
    {}
  ),
  (error) => error?.code === "REVISION_FAILED"
);
assert.equal(chapter.body, "作者原稿", "失败修订必须回滚到已提交原稿");
assert.equal(chapter.updatedAt, 10);

failRevision = false;
await cases.rewriteSelection(
  {
    project,
    cfg: {},
    task: project.tasks[0],
    chapter,
    signal: new AbortController().signal,
    body: "前选段后",
    start: 1,
    end: 3,
    instruction: "更克制",
  },
  {}
);
assert.equal(chapter.body, "前新段落后");

const runnerEvents = [];
let releaseFirst;
const first = cases.run(
  (signal) =>
    new Promise((resolve, reject) => {
      releaseFirst = resolve;
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  {},
  {
    onRunError: () => runnerEvents.push("first:error"),
    setLock: (active) => runnerEvents.push(`first:lock:${active}`),
  }
);
const second = cases.run(async () => "second", {}, {
  onRunError: () => runnerEvents.push("second:error"),
  setLock: (active) => runnerEvents.push(`second:lock:${active}`),
});
assert.equal(await second, "second");
const firstResult = await first;
assert.equal(firstResult?.superseded, true, "被后继运行抢占的旧请求必须返回显式 superseded 结果");
assert.equal(firstResult?.error?.name, "AbortError");
releaseFirst?.();
assert.ok(!runnerEvents.includes("first:error"), "被后续运行接管的旧请求不得回写错误状态");
assert.ok(runnerEvents.includes("second:lock:false"));

let observedFailure = null;
const planError = Object.assign(new Error("raw prompt and sk-secret must not be diagnosed"), {
  code: "PRODUCTION_PLAN_FAILED",
});
const failedRun = await cases.run(
  async () => {
    throw planError;
  },
  {},
  {
    failureContext: () => ({
      project,
      chapter: project.chapters[0],
      task: project.tasks[0],
      stage: "production-contract",
    }),
    onRunError: (_error, category, envelope) => {
      assert.equal(category, "plan");
      observedFailure = envelope;
    },
  }
);
assert.equal(failedRun.error, planError);
assert.equal(observedFailure.category, "plan");
assert.equal(observedFailure.body.chapterId, project.chapters[0].id);
assert.ok(!JSON.stringify(observedFailure).includes("sk-secret"));

// 旧交接被局部修复抢占后，旧用例 finally 不能解开后继者的锁。
let releaseRepair;
let repairStarted = false;
const lockPipe = {
  handoffChapter: async (_project, _cfg, _chapter, _task, hooks) =>
    new Promise((resolve, reject) => {
      hooks.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    }),
  repairChapterContinuity: async () => {
    repairStarted = true;
    await new Promise((resolve) => {
      releaseRepair = resolve;
    });
    return { applied: true };
  },
};
const lockCases = factory.create({
  pipe: lockPipe,
  productionState: { isQualityBlocked: () => false },
  uid: () => "id",
  flushProject: async () => {},
  getObservability: () => sandbox.window.NOVEL_OBSERVABILITY,
});
const lockProject = { chapters: [], tasks: [] };
const lockChapter = { id: "lock-chapter", body: "正文", handoffStatus: "stale" };
const lockIssue = { id: "issue", status: "open" };
let locked = false;
const lockPort = { setLock: (active) => (locked = active) };
const runPort = { ...lockPort, onRunError() {} };
const digestRun = lockCases.run(
  (signal) =>
    lockCases.handoffExisting(
      { project: lockProject, cfg: {}, chapter: lockChapter, task: {}, signal },
      lockPort
    ),
  {},
  runPort
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(locked, true);
const repairRun = lockCases.run(
  (signal) =>
    lockCases.repairIssue(
      {
        project: lockProject,
        cfg: { manualAutoHandoff: false },
        chapter: lockChapter,
        task: {},
        issue: lockIssue,
        signal,
      },
      lockPort
    ),
  {},
  runPort
);
while (!repairStarted) await new Promise((resolve) => setTimeout(resolve, 0));
await digestRun;
assert.equal(locked, true, "被抢占的交接不得释放局部修复持有的锁");
releaseRepair();
await repairRun;
assert.equal(locked, false);

console.log("test_write_use_cases: OK");
