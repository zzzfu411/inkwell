import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const lifecycle = [];
const sandbox = {
  window: {
    NOVEL_DEFAULTS: {
      chapterTargetWords: 600,
      productionMinQualityScore: 7,
      productionMinSceneCoverage: 0.75,
      productionMinLengthRatio: 0.55,
      productionMaxRevisionPasses: 1,
    },
    NOVEL_PROMPTS: {
      commonGuard: "guard",
      chapterContract: { system: "contract", user: (x) => x },
      sceneWriter: { system: () => "scene", user: (x) => x },
      chapterWriter: { system: () => "whole-chapter", user: (x) => x },
      chapterQualityReview: { system: "critic", user: (x) => x },
      chapterRevision: { system: () => "revision", user: (x) => x },
      sampleNarrativeText: (x) => String(x || ""),
    },
    NOVEL_CONTEXT: {
      findPrevWrittenChapter: () => null,
      buildProductionEvidencePack: (_p, task, chapter, opts = {}) => ({
        user: `task=${task.id}; chapter=${chapter.id}; ${opts.instruction || ""}`,
        meta: { chars: 32, tokens: 12, budget: 1000, tokenBudget: 800, used: ["contract"], omitted: [], truncated: [], authority: {} },
      }),
      recordContextManifest: (project) => {
        project.contextManifests = Array.isArray(project.contextManifests) ? project.contextManifests : [];
        project.contextManifests.push({ stage: "mock" });
      },
      mergeContinuityIssues: () => {},
      clipToDualBudget: (x, n) => String(x || "").slice(0, n),
    },
    NOVEL_CRAFT: {
      scoreChapterCraft: () => ({
        beatCoverage: { rate: 1, covered: 2, total: 2, missing: [] },
        dialogueRate: 0.2,
        sensoryCount: 2,
        issues: [],
      }),
      recentOpeningKinds: () => [],
    },
    NOVEL_PIPELINE: {
      ensureChapterForTask(project, task) {
        let chapter = project.chapters.find((item) => item.taskId === task.id);
        if (!chapter) {
          chapter = { id: "ch1", taskId: task.id, title: task.chapter_title, order: task.order, body: "" };
          project.chapters.push(chapter);
        }
        project.activeChapterId = chapter.id;
        return chapter;
      },
      applyCraftSignals: () => {},
      async reviewAndRepairChapter() {
        lifecycle.push("continuity");
        return { status: "pass", issues: [] };
      },
      async handoffChapter(_project, _cfg, chapter, task, hooks) {
        assert.equal(hooks.qualityValidated, true);
        sandbox.window.NOVEL_CHAPTER_STATE.completeHandoff(chapter, task);
      },
      log: () => {},
    },
    NOVEL_HARNESS: null,
  },
  console,
};

vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-state.js"), "utf8"), sandbox, {
  filename: path.join(root, "chapter-state.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-drafting-service.js"), "utf8"), sandbox, {
  filename: path.join(root, "chapter-drafting-service.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "production-quality.js"), "utf8"), sandbox, {
  filename: path.join(root, "production-quality.js"),
});
vm.runInNewContext(fs.readFileSync(path.join(root, "production-engine.js"), "utf8"), sandbox, {
  filename: path.join(root, "production-engine.js"),
});
const Engine = sandbox.window.NOVEL_PRODUCTION_ENGINE;

