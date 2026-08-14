/**
 * 关系图面板取数：子图收缩、章节名排序、关系表与关系演化的两种返回形状。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "graph-panel.js"), "utf8"), sandbox);
const G = sandbox.window.NOVEL_GRAPH_PANEL;

assert.ok(G, "NOVEL_GRAPH_PANEL must load");

const seq = (list) => (list || []).join(" | ");

// 节点 id 归一：对象取 id，字符串直接用，空值归一为空串
assert.equal(G.nodeId({ id: " a " }), "a");
assert.equal(G.nodeId("b"), "b");
assert.equal(G.nodeId(null), "");
assert.equal(G.nodeId(undefined), "");

const graph = {
  nodes: [
    { id: "lin", label: "林清", type: "character" },
    { id: "xie", label: "谢宴", role: "对手" },
    { id: "shen", label: "沈无咎" },
    { id: "lone", label: "孤立人物" },
  ],
  edges: [
    { source: "lin", target: "xie", relationship: "师兄妹", chapter: "第二章", occurrence: 3 },
    { source: "xie", target: "shen", relationship: "宿敌", chapter: "第一章" },
    { source: "lin", target: "shen", relationship: "同盟", note: "口头约定" },
  ],
};

// 没选人时原图返回，选人后只留直接相连的边和两端节点
assert.equal(G.subgraphForNode(graph, "").edges.length, 3);
assert.equal(G.subgraphForNode(graph, null), graph, "空选中直接返回原图");
const scoped = G.subgraphForNode(graph, "lin");
assert.equal(scoped.edges.length, 2, "只留与林清相连的边");
assert.equal(seq(scoped.nodes.map((n) => n.id)), "lin | xie | shen", "两端节点都要在，孤立人物被排除");
assert.equal(G.subgraphForNode(graph, "lone").edges.length, 0);
assert.equal(G.subgraphForNode(graph, { id: "lin" }).edges.length, 2, "选中项可以是节点对象");

// 章节名按书里的真实顺序排，而不是模型返回的次序
const project = {
  chapters: [
    { title: "雪落长门", order: 2 },
    { title: "断霜初鸣", order: 1 },
  ],
};
assert.equal(
  seq(G.chapterList(project, { edges: [{ chapter: "雪落长门" }, { chapter: "断霜初鸣" }] })),
  "断霜初鸣 | 雪落长门",
  "按章节 order 排，不按模型给的次序"
);
assert.equal(
  seq(G.chapterList(project, { edges: [{ chapter: "第 3 章" }, { chapter: "断霜初鸣" }] })),
  "断霜初鸣 | 第 3 章",
  "标题匹配不上时退回「第 N 章」数字"
);
assert.equal(
  seq(G.chapterList({ chapters: [] }, { edges: [{ chapter: "无名甲" }, { chapter: "无名乙" }] })),
  "无名甲 | 无名乙",
  "全都匹配不上时保持出现次序"
);
assert.equal(G.chapterList(project, { edges: [{ chapter: "  " }, {}] }).length, 0, "空章节名不入列");
assert.equal(G.chapterList(project, { edges: [{ chapter: "雪落长门" }, { chapter: "雪落长门" }] }).length, 1);
assert.equal(G.chapterList(undefined, undefined).length, 0);

// 关系表：id 换成显示名，出现次数保留，证据字段按 chapter → note → evidence 兜底
const rows = G.buildEdgeRows(graph, graph);
assert.equal(rows.length, 3);
assert.equal(rows[0].source, "林清");
assert.equal(rows[0].target, "谢宴");
assert.equal(rows[0].occurrence, 3);
assert.equal(rows[0].evidence, "第二章");
assert.equal(rows[2].evidence, "口头约定", "没有 chapter 时用 note 当证据");
assert.equal(rows[1].occurrence, 1, "缺 occurrence 记作 1");
assert.equal(
  G.buildEdgeRows({ edges: [{ source: "ghost", target: "lin" }] }, graph)[0].source,
  "ghost",
  "找不到节点时退回 id，不显示 undefined"
);
assert.equal(
  G.buildEdgeRows({ edges: Array.from({ length: 250 }, () => ({ source: "lin", target: "xie" })) }, graph).length,
  G.EDGE_LIMIT,
  "关系表有渲染上限"
);

// 人物按钮：角色名优先，其次类型标签，选中态只有一个
const buttons = G.buildNodeButtons(graph, "lin", (t) => (t === "character" ? "人物" : t));
assert.equal(seq(buttons.map((b) => b.text)), "林清 · 人物 | 谢宴 · 对手 | 沈无咎 | 孤立人物");
assert.equal(buttons.filter((b) => b.active).length, 1);
assert.equal(buttons[0].active, true);
assert.equal(G.buildNodeButtons(graph, null, (t) => t).filter((b) => b.active).length, 0);

// 关系演化：分组形状
const grouped = G.buildTracks(
  {
    groups: [
      {
        source: "lin",
        target: "xie",
        pairLabel: "林清 × 谢宴",
        entries: [{ chapter: "第二章", relationship: "师兄妹" }, { chapter: "第五章", label: "决裂" }],
      },
      { source: "xie", target: "shen", pair: "谢宴 × 沈无咎", entries: [] },
    ],
  },
  "lin"
);
assert.equal(grouped.kind, "grouped");
assert.equal(grouped.groups.length, 1, "选中林清后只留他参与的组");
assert.equal(grouped.groups[0].title, "林清 × 谢宴");
assert.equal(seq(grouped.groups[0].events.map((e) => e.label)), "师兄妹 | 决裂", "label 缺失时退回 relationship");
assert.equal(G.buildTracks({ groups: [] }, "").kind, "empty");

// 关系演化：平铺形状与空态
const flat = G.buildTracks(
  [
    { source: { id: "lin", label: "林清" }, target: { id: "xie", label: "谢宴" }, relationship: "师兄妹", chapter: "第二章" },
    { source: "shen", target: "xie", label: "宿敌" },
  ],
  "lin"
);
assert.equal(flat.kind, "flat");
assert.equal(flat.groups.length, 1);
assert.equal(flat.groups[0].source, "林清");
assert.equal(flat.groups[0].label, "师兄妹");
const emptyScoped = G.buildTracks([{ source: "a", target: "b" }], "lin");
assert.equal(emptyScoped.kind, "empty");
assert.equal(emptyScoped.scoped, true, "选了人却没证据，提示要区分");
assert.equal(G.buildTracks([], "").kind, "empty");
assert.equal(G.buildTracks([], "").scoped, false);
assert.equal(G.buildTracks(null, ""), null, "模块没加载要能区分于空数据");

// 统计行：优先用 graphStats 的字段，缺字段时按图现算
assert.equal(
  G.statsLine({ characters: 4, relationships: 3, chapters: 2 }, graph, ["a", "b"], null),
  "人物 4 · 关系 3 · 章节 2"
);
assert.equal(
  G.statsLine({ nodes: 4, edges: 3 }, graph, ["a"], { label: "林清" }),
  "人物 4 · 关系 3 · 章节 1 · 已选 林清",
  "旧字段名 nodes/edges 也认"
);
assert.equal(G.statsLine({}, graph, [], null), "人物 4 · 关系 3 · 章节 0");

console.log("test_graph_panel: OK");
