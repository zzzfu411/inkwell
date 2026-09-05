import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-drafting-service.js"), "utf8"), sandbox, {
  filename: path.join(root, "chapter-drafting-service.js"),
});
const Drafting = sandbox.window.NOVEL_CHAPTER_DRAFTING;

const contract = {
  id: "contract-1",
  title: "暗门",
  pov: "林玄",
  objective: "带证据离开",
  hookEnd: "暗门后有人敲门",
  wordTarget: 400,
  scenes: [
    { id: "s1", location: "诊室", goal: "拿到账册", obstacle: "门卫", action: "撬锁", turn: "被发现", outcome: "带账册逃入楼梯" },
    { id: "s2", location: "楼梯", goal: "摆脱追兵", obstacle: "电梯停摆", action: "撞开暗门", turn: "门后传来敲击", outcome: "被迫留在暗门内" },
  ],
};

const prompt = Drafting.buildPrompt({ evidence: "locked canon", contract, instruction: "对白克制" });
assert.match(prompt, /整章执行契约/);
assert.match(prompt, /诊室/);
assert.match(prompt, /场面边界只体现在自然转场/);
assert.match(prompt, /对白克制/);
assert.doesNotMatch(prompt, /apiKey/);

const validBody = `「账册给我。」林玄把铜针推进锁孔。${"门卫的脚步逼近，他没有回头，只把选择变成动作。".repeat(14)}暗门后响起三下敲击。`;
const calls = [];
let clock = 100;
const service = Drafting.create({
  now: () => ++clock,
  async chat(options) {
    calls.push(options);
    options.onDelta(validBody.slice(0, 80), validBody.slice(0, 80));
    return { content: validBody };
  },
});
const chapter = { id: "ch1", taskId: "t1", body: "" };
const production = { contract, scenes: [], stage: "chapter-drafting" };
let checkpoints = 0;
await service.draftChapter({
  project: {},
  cfg: { model: "candidate", chapterTargetWords: 400, productionMinLengthRatio: 0.55 },
  task: { id: "t1" },
  chapter,
  production,
  evidence: "locked canon",
  systemPrompt: "write coherent chapter",
  hooks: { onCheckpoint: () => (checkpoints += 1) },
});
assert.equal(calls.length, 1, "coherent mode must draft the whole chapter in one model call");
assert.equal(chapter.body, validBody);
assert.equal(production.draftMode, "chapter");
assert.equal(production.baseBody, validBody);
assert.equal(production.scenes.length, 2);
assert.ok(production.scenes.every((scene) => scene.status === "complete" && scene.text === ""));
assert.match(production.draftManifest.promptHash, /^prompt_/);
assert.match(production.draftManifest.bodyHash, /^body_/);
assert.equal(checkpoints, 1);

const failedChapter = { id: "ch2", body: "作者原稿" };
const failedProduction = { contract, scenes: [], stage: "chapter-drafting" };
const failing = Drafting.create({ chat: async () => ({ content: "太短" }) });
const rollbackDeltas = [];
await assert.rejects(
  () =>
    failing.draftChapter({
      cfg: {},
      task: { id: "t2" },
      chapter: failedChapter,
      production: failedProduction,
      hooks: { onDelta: (_delta, full) => rollbackDeltas.push(full) },
    }),
  (error) => error.code === "CHAPTER_DRAFT_INVALID"
);
assert.equal(failedChapter.body, "作者原稿", "invalid draft must roll back atomically");
assert.equal(failedProduction.stage, "draft-failed");
assert.equal(rollbackDeltas.at(-1), "作者原稿", "stream preview must also roll back to the authoritative body");

assert.equal(Drafting.validateDraft("场面一：这是元标签".repeat(30), contract, {}).ok, false);
console.log("test_chapter_drafting_service: OK");
