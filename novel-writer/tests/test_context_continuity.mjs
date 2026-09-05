/**
 * 连贯性上下文装配冒烟：上章衔接 / open_loops / storyState / 进度块。
 * node tests/test_context_continuity.mjs
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const sandbox = {
  window: {
    NOVEL_DEFAULTS: {
      contextBudgetChars: 14000,
      bodyTailChars: 2800,
      prevChapterTailChars: 1800,
      memoryDepth: 12,
      chapterTargetWords: 2000,
    },
  },
  console,
};

// load prompts then context
for (const file of ["runtime-observability.js", "prompts.js", "craft.js", "memory-reducers.js", "context-budget.js", "context-evidence.js", "context.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: path.join(root, file) });
}

const Ctx = sandbox.window.NOVEL_CONTEXT;
const Prompts = sandbox.window.NOVEL_PROMPTS;
assert.ok(Ctx, "NOVEL_CONTEXT loaded");

const project = {
  pitch: "越骂越强的野医",
  tone: "爽文",
  targetChapters: 40,
  cast_summary: "林玄与苏清月对峙",
  locks: { logline: "谤药系统越骂越强", forbidden: ["无脑作死"] },
  world: { era: "沧海市", power_system: "谤药", rules: ["公开否定才涨受谤"] },
  graph: {
    nodes: [
      { id: "n_lin", label: "林玄", role: "protagonist" },
      { id: "n_su", label: "苏清月", role: "heroine" },
    ],
    edges: [{ source: "n_lin", target: "n_su", relationship: "对峙" }],
  },
  spine: {
    logline: "谤药逆袭",
    volumes: [{ id: "v1", title: "全城巫医", focus: "下城舆论" }],
    foreshadow: [{ id: "fs1", seed: "玉牌身世", payoff_around: "90" }],
  },
  tasks: [
    {
      id: "t001",
      order: 1,
      status: "done",
      chapter_title: "第1章 封条",
      goal: "封店绑定",
      hook_end: "黑芒入体",
    },
    {
      id: "t002",
      order: 2,
      status: "pending",
      chapter_title: "第2章 死刑论",
      goal: "权威定调与第一次进化",
      conflict: "舆论死刑",
      beats: ["审讯", "叶天恒定调", "王大爷好转"],
      must_include: ["承接黑芒"],
      must_not: ["重演砸仪器当第一次"],
      hook_end: "去医院",
      word_target: 2500,
    },
  ],
  chapters: [
    {
      id: "c1",
      taskId: "t001",
      order: 1,
      title: "第1章 封条",
      body:
        "……玉牌碎裂。\n黑芒钻入林玄体内。\n【谤药通路：宿主绑定完成】\n王大爷仍在抢救。\n车窗外封条猎猎。".repeat(20),
    },
  ],
  memoryRoll: [
    {
      chapter: "第1章 封条",
      taskId: "t001",
      happened: ["封店被骂", "玉牌碎裂黑芒入体", "绑定完成", "王大爷仍危重"],
      new_info: ["谤药需公开否定", "一个月前半激活"],
      must_carry: ["黑芒=绑定非封神", "王大爷未好转", "地点沧海下城"],
      open_loops: ["王大爷能否好转", "玉牌来历"],
      state: "被押往特勤，刚完成绑定",
      power_or_system: "Lv.0 三钱黑苦散",
      location: "特勤车内",
      timeline: "封店当日",
      ending_hook_status: "绑定完成，危重未解",
    },
  ],
  storyState: null,
  activeChapterId: null,
};

// rebuild story state
const st = Ctx.rebuildStoryStateFromMemory(project);
assert.ok(st.openLoops.some((x) => x.includes("王大爷")));
assert.ok(st.establishedFacts.some((x) => x.includes("绑定") || x.includes("危重")));

const task2 = project.tasks[1];
const packed = Ctx.packForWrite(project, task2, {});
assert.ok(packed.user.includes("上章"), "must include prev chapter block");
assert.ok(packed.user.includes("黑芒") || packed.user.includes("绑定"), "prev body or facts");
assert.ok(packed.user.includes("故事进度") || packed.user.includes("当前任务"), "progress");
assert.ok(packed.user.includes("未收回钩子") || packed.user.includes("王大爷"), "open loops");
assert.ok(packed.user.includes("死刑论") || packed.user.includes("t002") || packed.user.includes("本章任务"), "task");
assert.ok(packed.user.includes("连贯性纪律") || packed.user.includes("不得"), "discipline");
assert.ok(packed.meta.prevChapterId === "c1", "prev chapter id linked");
assert.ok(packed.meta.chars <= packed.meta.budget, "within budget");
assert.equal(project.runtimeDiagnostics.at(-1).type, "context", "context assembly emits a safe timing metric");
assert.equal(project.runtimeDiagnostics.at(-1).chapterId, "", "empty target chapter has no fabricated identity");

project.chapters[0].beatPlan = {
  scenes: [
    { place: "冷牢", action: "对质" },
    { place: "秘道", action: "撤离" },
  ],
};
const packedDebt = Ctx.packForWrite(project, task2, {});
assert.ok(packedDebt.user.includes("上章未落地场面") || packedDebt.user.includes("秘道"), "uncovered beats flow to next chapter");

// 写第2章时不应把「当前空章」当衔接源而丢掉上章
assert.ok(!packed.user.includes("【本章尚空】") || packed.user.includes("上章"), "empty ch2 still has prev");

// mergeStoryState after fake ch2 digest
Ctx.mergeStoryState(project, {
  chapter: "第2章 死刑论",
  happened: ["叶天恒死刑论", "Lv.1进化", "王大爷吐淤回升"],
  must_carry: ["洗髓拔毒汤Lv.1", "王大爷第一次好转"],
  open_loops: ["院方如何定性", "叶天恒下一步"],
  state: "解环去市一院",
  power_or_system: "Lv.1 洗髓拔毒汤",
});
assert.equal(project.storyState.powerOrSystem, "Lv.1 洗髓拔毒汤");
assert.ok(project.storyState.establishedFacts.some((x) => x.includes("Lv.1") || x.includes("好转")));

console.log("test_context_continuity: OK", {
  chars: packed.meta.chars,
  used: packed.meta.used.join("+"),
});


// --- canon lock + storyline ---
const p2 = {
  title: "测",
  detailCanon: { facts: [], conflicts: [] },
  storyline: {},
  appearanceLog: [],
  tasks: [
    { id: "t001", order: 1, chapter_title: "第1章", goal: "g1", status: "done" },
    { id: "t002", order: 2, chapter_title: "第2章", goal: "权威定调", status: "pending" },
  ],
  spine: { volumes: [{ id: "v1", title: "卷1", chapters: 40, focus: "下城" }] },
  memoryRoll: [],
  chapters: [],
};
Ctx.mergeCanonFacts(p2, [
  { key: "王大锤.粉丝数", value: "50万", entity: "王大锤", category: "number", evidence: "粉丝数50万" },
], { chapter: "第1章", taskId: "t001" });
assert.equal(p2.detailCanon.facts[0].value, "50万");
const r = Ctx.mergeCanonFacts(p2, [
  { key: "王大锤.粉丝数", value: "100万", entity: "王大锤", category: "number" },
], { chapter: "第2章", taskId: "t002" });
assert.equal(r.conflicts, 1, "must reject fan count change");
assert.equal(p2.detailCanon.facts[0].value, "50万", "locked value kept");

// Canon 值比较必须识别数值与单位，不能再用 substring 把真实变化当成相同。
assert.equal(Ctx.compareCanonValues("5级", "15级").equal, false, "5级 != 15级");
assert.equal(Ctx.compareCanonValues("50万", "150万").equal, false, "50万 != 150万");
assert.equal(Ctx.compareCanonValues("Lv.5", "Lv.15").equal, false, "Lv.5 != Lv.15");
assert.equal(Ctx.compareCanonValues("50万", "50万人").equal, true, "optional counter suffix is equivalent");
assert.equal(Ctx.compareCanonValues("500,000人", "50万人").equal, true, "magnitude normalization");
assert.equal(Ctx.compareCanonValues("五级", "十五级").equal, false, "Chinese numerals differ");
assert.equal(Ctx.compareCanonValues("林玄", "林玄真人").equal, false, "names are not substring-equal");

const p3 = { detailCanon: { facts: [], conflicts: [] } };
Ctx.mergeCanonFacts(p3, [{ key: "林玄.等级", value: "5级", category: "number" }], {
  chapter: "第1章",
});
const numericConflict = Ctx.mergeCanonFacts(
  p3,
  [{ key: "林玄.等级", value: "15级", category: "number" }],
  { chapter: "第2章" }
);
assert.equal(numericConflict.conflicts, 1, "numeric progression on a locked key must be explicit");
assert.equal(p3.detailCanon.conflicts[0].reason, "numeric_mismatch");

const canonSelectionProject = {
  detailCanon: {
    facts: [
      ...Array.from({ length: 50 }, (_, i) => ({
        key: `路人${i}.粉丝数`,
        value: `${i + 1}万`,
        entity: `路人${i}`,
        category: "number",
        locked: true,
      })),
      { key: "苏清月.当前位置", value: "市一院", entity: "苏清月", category: "location", locked: true },
    ],
    conflicts: [],
  },
  plotLoops: [],
  continuityIssues: [],
  continuityMeta: { loopSchema: 1, issueSchema: 1 },
};
const selectedCanon = Ctx.selectCanonFacts(canonSelectionProject, {
  id: "t051",
  goal: "苏清月从市一院转场",
  pov: "苏清月",
  beats: ["离开医院"],
}, 36);
assert.ok(selectedCanon.facts.some((f) => f.key === "苏清月.当前位置"), "task-relevant canon survives global limit");

const dynamicCanon = { detailCanon: { facts: [], conflicts: [] } };
Ctx.mergeCanonFacts(dynamicCanon, [{ key: "王大锤.实时粉丝数", value: "50万", dynamic: true }]);
const dynamicUpdate = Ctx.mergeCanonFacts(dynamicCanon, [
  { key: "王大锤.实时粉丝数", value: "150万", dynamic: true },
]);
assert.equal(dynamicUpdate.conflicts, 0, "explicit dynamic facts may evolve");
assert.equal(dynamicCanon.detailCanon.facts[0].value, "150万");
assert.equal(dynamicCanon.detailCanon.facts[0].history[0].value, "50万");

Ctx.updateStorylineTrack(p2, p2.tasks[0], {
  summary: "封店绑定",
  storyline_position: "卷1开篇·绑定",
  next_direction: "权威死刑论加压",
  happened: ["封店"],
}, { title: "第1章", order: 1, taskId: "t001" });
assert.ok(p2.storyline.positionSummary.includes("绑定") || p2.storyline.positionSummary.includes("卷"));
assert.ok(p2.storyline.nextDirection.includes("死刑") || p2.storyline.nextTaskId === "t002");

const pack2 = Ctx.packForWrite(p2, p2.tasks[1], {});
assert.ok(pack2.user.includes("细节设定") || pack2.user.includes("粉丝数"), "canon in prompt");
assert.ok(pack2.user.includes("故事线"), "storyline in prompt");
assert.ok(pack2.user.includes("50万"), "locked 50wan present");
console.log("canon+storyline: OK");

// --- plot loop lifecycle / legacy migration ---
const pLoops = {
  memoryRoll: [
    {
      chapter: "第1章",
      taskId: "t001",
      open_loops: ["玉牌来历"],
    },
    {
      chapter: "第2章",
      taskId: "t002",
      advanced_loops: [{ summary: "玉牌来历", evidence: "发现鹤纹" }],
      open_loops: ["玉牌来历"],
    },
    {
      chapter: "第3章",
      taskId: "t003",
      resolved_loops: [{ summary: "玉牌来历", evidence: "确认是母亲遗物" }],
      open_loops: [],
    },
  ],
};
Ctx.rebuildPlotLoopsFromMemory(pLoops);
assert.equal(pLoops.plotLoops.length, 1, "legacy strings migrate to stable loop records");
assert.equal(pLoops.plotLoops[0].status, "resolved", "resolved loop must be closed");
assert.equal(Ctx.getActivePlotLoops(pLoops).length, 0, "resolved loop must not return to write context");

Ctx.mergePlotLoops(
  pLoops,
  {
    chapter: "第4章",
    taskId: "t004",
    opened_loops: [{ summary: "玉牌来历", evidence: "遗物出现第二层封印" }],
  },
  { chapter: "第4章", taskId: "t004", order: 4 }
);
assert.equal(pLoops.plotLoops[0].status, "open", "explicit event may reopen a resolved loop");
assert.equal(pLoops.plotLoops[0].reopenCount, 1);

const persistentLoopProject = { memoryRoll: [], plotLoops: [], continuityMeta: { loopSchema: 1 } };
Ctx.mergePlotLoops(
  persistentLoopProject,
  { opened_loops: [{ summary: "失踪的账册" }] },
  { chapter: "第1章", taskId: "t001", order: 1 }
);
for (let i = 2; i <= 50; i++) persistentLoopProject.memoryRoll.push({ chapter: `第${i}章` });
persistentLoopProject.memoryRoll = persistentLoopProject.memoryRoll.slice(-40);
assert.equal(Ctx.getActivePlotLoops(persistentLoopProject)[0].summary, "失踪的账册", "open loop survives memory window");

const importedStructuredProject = {
  memoryRoll: [],
  plotLoops: [{ id: "external-loop", summary: "外部导入伏笔", status: "open" }],
  continuityIssues: [{ id: "external-issue", summary: "外部导入风险", status: "open" }],
  entityStates: { 林玄: { entity: "林玄", location: "旧站" } },
  continuityMeta: {},
};
assert.equal(
  Ctx.getActivePlotLoops(importedStructuredProject)[0].id,
  "external-loop",
  "structured plot loops without schema metadata must not be rebuilt away"
);
Ctx.rebuildStoryStateFromMemory(importedStructuredProject);
assert.equal(
  importedStructuredProject.plotLoops[0].id,
  "external-loop",
  "rebuilding story state must preserve existing structured plot loops"
);
assert.equal(
  Ctx.getActiveContinuityIssues(importedStructuredProject)[0].id,
  "external-issue",
  "structured continuity issues without schema metadata must not be rebuilt away"
);
assert.equal(
  Ctx.buildEntityStateBlock(importedStructuredProject).includes("旧站"),
  true,
  "structured entity states without schema metadata must remain available"
);
console.log("plot-loop lifecycle: OK");

// 长章交接必须同时保留正文开头、关键中段和章末，尤其不能丢掉最终状态/钩子。
const longChapter = `HEAD_EVENT\n${"甲".repeat(5000)}\nMIDDLE_TURN\n${"乙".repeat(5000)}\nTAIL_STATE_AND_HOOK`;
const sampled = Prompts.sampleNarrativeText(longChapter, 7000);
assert.ok(sampled.includes("HEAD_EVENT"), "digest sample keeps head");
assert.ok(sampled.includes("MIDDLE_TURN"), "digest sample keeps middle");
assert.ok(sampled.includes("TAIL_STATE_AND_HOOK"), "digest sample keeps ending");
assert.ok(sampled.length <= 7200, "sample stays close to requested budget including labels");
console.log("long-chapter sampling: OK");

// 连续性警告必须进入下一章，并可被明确处理后停止注入。
const pWarnings = {
  memoryRoll: [
    {
      chapter: "第1章",
      taskId: "t001",
      continuity_warnings: [
        { type: "location", severity: "major", summary: "苏清月仍在医院，不能突然出现在城南" },
      ],
    },
  ],
  tasks: [{ id: "t002", order: 2, chapter_title: "第2章", goal: "城南追踪", beats: [], must_include: [] }],
  chapters: [],
  locks: {},
  detailCanon: { facts: [], conflicts: [] },
  storyline: {},
  storyState: {},
};
Ctx.rebuildContinuityIssuesFromMemory(pWarnings);
assert.equal(Ctx.getActiveContinuityIssues(pWarnings).length, 1);
const warningPack = Ctx.packForWrite(pWarnings, pWarnings.tasks[0], {});
assert.ok(warningPack.user.includes("苏清月仍在医院"), "unhandled warning returns to next write context");
const issueId = pWarnings.continuityIssues[0].id;
Ctx.mergeContinuityIssues(
  pWarnings,
  { handled_warnings: [{ issue_id: issueId, resolution: "补写转场" }] },
  { chapter: "第2章", taskId: "t002", order: 2 }
);
assert.equal(Ctx.getActiveContinuityIssues(pWarnings).length, 0, "handled warning stops injection");
console.log("continuity-warning lifecycle: OK");

// 双预算装配：即使前置块很大，也必须为上章、故事状态和当前正文保留最低空间。
const budgetProject = {
  locks: { logline: "超长主线".repeat(500), forbidden: ["禁区".repeat(200)] },
  spine: { logline: "主线", volumes: [] },
  tasks: [
    { id: "t1", order: 1, status: "done", chapter_title: "第一章", goal: "开篇" },
    {
      id: "t2",
      order: 2,
      status: "pending",
      chapter_title: "第二章",
      goal: "承接第一章并推进".repeat(100),
      conflict: "冲突".repeat(100),
      beats: ["节拍".repeat(100)],
      must_include: ["硬要求".repeat(100)],
      must_not: [],
    },
  ],
  chapters: [
    { id: "bc1", taskId: "t1", order: 1, title: "第一章", body: `上章开头${"甲".repeat(5000)}上章结尾` },
    { id: "bc2", taskId: "t2", order: 2, title: "第二章", body: `本章开头${"乙".repeat(5000)}本章续写点` },
  ],
  activeChapterId: "bc2",
  memoryRoll: [],
  plotLoops: [],
  continuityIssues: [],
  continuityMeta: { loopSchema: 1, issueSchema: 1 },
  storyState: { protagonistState: "负伤", establishedFacts: ["硬事实".repeat(100)], openLoops: [] },
  storyline: { positionSummary: "卷一中段".repeat(100), nextDirection: "继续推进".repeat(100), chapterLogs: [] },
  detailCanon: {
    facts: Array.from({ length: 80 }, (_, i) => ({
      key: `人物${i}.属性`,
      value: `设定${i}`.repeat(20),
      entity: `人物${i}`,
      category: "number",
      locked: true,
    })),
    conflicts: [],
  },
  graph: { nodes: [], edges: [] },
};
const budgetPack = Ctx.packForWrite(budgetProject, budgetProject.tasks[1], {
  budget: 6000,
  tokenBudget: 4500,
  instruction: "作者指令".repeat(500),
  ragPack: { promptBlock: `【RAG检索】${"历史证据".repeat(1000)}`, hits: [] },
  autoRag: false,
});
for (const core of ["lock", "task", "instr", "storyline", "canon", "story", "prev", "body", "rag"]) {
  assert.ok(budgetPack.meta.used.includes(core), `core block ${core} keeps a reserved fragment`);
}
assert.ok(budgetPack.meta.chars <= 6000);
assert.ok(budgetPack.meta.tokens <= 4500);
assert.ok(budgetPack.meta.truncated.length > 0, "manifest records truncation");
assert.ok(Array.isArray(budgetPack.meta.blocks));
assert.ok(Array.isArray(budgetPack.meta.canon.selected));
const manifest = Ctx.recordContextManifest(budgetProject, budgetProject.tasks[1], budgetProject.chapters[1], budgetPack);
assert.equal(budgetProject.contextManifests.length, 1);
assert.equal(manifest.tokens, budgetPack.meta.tokens);
console.log("dual-budget packing: OK", { chars: budgetPack.meta.chars, tokens: budgetPack.meta.tokens });

// 多人物状态与时间线是动态事实，不再只靠单一 protagonistState。
const stateProject = {
  memoryRoll: [],
  entityStates: {},
  timelineEvents: [],
  continuityMeta: { loopSchema: 1, issueSchema: 1, entitySchema: 1 },
};
Ctx.mergeEntityStates(
  stateProject,
  {
    entity_states: [
      { entity: "苏清月", type: "character", location: "市一院", condition: "左臂受伤", possessions: ["玉牌"] },
    ],
    timeline_events: [{ time: "封店当日晚", event: "苏清月进入市一院", location: "市一院", entities: ["苏清月"] }],
  },
  { chapter: "第一章", taskId: "t1", order: 1 }
);
Ctx.mergeEntityStates(
  stateProject,
  {
    entity_states: [{ entity: "苏清月", location: "市一院地下层", condition: "伤口包扎完成" }],
    timeline_events: [{ time: "一小时后", event: "苏清月转入地下层", location: "市一院地下层", entities: ["苏清月"] }],
  },
  { chapter: "第二章", taskId: "t2", order: 2 }
);
assert.equal(stateProject.entityStates["苏清月"].location, "市一院地下层");
assert.equal(stateProject.entityStates["苏清月"].history.length, 1, "dynamic state keeps prior snapshot");
assert.equal(stateProject.timelineEvents.length, 2);
assert.match(Ctx.buildEntityStateBlock(stateProject, { goal: "苏清月离开地下层", pov: "苏清月" }), /市一院地下层/);

const styleProject = {
  styleBible: {
    pov: "第三人称限知",
    tense: "过去时",
    pacing: "短段落、对白推进",
    rules: ["避免全知视角切换"],
    forbiddenPhrases: ["命运的齿轮"],
    examples: ["雨线斜切过门楣，苏清月没有回头。"],
  },
  graph: { nodes: [{ label: "苏清月", voice: "冷静克制，少用感叹句", arc: "学会信任" }], edges: [] },
};
assert.match(Ctx.buildStyleVoiceBlock(styleProject, { goal: "苏清月查案", pov: "苏清月" }), /冷静克制/);
console.log("entity-state + style-bible: OK");

const evidence = Ctx.buildProductionEvidencePack(
  {
    ...stateProject,
    locks: { logline: "锁定主线", forbidden: ["空转"] },
    detailCanon: { facts: [{ key: "苏清月.伤势", value: "左臂受伤", locked: true, evidence: "包扎" }] },
    storyline: { positionSummary: "卷一中段", nextDirection: "追查地下层" },
    chapters: [{ id: "prev", order: 1, title: "第一章", body: "门在身后合上，警报声没有停。" }],
  },
  { id: "t2", order: 2, chapter_title: "第二章", goal: "追查地下层", conflict: "入口被封", hook_end: "门后有人敲门", pov: "苏清月" },
  { id: "c2", order: 2, title: "第二章", body: "" },
  {
    contract: { taskId: "t2", title: "第二章", objective: "找到入口", conflict: "入口被封", pov: "苏清月", hookEnd: "门后有人敲门", scenes: [] },
    instruction: "强化人物主动选择",
    currentDraftText: "当前章已经写到门缝前。",
    budget: 5000,
    tokenBudget: 4000,
  }
);
assert.match(evidence.user, /【canon\|locked】/);
assert.match(evidence.user, /【previous\|continuity】/);
assert.match(evidence.user, /【author\|author】/);
assert.match(evidence.user, /【current-draft\|working】/);
assert.ok(evidence.meta.used.includes("canon"));
assert.ok(evidence.meta.authority.reference.includes("retrieval"));
console.log("production evidence pack: OK");
