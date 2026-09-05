import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "context-evidence.js"), "utf8"), sandbox, {
  filename: path.join(root, "context-evidence.js"),
});
const factory = sandbox.window.NOVEL_CONTEXT_EVIDENCE;
assert.equal(typeof factory?.create, "function");

const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || "").length / 2));
const clipToDualBudget = (text, maxChars, maxTokens) =>
  String(text || "").slice(0, Math.max(0, Math.min(maxChars, maxTokens * 2)));
const service = factory.create({
  getDefaults: () => ({ canonMaxFactsInPrompt: 2 }),
  buildEntityStateBlock: () => "林玄｜位置:旧港",
  buildTimelineBlock: () => "雨夜｜林玄抵达旧港",
  findPrevWrittenChapter: () => ({ id: "c1", title: "上一章", body: "上章事实与真实文末" }),
  getActivePlotLoops: () => [{ id: "loop-key", summary: "铜钥匙来源", target: "第三章揭晓" }],
  buildStyleVoiceBlock: () => "第三人称限知；短句克制",
  estimateTokens,
  clipToDualBudget,
});

const project = {
  detailCanon: {
    facts: [
      { key: "林玄.等级", entity: "林玄", value: "五级", category: "number", locked: true },
      { key: "苏晚.身份", entity: "苏晚", value: "记者", category: "name", locked: true },
      { key: "旧港.天气", entity: "旧港", value: "暴雨", category: "location", global: true },
    ],
  },
  storyState: {
    protagonistState: "负伤",
    location: "旧港",
    timeline: "雨夜",
    establishedFacts: ["林玄只有五级"],
    recentHook: "仓库门后有人",
  },
};
const task = {
  id: "t2",
  chapter_title: "旧港追踪",
  goal: "林玄与苏晚进入旧港仓库",
  conflict: "林玄负伤",
  pov: "林玄",
  must_include: ["铜钥匙"],
};

const selected = service.selectCanonFacts(project, task);
assert.equal(selected.facts.length, 2);
assert.equal(selected.facts[0].key, "旧港.天气", "全局锁定事实必须获得最高优先级");
assert.ok(selected.facts.some((fact) => fact.key === "林玄.等级"));
assert.equal(selected.omitted, 1);

const options = {
  contract: {
    taskId: "t2",
    title: "旧港追踪",
    objective: "进入仓库",
    mustInclude: ["铜钥匙"],
    mustAvoid: ["改写等级"],
  },
  budget: 3600,
  tokenBudget: 2400,
  ragPack: {
    hits: [{ text: "旧案资料称仓库曾有密道", meta: { type: "canon", chapter: "序章" } }],
  },
  instruction: "保持悬疑，不提前揭底",
};
const first = service.buildProductionEvidencePack(project, task, { id: "c2", title: "第二章" }, options);
const second = service.buildProductionEvidencePack(project, task, { id: "c2", title: "第二章" }, options);

assert.equal(first.user, second.user, "相同输入必须生成可复现的证据包");
assert.match(first.user, /【contract\|instruction】/);
assert.match(first.user, /【canon\|locked】/);
assert.ok(first.meta.used.includes("contract"));
assert.ok(first.meta.used.includes("canon"));
assert.deepEqual(Array.from(first.meta.authority.reference), ["retrieval"]);
assert.ok(first.meta.chars <= first.meta.budget);
assert.ok(first.meta.tokens <= first.meta.tokenBudget);

console.log("test_context_evidence: OK");
