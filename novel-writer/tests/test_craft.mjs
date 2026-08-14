import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "craft.js"), "utf8"), sandbox);
const Craft = sandbox.window.NOVEL_CRAFT;

assert.equal(Craft.detectOpeningKind("夜色沉沉，大雾漫过栈道。"), "weather");
assert.equal(Craft.detectOpeningKind("「你还要装到什么时候？」林清问。"), "dialogue");
assert.equal(Craft.detectOpeningKind("她睁开眼，胸口还残留着冷汗。"), "waking");
assert.equal(Craft.detectOpeningKind("他沿着湿滑石阶走下去。"), "walking");
assert.equal(Craft.detectOpeningKind("谢宴嘴角一动，眼神微冷。"), "expression");

const plan = Craft.normalizeBeatPlan({
  scenes: [
    { place: "冷牢", action: "对质", turn: "被撞破" },
    { location: "栈道", what: "撤离" },
  ],
  payoffs: ["共命契余波"],
  avoid: ["重演血池大战"],
});
assert.equal(plan.scenes.length, 2);
assert.match(Craft.buildBeatBlock(plan), /冷牢/);
assert.match(Craft.buildBeatBlock(plan), /本章避免/);

const prev = "夜色沉沉，大雾漫过赤云谷的栈道，药奴们低着头往前挪。";
const same = "夜色沉沉，大雾再次漫过赤云谷，药奴们继续往前走。";
const lint = Craft.lintProse({
  body: `${same}\n他嘴角勾起一抹冷笑。\n空气仿佛凝固。`,
  prevBody: prev,
  recentKinds: ["weather"],
  styleBible: { forbiddenPhrases: [] },
});
assert.ok(lint.some((issue) => issue.type === "repetition"));
assert.ok(lint.some((issue) => String(issue.summary).includes("嘴角勾起一抹")));

const project = {
  detailCanon: {
    facts: [{ key: "谢宴.修为", value: "开府", locked: true, status: "active" }],
  },
};
const gated = Craft.validateDigest(
  project,
  {
    canon_facts: [
      { key: "谢宴.修为", value: "化神", evidence: "化神" },
      { key: "林清.假名", value: "阿清", evidence: "阿清" },
      { key: "空", value: "" },
    ],
    abandoned_loops: [{ summary: "旧钩子作废" }],
  },
  "她在名册上写下阿清两个字，有人妄称谢宴已是化神。",
  {
    compareCanonValues: (a, b) => ({ equal: String(a) === String(b) }),
  }
);
assert.equal(gated.canon_facts.length, 1);
assert.equal(gated.canon_facts[0].key, "林清.假名");
assert.ok(gated.dropped.some((item) => item.reason === "locked_conflict"));
assert.ok(gated.dropped.some((item) => item.reason === "empty"));
assert.equal(gated.abandoned_loops.length, 1);

const noEvidence = Craft.validateDigest(
  { detailCanon: { facts: [] } },
  {
    canon_facts: [
      { key: "谢宴.佩剑", value: "霜刃" },
      { key: "林清.伤", value: "左臂", evidence: "" },
      { key: "林清.在场", value: "冷牢", evidence: "正文里没有这句" },
    ],
  },
  "她在名册上写下阿清两个字。",
  { compareCanonValues: (a, b) => ({ equal: String(a) === String(b) }) }
);
assert.equal(noEvidence.canon_facts.length, 0, "缺证据事实不得入库");
assert.ok(noEvidence.dropped.length >= 3);
assert.ok(noEvidence.dropped.every((item) => item.reason === "no_evidence"));

const kinds = Craft.recentOpeningKinds(
  {
    chapters: [
      { id: "c1", order: 1, taskId: "t1", body: "夜色沉沉。" },
      { id: "c2", order: 2, taskId: "t2", body: "「站住。」" },
    ],
  },
  { id: "t3", order: 3 }
);
assert.deepEqual(Array.from(kinds), ["weather", "dialogue"]);

assert.equal(Craft.classifyChapterPace({ chapter_title: "第12章 血色大典", goal: "摊牌" }, {}), "climax");
assert.equal(Craft.classifyChapterPace({ chapter_title: "过渡", goal: "休整一夜" }, {}), "idle");
const paced = { order: 10, goal: "推进同盟" };
const profile = Craft.applyPaceToTask(paced, {
  spine: { volumes: [{ id: "v1", chapters: 12 }] },
});
assert.equal(profile.id, "build");
assert.equal(paced.paceKind, "build");
assert.equal(paced.word_target, 2000);

const covered = Craft.scoreBeatCoverage(
  "冷牢潮气贴上腕骨。林清把名册甩上石桌对质，对方眼神一滞。",
  { scenes: [{ place: "冷牢", action: "对质" }, { place: "石桌", action: "名册" }] }
);
assert.equal(covered.covered, 2);
assert.equal(covered.missing.length, 0);
const uncovered = Craft.scoreBeatCoverage("她只觉得心中涌起一阵悲凉。", {
  scenes: [{ place: "秘道", action: "撤离" }],
});
assert.equal(uncovered.covered, 0);
assert.match(Craft.buildUncoveredBeatHint(uncovered), /秘道/);
const nameOnly = Craft.scoreBeatCoverage("林清坐在廊下喝茶。", {
  scenes: [{ place: "冷牢", action: "林清在冷牢对质" }],
});
assert.ok(nameOnly.missing.length > 0, "长动作句+主角名不得把未写场面标成落地");
assert.ok(nameOnly.rate < 1);
const emptyScenes = Craft.scoreBeatCoverage("随便写点正文。", { scenes: [] });
assert.equal(emptyScenes.rate, 0);
assert.equal(emptyScenes.total, 0);
assert.ok(Craft.dialogueRate("「站住。」她说。风很硬。") > 0);
const tell = Craft.lintHumanProse("她心中涌起一阵悲凉，却什么也没说。");
assert.ok(tell.some((issue) => String(issue.summary).includes("心中涌起")));
const scored = Craft.scoreChapterCraft(
  "「你还要装？」林清问。冷牢潮气贴上她的腕，她抬眼对质。",
  { scenes: [{ place: "冷牢", action: "对质" }] }
);
assert.ok(scored.beatCoverage.rate > 0);
assert.ok(scored.dialogueRate > 0);

console.log("test_craft: OK");
