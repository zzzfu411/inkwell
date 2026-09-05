/**
 * 故事记录视图模型：合并来源、筛选、排序、统计。
 * 排序规则是作者能直接感知的行为，改了必须先改这里。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "story-records.js"), "utf8"), sandbox, {
  filename: path.join(root, "story-records.js"),
});
const R = sandbox.window.NOVEL_STORY_RECORDS;

assert.ok(R, "NOVEL_STORY_RECORDS must load");

// sandbox 里造出来的数组跨 realm，比较内容而不是引用
const seq = (list) => (list || []).join(" | ");
const keys = (model, field = "key") => seq(model.visible.map((r) => r[field]));

// 空书不许抛，统计要能直接贴到界面上
const blank = R.buildCanonRecords({});
assert.equal(blank.total, 0);
assert.equal(blank.matched, 0);
assert.equal(blank.stats, "0 / 0 条");
assert.equal(blank.visible.length, 0);
assert.equal(R.buildLoopRecords(undefined).visible.length, 0);
assert.equal(R.buildContinuityRecords(null).visible.length, 0);

// 标签：类型表、状态表、未知值原样回显、空值走兜底
assert.equal(R.label("number"), "数值");
assert.equal(R.label("blocker"), "阻断");
assert.equal(R.label("自造类型"), "自造类型");
assert.equal(R.label("", "其他"), "其他");

const canonProject = {
  detailCanon: {
    facts: [
      { key: "年龄", value: "十七", category: "number", t: 100, firstChapter: "第一章" },
      { key: "剑名", value: "断霜", category: "item", t: 300, firstChapter: "第三章", locked: false },
      { key: "旧称", value: "阿清", category: "name", t: 200, status: "superseded", chapter: "第二章" },
    ],
    conflicts: [{ key: "年龄", attempted: "二十", kept: "十七", t: 900, chapter: "第九章" }],
  },
};

const canon = R.buildCanonRecords(canonProject);
assert.equal(canon.total, 4, "事实与被拒冲突都算记录");
assert.equal(canon.stats, "4 / 4 条");
assert.equal(keys(canon), "剑名 | 旧称 | 年龄 | 年龄", "事实按时间倒序在前，冲突沉到最后");
assert.equal(canon.visible.at(-1)._recordKind, "conflict");
assert.equal(canon.types.length, 4, "类型下拉含冲突这一类");
assert.equal(seq(canon.types.map((t) => R.label(t))), "称谓 | 冲突记录 | 数值 | 物件", "下拉按拼音排序");

// 锁定态：冲突恒为已拒，superseded 优先于 locked，locked:false 才算未锁
assert.equal(R.canonLockState({ _recordKind: "conflict", locked: true }), "rejected");
assert.equal(R.canonLockState({ status: "superseded" }), "superseded");
assert.equal(R.canonLockState({ dynamic: true }), "dynamic");
assert.equal(R.canonLockState({ locked: false }), "unlocked");
assert.equal(R.canonLockState({}), "locked", "缺字段默认按锁定处理");

const unlocked = R.buildCanonRecords(canonProject, { lock: "unlocked" });
assert.equal(keys(unlocked), "剑名");
assert.equal(unlocked.stats, "1 / 4 条", "统计要同时给出命中数和总数");

assert.equal(keys(R.buildCanonRecords(canonProject, { type: "number" })), "年龄");
assert.equal(
  keys(R.buildCanonRecords(canonProject, { evidence: "第九" }), "_recordKind"),
  "conflict",
  "证据筛选要能命中冲突记录上的章节"
);
assert.equal(R.buildCanonRecords(canonProject, { evidence: "  " }).matched, 4, "空白证据不算筛选");

// 证据章节把首现/末现/回收合成一条链，重复的只留一个
assert.equal(
  R.evidenceText({ firstChapter: "第一章", lastChapter: "第三章" }, ["firstChapter", "lastChapter"]),
  "第一章 → 第三章"
);
assert.equal(
  R.evidenceText({ firstChapter: "第一章", lastChapter: "第一章" }, ["firstChapter", "lastChapter"]),
  "第一章",
  "同章不重复显示"
);
assert.equal(R.evidenceText({}, ["firstChapter"]), "");

// 伏笔：待办在前，同状态按章节倒序；_sourceIndex 必须指回原数组
const loopProject = {
  plotLoops: [
    { summary: "已回收的旧钩", status: "resolved", type: "promise", lastOrder: 9 },
    { summary: "开着的钩", status: "open", kind: "mystery", lastOrder: 2, openedChapter: "第二章" },
    { summary: "延后的钩", status: "deferred", lastOrder: 5 },
    { summary: "更新的开钩", status: "open", lastOrder: 7 },
  ],
};
const loops = R.buildLoopRecords(loopProject);
assert.equal(
  keys(loops, "summary"),
  "更新的开钩 | 开着的钩 | 延后的钩 | 已回收的旧钩",
  "open → deferred → resolved，同级按章节倒序"
);
assert.equal(loops.visible[0]._sourceIndex, 3, "_sourceIndex 指向作者原数组位置");
assert.equal(loops.visible[1].type, "mystery", "kind 可作为 type 的旧字段名");
assert.equal(loops.visible[2].status, "deferred");
assert.equal(R.buildLoopRecords(loopProject, { status: "open" }).visible.length, 2);
assert.equal(R.buildLoopRecords(loopProject, { evidence: "第二章" }).matched, 1);

// 连续性：待处理优先，其次严重度，最后章节倒序
const issueProject = {
  continuityIssues: [
    { summary: "已处理的阻断", status: "handled", severity: "blocker", lastOrder: 1 },
    { summary: "开着的提醒", status: "open", severity: "minor", lastOrder: 4 },
    { summary: "开着的阻断", status: "open", severity: "blocker", lastOrder: 2 },
    { summary: "开着的高风险", status: "open", severity: "major", lastOrder: 3, firstChapter: "第三章" },
    { summary: "缺字段的", lastOrder: 8 },
  ],
};
const issues = R.buildContinuityRecords(issueProject);
assert.equal(
  keys(issues, "summary"),
  "开着的阻断 | 缺字段的 | 开着的高风险 | 开着的提醒 | 已处理的阻断",
  "open 在前；缺 status/severity 的按 open + major 处理"
);
assert.equal(issues.visible[1].status, "open");
assert.equal(issues.visible[1].severity, "major");
assert.equal(issues.visible[1].type, "general");
assert.equal(
  R.buildContinuityRecords(issueProject, { severity: "blocker" }).matched,
  2,
  "严重度筛选跨状态生效"
);
assert.equal(R.buildContinuityRecords(issueProject, { status: "open", severity: "minor" }).matched, 1);
assert.equal(R.buildContinuityRecords(issueProject, { evidence: "第三章" }).matched, 1);

// 超过渲染上限时只画前 100 条，但统计说真话
const many = R.buildLoopRecords({
  plotLoops: Array.from({ length: 130 }, (_, i) => ({ summary: `钩${i}`, status: "open", lastOrder: i })),
});
assert.equal(many.visible.length, R.RENDER_LIMIT);
assert.equal(many.matched, 130);
assert.equal(many.truncated, 30);
assert.equal(many.stats, "130 / 130 条");

const canonHtml = R.renderCanonHtml(canon);
assert.match(canonHtml, /story-record/);
assert.match(canonHtml, /断霜/);
const safeLoopHtml = R.renderLoopHtml(
  R.buildLoopRecords({ plotLoops: [{ summary: "<script>坏</script>", status: "open" }] })
);
assert.doesNotMatch(safeLoopHtml, /<script>/);
assert.match(safeLoopHtml, /&lt;script&gt;/);
const continuityHtml = R.renderContinuityHtml(issues);
assert.match(continuityHtml, /severity-blocker/);
assert.match(continuityHtml, /data-issue-index/);

const summary = R.buildStorySummary({
  spine: { spine: [{ act: 1, name: "启程", goal: "离城" }] },
  storyline: { positionSummary: "城门", chapterLogs: [{ order: 1, summary: "出发" }] },
  storyState: { lastChapter: "第一章", openLoops: ["追兵"] },
  memoryRoll: [{ chapter: "第一章", happened: ["越墙"] }],
  entityStates: { hero: { entity: "阿青", location: "城外" } },
  timelineEvents: [{ order: 1, event: "夜逃" }],
});
assert.match(summary.spineText, /Act1 启程/);
assert.match(summary.storylineText, /轨迹/);
assert.match(summary.memoryText, /追兵/);
assert.match(summary.entityStateText, /阿青/);

console.log("test_story_records: OK");
