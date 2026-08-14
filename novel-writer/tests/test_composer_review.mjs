/**
 * 生成结果卡的撤销闸。
 * 撤销会用旧正文盖掉当前正文，所以「什么时候不许撤」比「怎么撤」更要紧。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console, JSON };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "composer-review.js"), "utf8"), sandbox);
const CR = sandbox.window.NOVEL_COMPOSER_REVIEW;

assert.ok(CR, "NOVEL_COMPOSER_REVIEW must load");

const words = (text) => String(text || "").replace(/\s/g, "").length;

function fixture() {
  const chapter = {
    id: "c1",
    taskId: "t1",
    body: "原稿两百字",
    handoffStatus: "done",
    handoffError: "",
    revisionHistory: [{ kind: "annotate", body: "更早的稿" }],
  };
  const task = { id: "t1", status: "done" };
  return { project: { id: "p1", chapters: [chapter], tasks: [task] }, chapter, task };
}

// 快照要带上任务状态，撤销时任务也得跟着回退
const base = fixture();
const snap = CR.capture(base.project, base.chapter, "continue");
assert.equal(snap.projectId, "p1");
assert.equal(snap.chapterId, "c1");
assert.equal(snap.kind, "continue");
assert.equal(snap.beforeBody, "原稿两百字");
assert.equal(snap.beforeHandoffStatus, "done");
assert.equal(snap.taskId, "t1");
assert.equal(snap.beforeTaskStatus, "done");

// revisionHistory 必须深拷贝：生成过程往里追加，不能污染快照
base.chapter.revisionHistory.push({ kind: "continue", body: "原稿两百字" });
assert.equal(snap.beforeRevisionHistory.length, 1, "快照里的修订史不随后续追加变化");

// 生成前没有修订史时记 null，撤销后要把这个字段删干净
const fresh = { id: "c2", body: "空章" };
assert.equal(CR.capture({ id: "p1", tasks: [] }, fresh, "rewrite").beforeRevisionHistory, null);
assert.equal(CR.capture(null, null, "continue").projectId, "");
assert.equal(CR.capture({ id: "p1", tasks: [] }, { id: "c9" }, "continue").taskId, "", "没有绑定任务不算错");

// 落定后按字数差给文案
base.chapter.body = "原稿两百字加上新写的一段";
const sealed = CR.seal(snap, base.chapter);
assert.equal(sealed.afterBody, "原稿两百字加上新写的一段");
assert.equal(sealed.canUndo, true);
const view = CR.presentation(sealed, words);
assert.equal(view.kicker, "续写结果");
assert.equal(view.title, "新正文已接在原稿之后");
assert.equal(view.delta, 7);
assert.equal(view.meta, "5 → 12 字 · +7 字");
assert.equal(view.undoTitle, "恢复生成前的正文");

// 字数不变和变少都要说人话
const shrink = CR.seal({ ...snap, kind: "annotate" }, { body: "短稿" });
assert.equal(CR.presentation(shrink, words).meta, "5 → 2 字 · -3 字");
assert.equal(CR.presentation(shrink, words).kicker, "批注修订");
const same = CR.seal({ ...snap, kind: "rewrite" }, { body: "原稿两百字" });
assert.equal(CR.presentation(same, words).meta, "5 → 5 字 · 字数不变");
assert.equal(CR.presentation(same, words).title, "重写结果已替换选中段落");
assert.equal(CR.presentation(CR.seal({ ...snap, kind: "什么" }, { body: "x" }), words).kicker, "本次生成");
assert.equal(
  CR.presentation(sealed, words, { note: "已交接" }).meta,
  "5 → 12 字 · +7 字 · 已交接",
  "附注跟在字数后面"
);
assert.equal(CR.presentation(sealed, words, { note: "   " }).meta, "5 → 12 字 · +7 字", "空白附注不显示");

// 结果已进故事记忆时，撤销按钮要禁用并说明原因
const locked = CR.seal(snap, base.chapter, { canUndo: false });
assert.equal(locked.canUndo, false);
assert.equal(CR.presentation(locked, words).canUndo, false);
assert.equal(CR.presentation(locked, words).undoTitle, CR.DEFAULT_UNDO_REASON);
const lockedWithReason = CR.seal(snap, base.chapter, { canUndo: false, undoReason: "已写入 Canon" });
assert.equal(CR.presentation(lockedWithReason, words).undoTitle, "已写入 Canon");

// 作者又改了一个字，旧快照立刻作废：这是防止撤销盖掉新内容的唯一闸
assert.equal(CR.stillApplies(sealed, base.project, base.chapter), true);
assert.equal(CR.canUndo(sealed, base.project, base.chapter), true);
assert.equal(
  CR.stillApplies(sealed, base.project, { ...base.chapter, body: base.chapter.body + "又改了" }),
  false,
  "正文再被改动后旧结果不可撤销"
);
assert.equal(CR.stillApplies(sealed, { id: "p2", chapters: [] }, base.chapter), false, "换书后作废");
assert.equal(CR.stillApplies(sealed, base.project, { ...base.chapter, id: "c2" }), false, "换章后作废");
assert.equal(CR.stillApplies(sealed, base.project, null), false);
assert.equal(CR.stillApplies(null, base.project, base.chapter), false);
assert.equal(CR.canUndo(locked, base.project, base.chapter), false, "禁用撤销的结果不能被撤");

// 撤销把正文、交接态、修订史、任务状态一起回退
const target = fixture();
const undoSnap = CR.seal(CR.capture(target.project, target.chapter, "annotate"), {
  body: "生成后的正文",
});
target.chapter.body = "生成后的正文";
target.chapter.handoffStatus = "stale";
target.chapter.handoffError = "交接失败";
target.chapter.revisionHistory.push({ kind: "annotate", body: "原稿两百字" });
target.task.status = "written";
CR.restore(undoSnap, target.chapter, target.task);
assert.equal(target.chapter.body, "原稿两百字");
assert.equal(target.chapter.handoffStatus, "done");
assert.equal(target.chapter.handoffError, "");
assert.equal(target.chapter.revisionHistory.length, 1, "修订史回到生成前");
assert.equal(target.task.status, "done", "任务状态一起回退");
assert.ok(target.chapter.updatedAt, "回退也算一次修改，要更新时间戳");

// 生成前本来没有修订史，撤销后不许留下空数组
const cleanChapter = { id: "c3", body: "生成结果" };
const cleanSnap = CR.seal(
  CR.capture({ id: "p1", tasks: [] }, { id: "c3", body: "原稿" }, "rewrite"),
  cleanChapter
);
cleanChapter.revisionHistory = [{ kind: "rewrite" }];
CR.restore(cleanSnap, cleanChapter, null);
assert.equal(cleanChapter.body, "原稿");
assert.equal("revisionHistory" in cleanChapter, false, "生成前没有修订史就删掉字段");

console.log("test_composer_review: OK");