const contract = Engine.normalizeContract(
  {
    title: "契约章",
    pov: "林玄",
    objective: "拿到证据",
    scenes: [
      { id: "a", location: "诊室", goal: "寻找证据", obstacle: "门卫", action: "撬锁", turn: "被发现", outcome: "暴露" },
      { id: "b", location: "楼梯", goal: "带证据离开", obstacle: "追兵", action: "突围", turn: "电梯停摆", outcome: "跳入暗门" },
    ],
    hook_end: "暗门后有人敲门",
  },
  {},
  { id: "t1", order: 1, chapter_title: "契约章", goal: "拿到证据", conflict: "门卫", hook_end: "暗门后有人敲门" },
  { id: "ch1", title: "契约章", body: "" },
  { chapterTargetWords: 1000 }
);
assert.equal(contract.scenes.length, 2);
assert.equal(contract.scenes[0].location, "诊室");
assert.equal(Engine.contractToBeatPlan(contract).scenes[1].turn, "电梯停摆");
const ungroundedWholeDraft = Engine.sceneContractCoverage(
  "人物只是站着想了很久，没有执行契约中的任何行动。",
  contract,
  contract.scenes.map((scene) => ({ ...scene, status: "complete", text: "", ledger: { wholeDraft: true } }))
);
assert.equal(
  ungroundedWholeDraft.rate,
  0,
  "whole-chapter completion metadata must not self-certify that every scene is grounded"
);
assert.equal(Engine.qualityGate({ verdict: "revise", overall: 5, issues: [] }, { productionQualityPolicy: "strict" }).accepted, false);
assert.equal(Engine.qualityGate({ verdict: "pass", overall: 8, local: { beatCoverage: { rate: 1 }, lengthRatio: 1 }, issues: [] }, { productionQualityPolicy: "strict" }).accepted, true);
assert.equal(
  Engine.qualityGate(
    { verdict: "pass", overall: 8, missingScores: ["hook"], local: { beatCoverage: { rate: 1 }, lengthRatio: 1, hookPresent: true }, issues: [] },
    { productionQualityPolicy: "strict" }
  ).accepted,
  false,
  "strict gate must reject an incomplete semantic critic report"
);

const chapterPlanFallback = Engine.normalizeContract(
  null,
  {},
  { id: "fallback-task", order: 2, chapter_title: "回退章", goal: "继续追查", beatPlan: { scenes: [] } },
  {
    id: "fallback-chapter",
    title: "回退章",
    body: "",
    beatPlan: {
      scenes: [
        { place: "旧仓库", action: "寻找线索", turn: "灯光熄灭" },
        { place: "后巷", action: "带线索撤离", turn: "退路被封" },
      ],
    },
  },
  { chapterTargetWords: 600 }
);
assert.equal(chapterPlanFallback.scenes.length, 2, "任务细纲为空时应继续读取章节级细纲");

const lockedPlanChapter = {
  id: "locked-ch",
  title: "锁定细纲",
  body: "",
  beatPlanLocked: true,
  beatPlan: {
    chapter_title: "锁定细纲",
    scenes: [
      { place: "门厅", action: "取证", turn: "被发现" },
      { place: "暗巷", action: "撤离", turn: "失去退路" },
    ],
  },
};
const lockedPlanTask = { id: "locked-task", order: 1, chapter_title: "锁定细纲", goal: "取证" };
const lockedSig = Engine.contractSourceSignature({}, lockedPlanTask, lockedPlanChapter);
lockedPlanChapter.beatPlan.scenes[0].action = "毁证";
assert.notEqual(
  lockedSig,
  Engine.contractSourceSignature({}, lockedPlanTask, lockedPlanChapter),
  "author-locked beat edits must invalidate the production contract"
);

