/**
 * 纯逻辑冒烟（Node）：任务合并 + 状态机跳过写章条件。
 * 不启动浏览器。
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// 最小 mock
const sandbox = {
  window: {
    NOVEL_STORE: { uid: () => "id1" },
    NOVEL_DEFAULTS: { chapterTargetWords: 2000 },
    NOVEL_PROMPTS: {
      commonGuard: "",
      stagePitch: { system: "", user: () => "" },
      stageWorld: { system: "", user: () => "" },
      stageCast: { system: "", user: () => "" },
      stageSpine: { system: "", user: () => "" },
      writeChapter: { system: () => "" },
      chapterBeat: { system: "", user: () => "" },
      chapterDigest: { system: "", user: () => "" },
      chapterGraphDelta: { system: "", user: () => "" },
      authorSteer: { system: "", user: () => "" },
      truncate: (s, n) => s.slice(0, n),
      summarizeNodes: () => "",
      summarizeEdges: () => "",
    },
    NOVEL_CONTEXT: {
      findPrevWrittenChapter: (project, task) => {
        const order = Number(task?.order) || 0;
        const list = (project.chapters || []).filter((c) => String(c.body || "").trim());
        const before = list.filter((c) => (c.order || 0) < order);
        return before.length ? before[before.length - 1] : null;
      },
      packForWrite: () => ({ user: "u", meta: { wordTarget: 2000, chars: 10, budget: 100, used: [] } }),
      packForDigest: (project, chapter, task) => ({
        title: chapter?.title || "",
        body: chapter?.body || "",
        task,
        prevTitle: "",
        prevTail: "",
        openLoops: [],
        storyState: null,
      }),
      mergeCanonFacts: (project, facts) => {
        project._mergedFacts = Array.isArray(facts) ? facts.slice() : [];
        return { added: project._mergedFacts.length, conflicts: 0, total: project._mergedFacts.length };
      },
      mergeGraph: (a, b) => b || a,
      mergeStoryState: (project, d) => {
        project.storyState = project.storyState || {};
        project.storyState.lastChapter = d?.chapter || "";
        return project.storyState;
      },
      rebuildStoryStateFromMemory: (project) => {
        project.storyState = project.storyState || { establishedFacts: [] };
        return project.storyState;
      },
    },
    NOVEL_API: {
      chat: async () => ({ content: "新正文" }),
      chatJson: async () => ({ happened: ["x"] }),
    },
  },
  console,
};

const code = fs.readFileSync(path.join(root, "pipeline.js"), "utf8");
vm.runInNewContext(code, sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root, "craft.js"), "utf8"), sandbox);
const Pipe = sandbox.window.NOVEL_PIPELINE;

// mergeTasksPreservingProgress
const existing = [
  { id: "t001", order: 1, status: "done", chapter_title: "旧章一", goal: "已完成目标" },
  { id: "t002", order: 2, status: "pending", chapter_title: "旧章二", goal: "可覆盖" },
];
const incoming = [
  { id: "t001", order: 1, chapter_title: "新章一", goal: "新目标" },
  { id: "t002", order: 2, chapter_title: "新章二", goal: "新目标2" },
  { id: "t003", order: 3, chapter_title: "新章三", goal: "g3" },
];
const chapters = [{ taskId: "t001", body: "正文1" }];
const merged = Pipe.mergeTasksPreservingProgress(existing, incoming, chapters);
assert.equal(merged.find((t) => t.id === "t001").status, "done");
assert.equal(merged.find((t) => t.id === "t001").chapter_title, "旧章一");
assert.equal(merged.find((t) => t.id === "t002").status, "pending");
assert.equal(merged.find((t) => t.id === "t002").goal, "新目标2");
assert.ok(merged.find((t) => t.id === "t003"));

const overlay = Pipe.mergeTasksPreservingProgress(
  [
    { id: "t1", order: 1, status: "done", chapter_title: "A" },
    { id: "t2", order: 2, status: "written", chapter_title: "B" },
  ],
  [{ id: "t3", order: 3, status: "pending", chapter_title: "C" }],
  []
);
assert.equal(overlay.length, 3, "重跑策划必须追加保留不在新稿里的已有进度");
assert.ok(overlay.find((t) => t.id === "t1"));
assert.ok(overlay.find((t) => t.id === "t2"));
assert.ok(overlay.find((t) => t.id === "t3"));

// autoChapterCycle: written 不应再次调用写（用计数 mock）
let chatCalls = 0;
sandbox.window.NOVEL_API.chat = async () => {
  chatCalls++;
  return { content: "叠章危险" };
};
sandbox.window.NOVEL_API.chatJson = async () => ({ happened: ["h"], chapter: "c" });

const project = {
  chapters: [{ id: "c1", taskId: "t1", title: "T", body: "已有正文", order: 1 }],
  tasks: [],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  tone: "",
};
const task = { id: "t1", status: "written", chapter_title: "T", order: 1, goal: "g" };
project.tasks = [task];
project.activeChapterId = "c1";

await Pipe.autoChapterCycle(project, { baseUrl: "", apiKey: "", model: "" }, task, {});
assert.equal(chatCalls, 0, "written 状态禁止再调 chat 写章");
assert.equal(task.status, "done");
assert.equal(project.chapters[0].handoffStatus, "done");
assert.ok(project.chapters[0].body.includes("已有正文"));
assert.ok(!project.chapters[0].body.includes("叠章危险"));
assert.equal(typeof Pipe.planChapterBeat, "function");
assert.equal(typeof Pipe.continueChapter, "function");
assert.equal(typeof Pipe.reviseChapter, "function");
assert.equal(typeof Pipe.rewritePassage, "function");
await assert.rejects(
  () => Pipe.rewritePassage(project, { baseUrl: "", apiKey: "", model: "" }, task, project.chapters[0], { selection: "" }),
  /没有可重写/
);

let continueCalls = 0;
sandbox.window.NOVEL_API.chat = async () => {
  continueCalls += 1;
  return { content: "续写段" };
};
sandbox.window.NOVEL_API.chatJson = async () => ({
  scenes: [{ place: "栈道", action: "撤离", turn: "被拦住" }],
});
const contTask = { id: "t1", status: "done", chapter_title: "T", order: 1, goal: "g" };
project.tasks = [contTask];
await Pipe.continueChapter(project, { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false, manualAutoHandoff: false }, contTask, {
  handoff: false,
});
assert.equal(continueCalls, 1, "续写应对已完成章追加正文");
assert.ok(project.chapters[0].body.includes("已有正文"));
assert.ok(project.chapters[0].body.includes("续写段"));

const ch = project.chapters[0];
ch.beatPlan = { scenes: [{ place: "栈道", action: "撤离" }] };
const issues = Pipe.applyCraftSignals(project, contTask, ch, ch.body);
assert.ok(ch.craftScore);
assert.ok(Array.isArray(issues));
assert.ok(ch.openingKind);

const weatherTask = { id: "tw", status: "pending", chapter_title: "雾", order: 2, goal: "g" };
const weatherProject = {
  chapters: [],
  tasks: [weatherTask],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  tone: "",
};
sandbox.window.NOVEL_API.chat = async () => ({ content: "夜色沉沉，大雾漫过栈道。" });
await Pipe.writeOneChapter(
  weatherProject,
  { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false },
  weatherTask,
  {}
);
assert.ok(weatherProject.chapters[0].craftScore, "写路径自动出现 craftScore");
assert.equal(weatherProject.chapters[0].openingKind, "weather");
sandbox.window.NOVEL_API.chat = async () => ({ content: "「你还要装到什么时候？」林清问。" });
await Pipe.continueChapter(
  weatherProject,
  { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false, manualAutoHandoff: false },
  weatherTask,
  { handoff: false }
);
assert.equal(weatherProject.chapters[0].openingKind, "weather", "续写不得改写 openingKind");
assert.ok(weatherProject.chapters[0].body.includes("夜色沉沉"));
assert.ok(weatherProject.chapters[0].body.includes("林清问"));

const rewriteTask = { id: "tr", status: "done", chapter_title: "改", order: 4, goal: "g" };
const rewriteProject = {
  chapters: [{ id: "cr", taskId: "tr", title: "改", body: "原文前 选段 原文后", order: 4, handoffStatus: "done" }],
  tasks: [rewriteTask],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  detailCanon: { facts: [] },
};
sandbox.window.NOVEL_API.chat = async () => ({ content: "新选段" });
sandbox.window.NOVEL_API.chatJson = async () => ({ happened: ["改写"] });
await Pipe.rewritePassage(
  rewriteProject,
  { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false },
  rewriteTask,
  rewriteProject.chapters[0],
  {
    selection: "选段",
    before: "原文前 ",
    after: " 原文后",
    instruction: "改",
  }
);
assert.equal(rewriteProject.chapters[0].body, "原文前 新选段 原文后");
assert.equal(rewriteProject.chapters[0].handoffStatus, "done", "重写后默认自动交接");
assert.equal(rewriteTask.status, "done");

await Pipe.rewritePassage(
  rewriteProject,
  { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false, manualAutoHandoff: false },
  rewriteTask,
  rewriteProject.chapters[0],
  {
    selection: "新选段",
    before: "原文前 ",
    after: " 原文后",
  }
);
assert.equal(rewriteProject.chapters[0].handoffStatus, "stale", "关闭自动交接时重写只标 stale");

const reviseTask = { id: "ta", status: "done", chapter_title: "批", order: 5, goal: "g" };
const reviseProject = {
  chapters: [{ id: "ca", taskId: "ta", title: "批", body: "旧章正文", order: 5, handoffStatus: "done" }],
  tasks: [reviseTask],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  detailCanon: { facts: [] },
};
sandbox.window.NOVEL_API.chat = async () => ({ content: "修订后正文" });
await Pipe.reviseChapter(
  reviseProject,
  { baseUrl: "", apiKey: "", model: "", chapterBeatEnabled: false },
  reviseTask,
  reviseProject.chapters[0],
  { originalBody: "旧章正文", annotation: "改结尾" }
);
assert.equal(reviseProject.chapters[0].body, "修订后正文");
assert.equal(reviseProject.chapters[0].handoffStatus, "done", "批注修订后默认自动交接");

// 补交接要扫前文所有 stale 章，不能只补相邻上一章：改完第 1 章后去写第 3 章，第 1 章旧摘要不能进上下文
const staleFirst = { id: "cp1", taskId: "tp1", title: "第一章", body: "第一章正文", order: 1, handoffStatus: "stale" };
const staleSecond = { id: "cp2", taskId: "tp2", title: "第二章", body: "第二章正文", order: 2, handoffStatus: "stale" };
const untouched = { id: "cp0", taskId: "tp0", title: "序", body: "序正文", order: 0 };
const nextTask = { id: "tn", status: "pending", chapter_title: "下", order: 3, goal: "g" };
const recoverProject = {
  chapters: [staleFirst, staleSecond, untouched],
  tasks: [
    { id: "tp1", status: "written", chapter_title: "第一章", order: 1, goal: "g" },
    { id: "tp2", status: "written", chapter_title: "第二章", order: 2, goal: "g" },
    nextTask,
  ],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  detailCanon: { facts: [] },
};
sandbox.window.NOVEL_API.chat = async () => ({ content: "第三章正文" });
sandbox.window.NOVEL_API.chatJson = async () => ({ happened: ["h"] });
await Pipe.autoChapterCycle(
  recoverProject,
  { baseUrl: "", apiKey: "", model: "", harnessEnabled: false, chapterBeatEnabled: false },
  nextTask,
  {}
);
assert.equal(staleFirst.handoffStatus, "done", "连写前应补第一章交接");
assert.equal(staleSecond.handoffStatus, "done", "连写前应补第二章交接");
assert.equal(untouched.handoffStatus, undefined, "从未交接过的旧章不该被自动烧额度");
assert.ok(recoverProject.chapters.some((c) => c.taskId === "tn" && String(c.body).includes("第三章正文")));

// 补交接按故事顺序，且不允许改正文
const orderLog = Pipe.pendingHandoffChapters(
  { chapters: [staleSecond, staleFirst].map((c) => ({ ...c, handoffStatus: "stale" })) },
  nextTask
).map((c) => c.id);
assert.deepEqual(orderLog, ["cp1", "cp2"], "补交接按 order 从旧到新");

// 作者点停止不是交接失败：AbortError 必须原样抛出
const abortCh = { id: "cab", taskId: "tab", title: "停", body: "停章正文", order: 1, handoffStatus: "stale" };
const abortTask = { id: "tab2", status: "pending", chapter_title: "下", order: 2, goal: "g" };
const abortProject = {
  chapters: [abortCh],
  tasks: [{ id: "tab", status: "written", chapter_title: "停", order: 1, goal: "g" }, abortTask],
  locks: {},
  graph: { nodes: [], edges: [] },
  memoryRoll: [],
  pipelineLog: [],
  detailCanon: { facts: [] },
};
sandbox.window.NOVEL_API.chatJson = async () => {
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
};
await assert.rejects(
  () => Pipe.recoverStaleHandoffs(abortProject, { baseUrl: "", apiKey: "", model: "" }, abortTask, {}),
  (e) => e.name === "AbortError",
  "补交接遇到停止应透传 AbortError，而不是包成普通失败"
);
sandbox.window.NOVEL_API.chatJson = async () => ({ happened: ["h"] });

// 无正文证据的问题（例如合成的「任务未覆盖」）不能进唯一命中替换引擎
assert.equal(
  Pipe.repairableIssues({
    issues: [
      { severity: "major", summary: "任务未覆盖：密道对峙", evidence: "" },
      { severity: "blocker", summary: "年龄矛盾", evidence: "他今年十七" },
      { severity: "minor", summary: "小事", evidence: "有证据但不严重" },
    ],
  }).length,
  1,
  "只有带正文证据的 blocker/major 才可局部修复"
);

const digestCh = {
  id: "cd",
  title: "夜",
  body: "夜色沉沉，大雾漫过栈道。阿清两个字写在名册上。",
  order: 3,
};
const digestTask = { id: "td", status: "written", chapter_title: "夜", order: 3 };
const digestProject = {
  chapters: [digestCh],
  tasks: [digestTask],
  memoryRoll: [],
  pipelineLog: [],
  detailCanon: { facts: [] },
};
sandbox.window.NOVEL_API.chatJson = async () => ({
  happened: ["写名册"],
  must_carry: ["谢宴是化神"],
  new_info: ["林清是卧底"],
  canon_facts: [{ key: "林清.假名", value: "阿清", evidence: "阿清" }],
});
await Pipe.digestChapter(digestProject, { baseUrl: "", apiKey: "", model: "" }, digestCh, digestTask);
assert.ok((digestProject._mergedFacts || []).some((fact) => fact.key === "林清.假名"));
assert.ok(!(digestProject._mergedFacts || []).some((fact) => fact.key === "谢宴"));
assert.ok(!(digestProject._mergedFacts || []).some((fact) => String(fact.value || "").includes("卧底")));

console.log("test_pipeline_logic: OK");
