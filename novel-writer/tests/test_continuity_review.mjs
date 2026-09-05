import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let reviewCalls = 0;
let repairCalls = 0;
const sandbox = {
  window: {
    NOVEL_STORE: { uid: () => "uid" },
    NOVEL_DEFAULTS: {
      contextBudgetChars: 16000,
      contextBudgetTokens: 12000,
      bodyTailChars: 2800,
      prevChapterTailChars: 1800,
      memoryDepth: 12,
      canonMaxFactsInPrompt: 36,
      chapterTargetWords: 2000,
    },
    NOVEL_RAG: { ensureIndex: () => ({ N: 1 }) },
  },
  console,
};

for (const file of ["prompts.js", "craft.js", "chapter-state.js", "production-state.js", "memory-reducers.js", "context-budget.js", "context-evidence.js", "context.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: path.join(root, file) });
}
for (const file of ["planning-service.js", "handoff-service.js", "legacy-generation-adapter.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: path.join(root, file) });
}

sandbox.window.NOVEL_API = {
  chat: async () => ({ content: "" }),
  chatJson: async ({ messages }) => {
    const system = String(messages?.[0]?.content || "");
    if (system.includes("连续性审稿器")) {
      reviewCalls++;
      if (reviewCalls === 1) {
        return {
          verdict: "fail",
          summary: "等级违反锁定设定",
          issues: [
            {
              type: "canon",
              severity: "blocker",
              summary: "林玄等级被写成十五级",
              entity: "林玄",
              evidence: "林玄已经升到十五级",
              expected: "林玄.等级=五级",
              suggestion: "将十五级改回五级",
            },
          ],
        };
      }
      return { verdict: "pass", summary: "复检通过", issues: [], task_coverage: { completed: ["保持等级"], missing: [] } };
    }
    if (system.includes("谨慎的小说校订器")) {
      repairCalls++;
      return {
        patches: [
          {
            search: "林玄已经升到十五级",
            replace: "林玄依旧停留在五级",
            reason: "恢复锁定等级",
          },
        ],
      };
    }
    throw new Error("unexpected prompt");
  },
};

vm.runInNewContext(fs.readFileSync(path.join(root, "pipeline.js"), "utf8"), sandbox);
const Pipe = sandbox.window.NOVEL_PIPELINE;

const project = {
  title: "连续性审查测试",
  locks: { logline: "林玄守住五级实力", forbidden: [] },
  spine: { logline: "林玄守住五级实力", volumes: [] },
  tasks: [],
  chapters: [
    { id: "c1", taskId: "t1", order: 1, title: "第一章", body: "林玄确认自己仍是五级。" },
    { id: "c2", taskId: "t2", order: 2, title: "第二章", body: "林玄已经升到十五级。众人震惊。" },
  ],
  activeChapterId: "c2",
  memoryRoll: [],
  plotLoops: [],
  continuityIssues: [],
  continuityMeta: { loopSchema: 1, issueSchema: 1 },
  detailCanon: {
    facts: [{ key: "林玄.等级", value: "五级", entity: "林玄", category: "number", locked: true }],
    conflicts: [],
  },
  storyline: { positionSummary: "卷一开端", nextDirection: "保持五级", chapterLogs: [] },
  storyState: { protagonistState: "五级", establishedFacts: ["林玄仍为五级"], openLoops: [] },
  graph: { nodes: [{ id: "lin", label: "林玄" }], edges: [] },
  pipelineLog: [],
};
const task = {
  id: "t2",
  order: 2,
  chapter_title: "第二章",
  goal: "保持五级并解决追兵",
  beats: ["遭遇追兵"],
  must_include: ["保持五级"],
  must_not: ["无铺垫升级"],
};
project.tasks = [{ id: "t1", order: 1, status: "done", chapter_title: "第一章", goal: "确认等级" }, task];

const result = await Pipe.reviewAndRepairChapter(
  project,
  {
    baseUrl: "",
    apiKey: "",
    model: "gemini-3.6-flash",
    contextBudgetChars: 16000,
    contextBudgetTokens: 12000,
    continuityReviewEnabled: true,
    continuityAutoRepair: true,
    continuityReviewPolicy: "strict",
  },
  project.chapters[1],
  task,
  {}
);

assert.equal(result.status, "pass");
assert.equal(reviewCalls, 2, "one initial review and one bounded recheck");
assert.equal(repairCalls, 1, "only one repair call");
assert.match(project.chapters[1].body, /依旧停留在五级/);
assert.equal(project.chapters[1].revisionHistory.length, 1);
assert.match(project.chapters[1].revisionHistory[0].body, /十五级/);
assert.equal(project.chapters[1].handoffStatus, "stale");
assert.equal(task.status, "written", "legacy continuity repair must use the shared chapter transition");
assert.equal(project.continuityIssues[0].status, "handled", "repaired issue is closed after passing recheck");
assert.equal(project.continuityIssues[0].expected, "林玄.等级=五级", "structured checker keeps Canon evidence");

sandbox.window.NOVEL_API.chatJson = async () => ({
  verdict: "pass",
  summary: "无事实冲突",
  issues: [],
  task_coverage: { completed: ["保持五级"], missing: ["解决追兵"] },
});
const coverageChapter = {
  id: "c3",
  taskId: "t3",
  order: 3,
  title: "第三章",
  body: "林玄确认自己仍是五级，并未动手解决追兵。",
};
const coverageTask = {
  id: "t3",
  order: 3,
  chapter_title: "第三章",
  goal: "保持五级并解决追兵",
  must_include: ["解决追兵"],
};
project.chapters.push(coverageChapter);
project.tasks.push(coverageTask);
const coverageReview = await Pipe.reviewChapterContinuity(
  project,
  {
    baseUrl: "",
    apiKey: "",
    model: "gemini-3.6-flash",
    contextBudgetChars: 16000,
    contextBudgetTokens: 12000,
    continuityReviewEnabled: true,
  },
  coverageChapter,
  coverageTask,
  { force: true }
);
assert.equal(coverageReview.status, "warn");
assert.ok(
  coverageReview.issues.some((issue) => issue.severity === "major" && /解决追兵/.test(issue.summary)),
  "taskCoverage.missing must be promoted to a major task issue"
);

console.log("test_continuity_review: OK", { reviewCalls, repairCalls });
