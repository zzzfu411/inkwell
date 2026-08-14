/**
 * RAG + Harness 冒烟
 * node tests/test_rag_harness.mjs
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
      contextBudgetChars: 16000,
      ragTopK: 8,
      ragMaxChars: 3200,
      prevChapterTailChars: 1800,
      memoryDepth: 12,
      chapterTargetWords: 2000,
    },
  },
  console,
  fetch: async () => {
    throw new Error("no network in unit test");
  },
};

for (const f of ["prompts.js", "craft.js", "context.js", "rag.js", "harness.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox);
}

const Rag = sandbox.window.NOVEL_RAG;
const Ctx = sandbox.window.NOVEL_CONTEXT;
assert.ok(Rag && Ctx);
sandbox.window.NOVEL_PIPELINE = { log: () => {} };

const project = {
  title: "RAG测",
  pitch: "越骂越强",
  locks: { logline: "谤药", forbidden: [] },
  detailCanon: {
    facts: [
      {
        key: "王大锤.粉丝数",
        value: "50万",
        entity: "王大锤",
        category: "number",
        firstChapter: "第1章",
        locked: true,
        status: "active",
      },
    ],
    conflicts: [],
  },
  storyline: {
    positionSummary: "卷1·绑定后",
    lastSummary: "封店绑定",
    nextDirection: "死刑论加压",
    chapterLogs: [{ order: 1, chapter: "第1章", summary: "封店", position: "开篇", nextDirection: "加压" }],
  },
  storyState: {
    protagonistState: "被押",
    openLoops: ["王大爷安危"],
    establishedFacts: ["黑芒绑定"],
    powerOrSystem: "Lv.0",
  },
  memoryRoll: [
    {
      chapter: "第1章",
      order: 1,
      happened: ["封店", "玉牌碎裂"],
      must_carry: ["王大爷危重"],
      summary: "封店绑定",
      open_loops: ["王大爷安危"],
    },
  ],
  graph: {
    nodes: [{ id: "n1", label: "林玄", role: "protagonist" }, { id: "n2", label: "王大锤", role: "support" }],
    edges: [],
  },
  world: { era: "沧海", power_system: "谤药", rules: ["公开否定"] },
  chapters: [
    {
      id: "c1",
      order: 1,
      title: "第1章",
      taskId: "t001",
      body: "王大锤举着自拍杆，粉丝数五十万的直播间里骂声一片。林玄被苏清月带走。玉牌碎裂，黑芒入体。王大爷仍在抢救。",
    },
  ],
  tasks: [
    { id: "t001", order: 1, status: "done", chapter_title: "第1章", goal: "封店" },
    {
      id: "t002",
      order: 2,
      status: "pending",
      chapter_title: "第2章 死刑论",
      goal: "叶天恒定调与王大爷好转",
      conflict: "舆论死刑",
      beats: ["审讯", "叶天恒", "王大爷"],
      must_include: ["承接绑定", "粉丝数一致"],
      hook_end: "去医院",
    },
  ],
  appearanceLog: [],
};

const index = Rag.ensureIndex(project, true);
assert.ok(index.N > 5, "index should have docs");

// A same-length text edit must invalidate the content signature.
const originalSig = index._sig;
const originalBody = project.chapters[0].body;
project.chapters[0].body = `${originalBody.slice(0, -1)}X`;
const changedIndex = Rag.ensureIndex(project);
assert.notEqual(changedIndex._sig, originalSig, "same-length edits must rebuild the RAG index");
project.chapters[0].body = originalBody;

// A compact sidecar must hydrate into a searchable runtime index.
const compact = Rag.serializeIndex(changedIndex);
assert.equal(compact.inverted, undefined);
const hydrated = Rag.deserializeIndex(compact);
assert.equal(hydrated._sig, compact._sig);
assert.ok(hydrated.inverted && hydrated.N === compact.docs.length);

const pack = Rag.retrieveForChapter(project, project.tasks[1], { topK: 6 });
assert.ok(pack.hits.length > 0, "should hit");
assert.ok(pack.promptBlock.includes("RAG") || pack.promptBlock.includes("检索"), "prompt block");
// 粉丝数应能被检索到
const hitText = pack.hits.map((h) => h.text).join(" ");
assert.ok(hitText.includes("50万") || hitText.includes("粉丝"), "should retrieve fan count");

const densePool = Rag.buildDenseCandidatePool(index, [], project.tasks[1], 24);
assert.ok(densePool.some((h) => h.meta?.type === "canon"), "dense pool includes authoritative canon without lexical prehit");
assert.ok(densePool.some((h) => h.meta?.type === "chapter_body"), "dense pool includes nearby chapter windows");
const diversified = Rag.selectDiverseHits(
  [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `body${i}`, text: "b", score: 100 - i, meta: { type: "chapter_body" } })),
    { id: "canon-x", text: "c", score: 80, meta: { type: "canon" } },
  ],
  5
);
assert.ok(diversified.some((h) => h.id === "canon-x"), "final Top-K cannot be monopolized by body chunks");

const writePack = Ctx.packForWrite(project, project.tasks[1], { ragPack: pack, autoRag: false });
assert.ok(writePack.user.includes("50万") || writePack.meta.used.includes("rag") || writePack.user.includes("RAG"), "write pack has rag/canon");
assert.ok(writePack.user.includes("故事线") || writePack.meta.used.includes("storyline"));

// harness present
assert.ok(sandbox.window.NOVEL_HARNESS?.rebuildIndex);
assert.equal(sandbox.window.NOVEL_HARNESS.hasPriorWrittenStory(project, project.tasks[1]), true);
const strictProject = {
  ...project,
  storyline: {},
  storyState: {},
  plotLoops: [],
  continuityMeta: { loopSchema: 1 },
  ragIndex: null,
};
await assert.rejects(
  sandbox.window.NOVEL_HARNESS.prepareAndRetrieve(
    strictProject,
    { ragEnabled: true, ragUseEmbeddings: false, ragFailurePolicy: "strict", ragTopK: 8, ragMaxChars: 3200 },
    { id: "t999", order: 2, chapter_title: "ZXQVV", goal: "UNSEENXYZ", beats: [], must_include: [] },
    {}
  ),
  /零命中/,
  "strict mode blocks context-free writing when historical chapters exist"
);

console.log("test_rag_harness: OK", { docs: index.N, hits: pack.hits.length, mode: "bm25" });