let jsonCalls = 0;
let textCalls = 0;
sandbox.window.NOVEL_API = {
  async chatJson(opts) {
    jsonCalls += 1;
    if (String(opts.messages?.[0]?.content).includes("contract")) {
      return {
        title: "第一章",
        pov: "林玄",
        objective: "拿到证据",
        conflict: "门卫",
        scenes: [
          { id: "s1", location: "诊室", goal: "寻找证据", obstacle: "门卫", action: "撬锁", turn: "被发现", outcome: "暴露", word_target: 500 },
          { id: "s2", location: "楼梯", goal: "带证据离开", obstacle: "追兵", action: "突围", turn: "电梯停摆", outcome: "跳入暗门", word_target: 500 },
        ],
        hook_end: "暗门后有人敲门",
      };
    }
    lifecycle.push("quality");
    // 第一次批评故意拒绝，第二次在整章修订后通过。
    if (jsonCalls === 2) {
      return { verdict: "revise", overall: 4, scores: { causalProgression: 4, characterAgency: 4, sceneCompletion: 4, povConsistency: 7, tension: 4, voice: 6, hook: 3, prose: 6 }, issues: [{ severity: "major", type: "causal", summary: "转折没有结果", evidence: "门卫挡住了路", fix: "补出人物选择和代价" }] };
    }
    return { verdict: "pass", overall: 8, scores: { causalProgression: 8, characterAgency: 8, sceneCompletion: 8, povConsistency: 8, tension: 8, voice: 8, hook: 8, prose: 8 }, issues: [] };
  },
  async chat(opts) {
    textCalls += 1;
    const isRevision = String(opts.messages?.[0]?.content).includes("revision");
    const content = isRevision
      ? ("林玄撬锁时被发现，门卫扑来，他咬住对方的手腕夺走证据，暴露后完成突围，踩着停摆的电梯门跳进暗门。门后传来三下敲击，回应来自黑暗。铁锈味贴在舌根，他没有回头，继续把证据攥在掌心。追兵的喊声在楼梯间回荡，他用肩膀顶住暗门，直到门锁咔的一声落下。暗门另一侧没有灯，只有潮湿的风贴过脸颊。他摸出火柴，借着短暂的亮光看见墙上三道新鲜抓痕，随后把证据藏进鞋底，沿着狭窄通道一步步向前。").repeat(2)
      : textCalls === 1
        ? "林玄撬开诊室的锁，门卫的脚步在走廊逼近；他把证据塞进袖口，转身撞开消防门。冷汗顺着手背滑进袖口，他听见钥匙碰撞，立刻关掉了灯。门缝里漏进一线白光，他屏住呼吸，把锁舌重新拨回原位。"
        : "追兵冲上楼梯，林玄扯断电缆让电梯停摆，翻过栏杆跳入暗门。黑暗里有人敲了三下。楼梯扶手震得发麻，他咬紧牙关，把证据贴在胸口，迎着暗门后的风继续往下走。身后的脚步撞在铁梯上，他知道退路已经封死，只能把门推到底。";
    opts.onDelta?.(content, content);
    return { content };
  },
};

const project = { chapters: [], tasks: [], locks: {}, storyline: {}, detailCanon: { facts: [] }, storyState: {}, plotLoops: [] };
const task = { id: "t1", order: 1, chapter_title: "第一章", goal: "拿到证据", conflict: "门卫", beats: ["撬锁", "突围"], must_include: [], must_not: [], hook_end: "暗门后有人敲门", pov: "林玄", status: "pending" };
project.tasks.push(task);
const chapter = await Engine.runChapter(
  project,
  {
    baseUrl: "http://model",
    apiKey: "k",
    model: "m",
    chapterTargetWords: 600,
    productionMaxRevisionPasses: 1,
    continuityReviewEnabled: true,
  },
  task,
  {}
);
assert.equal(task.status, "done");
assert.equal(chapter.handoffStatus, "done");
assert.equal(chapter.production.status, "done");
assert.equal(chapter.production.revisions, 1);
assert.equal(chapter.production.qualityReview.verdict, "pass");
assert.equal(chapter.production.scenes.filter((scene) => scene.status === "complete").length, 2);
assert.ok(chapter.production.contextManifests.length >= 1, "production keeps stage-level context manifests");
assert.ok(project.contextManifests.length >= 1, "project manifest receives production evidence metadata");
assert.ok(jsonCalls >= 3 && textCalls >= 3, "must execute plan + scenes + critic + bounded revision");
assert.ok(
  lifecycle.indexOf("continuity") >= 0 && lifecycle.indexOf("continuity") < lifecycle.indexOf("quality"),
  "continuity repair must finish before semantic quality review"
);

