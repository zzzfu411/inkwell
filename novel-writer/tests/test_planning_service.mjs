import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "planning-service.js"), "utf8"), sandbox, {
  filename: path.join(root, "planning-service.js"),
});

const factory = sandbox.window.NOVEL_PLANNING_SERVICE;
assert.equal(typeof factory?.create, "function");

const prompts = {
  commonGuard: "guard",
  stagePitch: { system: "pitch", user: (idea) => idea },
  stageWorld: { system: "world", user: (payload) => JSON.stringify(payload) },
  stageCast: { system: "cast", user: (payload) => JSON.stringify(payload) },
  stageSpine: { system: "spine", user: (payload, count) => JSON.stringify({ payload, count }) },
};
const replies = [
  {
    title_candidates: ["锁名测试"],
    pitch: "被迫结盟",
    genre: "悬疑",
    hooks: ["身份谜团"],
    tone: "克制",
  },
  { locations: [{ name: "旧港" }] },
  {
    nodes: [{ id: "heroine", label: "沈月", role: "heroine", aliases: [] }],
    edges: [],
    cast_summary: "沈月负责追查旧案",
  },
  {
    logline: "沈月追查旧港谜案",
    tasks: [
      { id: "t1", order: 1, chapter_title: "模型重写标题", goal: "沈月抵达旧港" },
      { id: "t2", order: 2, chapter_title: "第二章", goal: "沈月发现暗号" },
    ],
  },
];
const calls = [];
const logs = [];
const service = factory.create({
  getPrompts: () => prompts,
  getApi: () => ({
    chatJson: async (request) => {
      calls.push(request);
      return replies.shift();
    },
  }),
  log: (_project, message) => logs.push(message),
});

assert.equal(service.normalizeTargetChapters(2), 8);
assert.equal(service.normalizeTargetChapters(999), 400);
assert.equal(service.looksLikePersonName("高冷"), false);
assert.equal(service.looksLikePersonName("苏晚"), true);

const project = {
  title: "旧标题",
  ideaInput: "女主叫苏晚，在旧港追查谜案",
  authorNote: "女主姓名为苏晚",
  targetChapters: 2,
  locks: { lockedFields: [], forbidden: [], mustHonor: [], logline: "" },
  graph: { nodes: [], edges: [], stats: {} },
  tasks: [{ id: "t1", order: 1, status: "done", chapter_title: "作者确认标题", goal: "保留既有目标" }],
  chapters: [{ id: "c1", taskId: "t1", order: 1, body: "已完成正文" }],
};

const steps = [];
await service.runFullPlan(project, { baseUrl: "local", apiKey: "", model: "test" }, {
  onStep: (name, state) => steps.push(`${name}:${state}`),
});

assert.equal(calls.length, 4);
assert.equal(project.stage, "ready");
assert.equal(project.targetChapters, 8);
assert.equal(project.graph.nodes[0].label, "苏晚", "作者指定人名必须覆盖模型改名");
assert.ok(project.graph.nodes[0].aliases.includes("沈月"));
assert.equal(project.tasks.find((task) => task.id === "t1").status, "done");
assert.equal(project.tasks.find((task) => task.id === "t1").chapter_title, "作者确认标题");
assert.match(project.tasks.find((task) => task.id === "t2").goal, /苏晚/);
assert.ok(steps.includes("pitch:start") && steps.includes("spine:done"));
assert.ok(logs.some((message) => message.includes("策划流水线完成")));

const merged = service.mergeTasksPreservingProgress(
  [{ id: "done", order: 1, status: "written", chapter_title: "本地标题" }],
  [
    { id: "done", order: 1, status: "pending", chapter_title: "模型标题" },
    { id: "new", order: 2, status: "pending", chapter_title: "新标题" },
  ],
  []
);
assert.equal(merged[0].chapter_title, "本地标题");
assert.equal(merged[0].status, "written");
assert.equal(merged[1].id, "new");

console.log("test_planning_service: OK");
