/**
 * GOAL-ULTIMATE Phase1：叙事核心库冒烟测试。
 * 覆盖：章节检测、图谱合并、occurrence 过滤、人物 degree。
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadScript(name, sandbox) {
  const code = fs.readFileSync(path.join(root, name), "utf8");
  vm.runInNewContext(code, sandbox);
}

const sandbox = {
  window: {},
  console,
};
loadScript("chapter-split.js", sandbox);
loadScript("narrative-model.js", sandbox);

const Split = sandbox.window.NOVEL_CHAPTER_SPLIT;
const Narrative = sandbox.window.NOVEL_NARRATIVE;

// ---------- chapter-split ----------

test("detectChapterRanges：识别「第一章」「第二章」", () => {
  const text =
    "第一章 山边小村\n韩立是村里的小孩子。\n第二章 青牛镇\n韩立跟三叔到了青牛镇。";
  const ranges = Split.detectChapterRanges(text);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].chapter.startsWith("第一章"));
  assert.ok(ranges[1].chapter.startsWith("第二章"));
  assert.equal(ranges[0].start, 0);
  assert.ok(ranges[1].start > ranges[0].start);
});

test("detectChapterRanges：序章/楔子/番外", () => {
  const text = "楔子 开场\n内容\n第一章 正文\n更多\n番外 彩蛋\n尾";
  const ranges = Split.detectChapterRanges(text);
  assert.ok(ranges.length >= 3);
  assert.ok(ranges[0].chapter.startsWith("楔子"));
  assert.ok(ranges.some((r) => r.chapter.startsWith("第一章")));
  assert.ok(ranges.some((r) => r.chapter.startsWith("番外")));
});

test("splitIntoChunks：优先不跨章", () => {
  const text =
    "第一章 AAA\n" +
    "甲".repeat(100) +
    "\n第二章 BBB\n" +
    "乙".repeat(100);
  const chunks = Split.splitIntoChunks(text, { chunkSize: 80, overlap: 10 });
  assert.ok(chunks.length >= 2);
  // 任一 chunk 不应同时跨两章标题起点（end 落在另一章 start 之后且 start 在本章）
  const ranges = Split.detectChapterRanges(text);
  assert.equal(ranges.length, 2);
  for (const c of chunks) {
    // 每个 chunk 的 chapter 字段应与其 start 所在章一致
    const expected =
      c.start >= ranges[1].start ? ranges[1].chapter : ranges[0].chapter;
    assert.equal(c.chapter, expected);
    // 不跨章：end 不超过下一章 start（末章除外）
    if (c.chapter === ranges[0].chapter) {
      assert.ok(c.end <= ranges[1].start);
    }
  }
});

test("buildChapterList：无标记时虚拟段", () => {
  const text = "没有章节标记的一段长文" + "字".repeat(50);
  const list = Split.buildChapterList(text, { chunkSize: 30 });
  assert.ok(list.length >= 2);
  assert.ok(list[0].chapter.startsWith("段"));
});

// ---------- narrative-model ----------

test("mergeGraphs：节点 aliases 合并 + 边 occurrence 累加", () => {
  const base = {
    nodes: [{ id: "n_a", label: "韩立", aliases: ["小韩"], type: "character" }],
    edges: [
      {
        source: "n_a",
        target: "n_b",
        relationship: "师徒",
        chapter: "第一章",
        occurrence: 1,
      },
    ],
  };
  // base 里缺 n_b，delta 补上
  base.nodes.push({ id: "n_b", label: "墨大夫", aliases: [] });

  const delta = {
    nodes: [
      { id: "n_a", label: "韩立", aliases: ["韩老哥"], sect: "七玄门" },
      { id: "n_c", label: "张铁", aliases: [] },
    ],
    edges: [
      {
        source: "n_a",
        target: "n_b",
        relationship: "师徒",
        chapter: "第一章",
        occurrence: 1,
      },
      {
        source: "n_a",
        target: "n_c",
        relationship: "朋友",
        chapter: "第二章",
        occurrence: 1,
      },
    ],
  };

  const g = Narrative.mergeGraphs(base, delta);
  const han = g.nodes.find((n) => n.id === "n_a");
  assert.ok(han);
  assert.ok(han.aliases.includes("韩老哥") || han.aliases.includes("小韩"));
  assert.equal(han.sect, "七玄门");

  const master = g.edges.find(
    (e) =>
      e.source === "n_a" &&
      e.target === "n_b" &&
      e.relationship === "师徒" &&
      e.chapter === "第一章"
  );
  assert.ok(master);
  assert.equal(master.occurrence, 2);

  assert.equal(g.edges.length, 2);
  assert.ok(g.nodes.find((n) => n.id === "n_c"));
});

test("mergeGraphs：无向关系排序合并", () => {
  const base = {
    nodes: [
      { id: "n1", label: "甲" },
      { id: "n2", label: "乙" },
    ],
    edges: [
      { source: "n1", target: "n2", relationship: "朋友", chapter: "一", occurrence: 1 },
    ],
  };
  const delta = {
    nodes: [],
    edges: [
      // 反向同关系同章 → 应合并
      { source: "n2", target: "n1", relationship: "朋友", chapter: "一", occurrence: 2 },
    ],
  };
  const g = Narrative.mergeGraphs(base, delta);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].occurrence, 3);
});

test("filterGraph：按 minOccurrence 过滤", () => {
  const graph = {
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    edges: [
      { source: "a", target: "b", relationship: "友", occurrence: 1 },
      { source: "a", target: "c", relationship: "敌", occurrence: 3 },
    ],
  };
  const filtered = Narrative.filterGraph(graph, { minOccurrence: 2 });
  assert.equal(filtered.edges.length, 1);
  assert.equal(filtered.edges[0].relationship, "敌");
  assert.ok(filtered.nodes.find((n) => n.id === "a"));
  assert.ok(filtered.nodes.find((n) => n.id === "c"));
  assert.ok(!filtered.nodes.find((n) => n.id === "b"));
});

test("buildCharacterProfile：degree 正确", () => {
  const nodes = [
    { id: "aq", label: "阿强" },
    { id: "xm", label: "小美" },
    { id: "df", label: "大反" },
  ];
  const edges = [
    { source: "aq", target: "xm", relationship: "情侣", chapter: "第一章", occurrence: 2 },
    { source: "df", target: "aq", relationship: "敌对", chapter: "第二章", occurrence: 1 },
  ];
  const profile = Narrative.buildCharacterProfile(nodes, edges, "aq");
  assert.ok(profile);
  assert.equal(profile.degree, 2);
  assert.equal(profile.neighbors.length, 2);
  assert.equal(profile.label, "阿强");
});

test("graphStats / toMermaid 基本可用", () => {
  const g = {
    nodes: [
      { id: "n1", label: "甲", type: "character" },
      { id: "n2", label: "乙", type: "character" },
    ],
    edges: [
      { source: "n1", target: "n2", relationship: "朋友", occurrence: 2, chapter: "第一章" },
    ],
  };
  const stats = Narrative.graphStats(g);
  assert.equal(stats.characters, 2);
  assert.equal(stats.relationships, 1);
  assert.equal(stats.multiOccurrenceEdges, 1);

  const mermaid = Narrative.toMermaid(g);
  assert.ok(mermaid.includes("graph LR"));
  assert.ok(mermaid.includes("甲"));
  assert.ok(mermaid.includes("朋友"));
});

test("buildRelationshipTracks：按人物对可分组", () => {
  const nodes = [
    { id: "a", label: "甲" },
    { id: "b", label: "乙" },
  ];
  const edges = [
    { source: "a", target: "b", relationship: "友", chapter: "一", occurrence: 1 },
    { source: "a", target: "b", relationship: "敌", chapter: "二", occurrence: 1 },
  ];
  const tracks = Narrative.buildRelationshipTracks(nodes, edges);
  assert.equal(tracks.length, 2);
  assert.ok(Array.isArray(tracks.groups));
  assert.equal(tracks.groups.length, 1);
  assert.equal(tracks.groups[0].entries.length, 2);
});

// ---------- analysis-runner（mock API） ----------

test("runAnalysis：切块 + mock 抽取 + 合并", async () => {
  const sb = {
    window: {
      NOVEL_CHAPTER_SPLIT: Split,
      NOVEL_NARRATIVE: Narrative,
      NOVEL_PROMPTS: {
        commonGuard: "",
        analyzeChunk: {
          system: "sys",
          user: (chunk) => chunk.text,
        },
      },
      NOVEL_API: {
        chatJson: async ({ messages }) => {
          const user = messages.find((m) => m.role === "user")?.content || "";
          // 简单：每块吐一个固定边
          return {
            nodes: [
              { id: "n_h", label: "韩立", chapter: "第一章" },
              { id: "n_m", label: "墨大夫", chapter: "第一章" },
            ],
            edges: [
              {
                source: "n_h",
                target: "n_m",
                relationship: "师徒",
                chapter: "第一章",
                occurrence: 1,
              },
            ],
            _echo: user.slice(0, 20),
          };
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  };
  // analysis-runner 用到 Promise / setTimeout（pause 轮询）
  loadScript("analysis-runner.js", sb);
  const Analysis = sb.window.NOVEL_ANALYSIS;

  const text =
    "第一章 开端\n" +
    "韩立拜入墨大夫门下。".repeat(5) +
    "\n第二章 转折\n" +
    "韩立离开七玄门。".repeat(5);

  const progress = [];
  const { graph, meta, chunks } = await Analysis.runAnalysis({
    fullText: text,
    cfg: { chunkSize: 200, overlap: 20, baseUrl: "", apiKey: "", model: "x" },
    onProgress: (p) => progress.push(p),
  });

  assert.ok(chunks.length >= 1);
  assert.equal(meta.status, "done");
  assert.ok(meta.last_completed >= 0);
  assert.ok(graph.nodes.length >= 2);
  // 多块合并同一边 → occurrence >= 1
  const edge = graph.edges.find((e) => e.relationship === "师徒");
  assert.ok(edge);
  assert.ok(edge.occurrence >= 1);
  assert.ok(progress.length >= 1);
});

console.log("test_narrative: all registered");

test("A4 extractionFileId / normalizeExtraction chunk_id", () => {
  const sb = {
    window: {
      NOVEL_CHAPTER_SPLIT: Split,
      NOVEL_NARRATIVE: Narrative,
      NOVEL_PROMPTS: { commonGuard: "" },
      NOVEL_API: { chatJson: async () => ({ nodes: [], edges: [] }) },
    },
    console,
    setTimeout,
    clearTimeout,
  };
  loadScript("analysis-runner.js", sb);
  const A = sb.window.NOVEL_ANALYSIS;
  assert.equal(A.extractionFileId({ index: 3, chunk: { id: "c03" }, extraction: { chunk_id: "c03" } }, 3), "c03");
  assert.equal(A.extractionFileId({ index: 7, extraction: { nodes: [] } }, 7), "0007");
  const n = A.normalizeExtraction({ nodes: [{ id: "a", label: "A" }], edges: [] }, { id: "0002", chapter: "第二章" }, 2);
  assert.equal(n.chunk_id, "0002");
  assert.equal(n.nodes[0].chapter, "第二章");
});

test("A3 context.mergeGraph delegates chapter-aware", () => {
  const sb = {
    window: {
      NOVEL_NARRATIVE: Narrative,
      NOVEL_PROMPTS: {
        truncate: (t) => t,
        summarizeNodes: () => "",
        summarizeEdges: () => "",
      },
    },
    console,
  };
  loadScript("context.js", sb);
  const C = sb.window.NOVEL_CONTEXT;
  const base = {
    nodes: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }],
    edges: [{ source: "a", target: "b", relationship: "师徒", chapter: "第一章", occurrence: 1 }],
  };
  const delta = {
    nodes: [],
    edges: [{ source: "a", target: "b", relationship: "师徒", chapter: "第二章", occurrence: 1 }],
  };
  const g = C.mergeGraph(base, delta);
  assert.equal(g.edges.length, 2, "different chapters must not collapse");
});

function analysisSandbox(chatJson) {
  const sb = {
    window: {
      NOVEL_CHAPTER_SPLIT: Split,
      NOVEL_NARRATIVE: Narrative,
      NOVEL_PROMPTS: {
        commonGuard: "",
        analyzeChunk: { system: "sys", user: (chunk) => chunk.text },
      },
      NOVEL_API: { chatJson },
    },
    console,
    setTimeout,
    clearTimeout,
  };
  loadScript("analysis-runner.js", sb);
  return sb.window.NOVEL_ANALYSIS;
}

test("analysis checkpoint commits extraction before graph/meta", async () => {
  const events = [];
  const A = analysisSandbox(async () => ({
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ source: "a", target: "b", relationship: "knows" }],
  }));
  const result = await A.runAnalysis({
    fullText: "checkpoint source",
    cfg: { chunkSize: 500, overlap: 20, model: "test" },
    chunks: [{ id: "c0", chapter: "One", text: "body" }],
    graph: { nodes: [], edges: [] },
    hooks: {
      initializeCheckpoint: async () => events.push("initialize"),
      writeExtraction: async ({ index }) => events.push(`extraction:${index}`),
      writeCheckpoint: async ({ index, phase }) =>
        events.push(phase === "final" ? "checkpoint:final" : `checkpoint:${index}`),
    },
  });
  assert.equal(result.meta.status, "done");
  assert.equal(JSON.stringify(result.meta.completed_chunks), "[0]");
  assert.ok(events.indexOf("extraction:0") < events.indexOf("checkpoint:0"));
  assert.ok(events.indexOf("checkpoint:0") < events.indexOf("checkpoint:final"));
});

test("analysis resume skips committed chunks without duplicating graph occurrence", async () => {
  let apiCalls = 0;
  const A = analysisSandbox(async () => {
    apiCalls += 1;
    return {
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ source: "a", target: "b", relationship: "knows", chapter: "Two" }],
    };
  });
  const cfg = { chunkSize: 500, overlap: 20, model: "test" };
  const fullText = "resume source";
  const graph = {
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ source: "a", target: "b", relationship: "knows", chapter: "One", occurrence: 1 }],
  };
  const result = await A.resumeAnalysis({
    fullText,
    cfg,
    chunks: [
      { id: "c0", chapter: "One", text: "first" },
      { id: "c1", chapter: "Two", text: "second" },
    ],
    graph,
    meta: {
      schema_version: 2,
      source_sig: A.sourceSignature(fullText, cfg),
      total_chunks: 2,
      completed_chunks: [0],
      failed_chunks: [],
      last_completed: 0,
    },
  });
  assert.equal(apiCalls, 1);
  assert.equal(result.meta.status, "done");
  assert.equal(
    result.graph.edges.reduce((sum, edge) => sum + (edge.occurrence || 1), 0),
    2
  );
});

test("analysis resume rejects a changed source", async () => {
  let apiCalls = 0;
  const A = analysisSandbox(async () => {
    apiCalls += 1;
    return { nodes: [], edges: [] };
  });
  await assert.rejects(
    A.resumeAnalysis({
      fullText: "new source",
      cfg: { chunkSize: 500, overlap: 20 },
      chunks: [{ id: "c0", text: "new source" }],
      meta: { source_sig: "analysis-v2:stale:500:20", completed_chunks: [] },
    }),
    (error) => error.code === "CHECKPOINT_SOURCE_MISMATCH"
  );
  assert.equal(apiCalls, 0);
});

test("analysis persistence failure is never reported as completion", async () => {
  const A = analysisSandbox(async () => ({ nodes: [], edges: [] }));
  await assert.rejects(
    A.runAnalysis({
      fullText: "persistence source",
      cfg: { chunkSize: 500, overlap: 20 },
      chunks: [{ id: "c0", text: "body" }],
      hooks: {
        writeCheckpoint: async ({ phase }) => {
          if (phase !== "final") throw new Error("disk full");
        },
      },
    }),
    (error) =>
      error.code === "CHECKPOINT_WRITE_FAILED" &&
      error.result?.meta?.status === "persistence_error"
  );
});