// 候选默认模式只发起一次正文调用，场面契约在整章内部执行而不是分次采样后拼接。
const sceneChat = sandbox.window.NOVEL_API.chat;
let coherentCalls = 0;
const coherentBody = "林玄把铜针推进诊室门锁，门卫脚步逼近时仍选择撬开暗格。被发现后，他夺走账册冲向楼梯，扯断电缆让电梯停摆；追兵封住出口，他撞进暗门。门后随即响起三下敲击，铁锈味贴上舌根，他把证据压进衣襟，承担暴露后的追捕。".repeat(4);
sandbox.window.NOVEL_API.chat = async (opts) => {
  coherentCalls += 1;
  assert.match(String(opts.messages?.[0]?.content), /whole-chapter/);
  opts.onDelta?.(coherentBody, coherentBody);
  return { content: coherentBody };
};
const coherentProject = { chapters: [], tasks: [], locks: {}, storyline: {}, detailCanon: { facts: [] }, storyState: {}, plotLoops: [] };
const coherentTask = {
  id: "coherent-task",
  order: 1,
  chapter_title: "整章",
  goal: "拿到证据",
  conflict: "门卫",
  beats: ["撬锁", "突围"],
  hook_end: "暗门后有人敲门",
  pov: "林玄",
  status: "pending",
};
coherentProject.tasks.push(coherentTask);
const coherentChapter = await Engine.runChapter(
  coherentProject,
  {
    baseUrl: "http://model",
    apiKey: "k",
    model: "m",
    productionMode: "chapter",
    chapterTargetWords: 600,
    productionMaxRevisionPasses: 0,
    continuityReviewEnabled: false,
  },
  coherentTask,
  {}
);
assert.equal(coherentCalls, 1, "coherent mode must use exactly one prose model call");
assert.equal(coherentChapter.production.draftMode, "chapter");
assert.equal(coherentChapter.production.draftManifest.mode, "chapter");
assert.ok(coherentChapter.production.scenes.every((scene) => scene.status === "complete" && scene.text === ""));
assert.equal(coherentChapter.body, coherentBody);
sandbox.window.NOVEL_API.chat = sceneChat;

// 人工改稿/质量阻断重试只能复检当前正文，不得把已存在正文再追加一遍场面。
const retryProject = {
  chapters: [
    {
      id: "retry-ch",
      taskId: "retry-task",
      title: "重试章",
      order: 1,
      body: "作者手改后的完整正文。",
      production: {
        schemaVersion: 1,
        contractSourceSig: "",
        status: "needs_revision",
        stage: "quality-blocked",
        baseBody: "",
        contract: {
          schemaVersion: 1,
          id: "retry-contract",
          title: "重试章",
          objective: "完成",
          scenes: [
            { id: "s1", goal: "动作一", action: "动作一", turn: "转折一", outcome: "结果一", wordTarget: 300, status: "complete", revised: true, text: "" },
            { id: "s2", goal: "动作二", action: "动作二", turn: "转折二", outcome: "结果二", wordTarget: 300, status: "complete", revised: true, text: "" },
          ],
          wordTarget: 600,
        },
        scenes: [
          { id: "s1", status: "complete", revised: true, text: "" },
          { id: "s2", status: "complete", revised: true, text: "" },
        ],
        revisions: 1,
        qualityReview: null,
        localMetrics: null,
        contextManifests: [],
      },
    },
  ],
  tasks: [],
  locks: {},
  storyline: {},
  detailCanon: { facts: [] },
  storyState: {},
  plotLoops: [],
};
const retryTask = { id: "retry-task", order: 1, chapter_title: "重试章", goal: "完成", status: "written" };
retryProject.tasks.push(retryTask);
const retryBody = "作者手改后的完整正文，动作一带来转折一并落到结果一；动作二推动转折二并形成结果二。".repeat(12);
retryProject.chapters[0].body = retryBody;
retryProject.chapters[0].production.contractSourceSig = Engine.contractSourceSignature(
  retryProject,
  retryTask,
  retryProject.chapters[0]
);
const beforeRetryTextCalls = textCalls;
const retryChapter = await Engine.runChapter(
  retryProject,
  { baseUrl: "http://model", apiKey: "k", model: "m", chapterTargetWords: 600, productionMaxRevisionPasses: 0 },
  retryTask,
  { handoff: true }
);
assert.equal(textCalls, beforeRetryTextCalls, "质量重试不应重新调用 scene writer");
assert.equal(retryTask.status, "done");
assert.equal(retryChapter.body, retryBody);

