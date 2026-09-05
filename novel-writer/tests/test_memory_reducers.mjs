import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "memory-reducers.js"), "utf8"), sandbox, {
  filename: path.join(root, "memory-reducers.js"),
});
const factory = sandbox.window.NOVEL_MEMORY_REDUCERS;
assert.equal(typeof factory?.create, "function");

const reducers = factory.create({
  writtenChapters: (project) => (project.chapters || []).filter((chapter) => String(chapter.body || "").trim()),
});
assert.equal(reducers.stableLoopId("失踪的铜钥匙"), reducers.stableLoopId("失踪的铜钥匙"));

const project = {
  chapters: [{ id: "c1", body: "正文" }],
  memoryRoll: [],
};
reducers.mergePlotLoops(
  project,
  {
    chapter: "第一章",
    taskId: "t1",
    order: 1,
    opened_loops: [{ id: "key", summary: "失踪的铜钥匙", evidence: "钥匙不见了" }],
  }
);
assert.equal(project.plotLoops.length, 1);
assert.equal(project.plotLoops[0].status, "open");

reducers.mergePlotLoops(
  project,
  {
    chapter: "第二章",
    taskId: "t2",
    order: 2,
    resolved_loops: [{ id: "key", summary: "失踪的铜钥匙", evidence: "在码头找回" }],
  }
);
assert.equal(project.plotLoops[0].status, "resolved");
assert.equal(project.plotLoops[0].resolvedOrder, 2);

reducers.mergeContinuityIssues(
  project,
  {
    continuity_warnings: [
      {
        id: "level",
        type: "canon",
        severity: "blocker",
        summary: "林玄等级被写错",
        evidence: "十五级",
        expected: "五级",
      },
    ],
  },
  { chapter: "第二章", taskId: "t2", order: 2 }
);
assert.equal(reducers.getActiveContinuityIssues(project)[0].id, "level");
assert.match(reducers.buildContinuityWarningBlock(project), /林玄等级被写错/);
reducers.mergeContinuityIssues(project, {
  handled_warnings: [{ issue_id: "level", resolution: "恢复为五级" }],
});
assert.equal(reducers.getActiveContinuityIssues(project).length, 0);

reducers.mergeEntityStates(
  project,
  {
    entity_states: [
      {
        entity: "林玄",
        location: "旧港",
        condition: "受伤",
        possessions: ["铜钥匙"],
        evidence: "林玄靠在旧港仓库门外",
      },
    ],
    timeline_events: [
      {
        id: "arrival",
        time: "雨夜",
        event: "林玄抵达旧港",
        location: "旧港",
        entities: ["林玄"],
      },
    ],
  },
  { chapter: "第二章", taskId: "t2", order: 2 }
);
assert.equal(project.entityStates["林玄"].location, "旧港");
assert.equal(project.timelineEvents[0].id, "arrival");

const digest = {
  chapter: "第二章",
  taskId: "t2",
  order: 2,
  state: "林玄受伤",
  must_carry: ["铜钥匙已找回"],
  open_loops: ["仓库里的人是谁"],
  location: "旧港",
};
project.memoryRoll.push(digest);
const story = reducers.mergeStoryState(project, digest);
assert.equal(story.chapterCount, 1);
assert.equal(story.location, "旧港");
assert.ok(story.establishedFacts.includes("铜钥匙已找回"));
assert.ok(story.openLoops.includes("仓库里的人是谁"));

const rebuilt = reducers.rebuildStoryStateFromMemory(project);
assert.equal(rebuilt.lastChapter, "第二章");
assert.ok(rebuilt.establishedFacts.includes("铜钥匙已找回"));

console.log("test_memory_reducers: OK");