// 压缩后的 accepted_pending_handoff 运行记录仍以 chapter.body 为权威，重试不得重复追加场面。
const compactContract = {
  schemaVersion: 1,
  id: "compact-contract",
  title: "压缩章",
  objective: "完成目标",
  conflict: "追兵",
  hookEnd: "门后有声响",
  scenes: [
    { id: "s1", location: "大厅", goal: "取证", action: "取证", turn: "被发现", outcome: "暴露", wordTarget: 300, status: "complete", text: "场一原文" },
    { id: "s2", location: "暗巷", goal: "撤离", action: "撤离", turn: "退路被封", outcome: "进入暗门", wordTarget: 300, status: "complete", text: "场二原文" },
  ],
  wordTarget: 600,
};
const compactChapter = {
  id: "compact-chapter",
  taskId: "compact-task",
  title: "压缩章",
  order: 1,
  body: "大厅取证后被发现，人物带着证据撤入暗巷；退路被封，他推开暗门，听见门后有声响。".repeat(12),
  production: {
    schemaVersion: 1,
    contractSourceSig: "",
    status: "accepted_pending_handoff",
    stage: "accepted",
    baseBody: "",
    scenes: compactContract.scenes.map((scene) => ({ ...scene })),
    contract: compactContract,
    revisions: 0,
    revisionPasses: 0,
    qualityReview: null,
    localMetrics: null,
    contextManifests: [],
  },
};
const compactProject = {
  chapters: [compactChapter],
  tasks: [],
  locks: {},
  storyline: {},
  detailCanon: { facts: [] },
  storyState: {},
  plotLoops: [],
};
const compactTask = {
  id: "compact-task",
  order: 1,
  chapter_title: "压缩章",
  goal: "完成目标",
  conflict: "追兵",
  beats: ["取证", "撤离"],
  hook_end: "门后有声响",
  status: "written",
};
compactProject.tasks.push(compactTask);
Engine.markHandoffComplete(compactChapter);
compactChapter.production.status = "accepted_pending_handoff";
compactChapter.production.stage = "accepted";
compactChapter.handoffStatus = "stale";
compactChapter.production.contractSourceSig = Engine.contractSourceSignature(compactProject, compactTask, compactChapter);
const beforeCompactedRetryCalls = textCalls;
const compactRetry = await Engine.runChapter(
  compactProject,
  {
    baseUrl: "http://model",
    apiKey: "k",
    model: "m",
    chapterTargetWords: 600,
    productionMaxRevisionPasses: 0,
    manualAutoHandoff: false,
  },
  compactTask,
  {}
);
assert.equal(textCalls, beforeCompactedRetryCalls, "压缩状态重试不应重新调用 scene writer");
assert.equal(compactRetry.body, compactChapter.body);
assert.equal(compactRetry.production.status, "accepted_pending_handoff");

// 严格规划器没有可用模型结果且没有确定性场面时，必须停在失败态，不能静默拼接通用场面。
const originalChatJson = sandbox.window.NOVEL_API.chatJson;
sandbox.window.NOVEL_API.chatJson = async () => ({});
const strictPlanProject = { chapters: [], tasks: [], locks: {}, storyline: {}, detailCanon: { facts: [] }, storyState: {}, plotLoops: [] };
const strictPlanTask = { id: "strict-plan-task", order: 1, chapter_title: "无细纲章", goal: "探索", status: "pending" };
strictPlanProject.tasks.push(strictPlanTask);
await assert.rejects(
  () => Engine.runChapter(strictPlanProject, { baseUrl: "http://model", apiKey: "k", model: "m", productionPlanPolicy: "strict" }, strictPlanTask, {}),
  (error) => error.code === "PRODUCTION_PLAN_FAILED",
  "strict production must reject an unavailable/malformed planner result"
);
assert.equal(strictPlanTask.status, "pending");
sandbox.window.NOVEL_API.chatJson = originalChatJson;

console.log("test_production_engine: OK", Engine.summary(chapter));
