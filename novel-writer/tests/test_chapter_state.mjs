import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(path.join(root, "chapter-state.js"), "utf8"), sandbox, {
  filename: path.join(root, "chapter-state.js"),
});
const State = sandbox.window.NOVEL_CHAPTER_STATE;

const chapter = {
  id: "chapter-1",
  body: "正文",
  handoffStatus: "done",
  production: { schemaVersion: 1, status: "done", stage: "done", updatedAt: 1 },
};
const task = { id: "task-1", status: "done" };

State.requestRevision(chapter, task, { at: 10, reason: "正文签名变化", stage: "quality-review" });
assert.equal(chapter.production.status, "needs_revision");
assert.equal(chapter.production.stage, "quality-review");
assert.equal(chapter.production.updatedAt, 10);
assert.equal(chapter.handoffStatus, "stale");
assert.equal(chapter.handoffError, "正文签名变化");
assert.equal(task.status, "needs_revision");
assert.equal(task.lastErrorStage, "quality-gate");
assert.deepEqual(Array.from(State.validate(chapter, task).errors), []);

State.markRevising(chapter, task, { at: 11 });
assert.equal(chapter.production.status, "revising");
assert.equal(task.status, "writing");

State.markAccepted(chapter, task, { at: 12, pendingHandoff: true });
assert.equal(chapter.production.status, "accepted_pending_handoff");
assert.equal(task.status, "written");
assert.equal(chapter.handoffStatus, "stale");

State.startHandoff(chapter, task, { at: 13 });
assert.equal(chapter.handoffStatus, "running");
State.markDigestComplete(chapter, task, { at: 14 });
assert.equal(task.status, "digested");
State.completeHandoff(chapter, task, { at: 15 });
assert.equal(chapter.production.status, "done");
assert.equal(chapter.production.stage, "done");
assert.equal(chapter.handoffStatus, "done");
assert.equal(chapter.handoffAt, 15);
assert.equal(task.status, "done");
assert.equal(State.validate(chapter, task).ok, true);

State.markHandoffStale(chapter, task, { at: 16, reason: "只重做交接" });
assert.equal(chapter.production.status, "accepted_pending_handoff");
assert.equal(chapter.production.stage, "accepted");
assert.equal(chapter.handoffStatus, "stale");
assert.equal(task.status, "written");
assert.equal(State.validate(chapter, task).ok, true);

const inconsistent = {
  id: "chapter-inconsistent",
  handoffStatus: "done",
  production: { schemaVersion: 1, status: "needs_revision", stage: "quality-blocked" },
};
const inconsistentTask = { id: "task-inconsistent", status: "done" };
assert.equal(State.validate(inconsistent, inconsistentTask).ok, false);
assert.equal(State.repair(inconsistent, inconsistentTask).changed, true);
assert.equal(inconsistent.handoffStatus, "stale");
assert.equal(inconsistentTask.status, "needs_revision");
assert.equal(State.validate(inconsistent, inconsistentTask).ok, true);

const acceptedButDone = {
  id: "accepted",
  handoffStatus: "stale",
  production: { schemaVersion: 1, status: "accepted", stage: "accepted" },
};
const acceptedTask = { id: "accepted-task", status: "done" };
State.repair(acceptedButDone, acceptedTask);
assert.equal(acceptedTask.status, "written");

State.markFailed(acceptedButDone, acceptedTask, {
  at: 20,
  reason: "模型失败",
  stage: "scene-writing",
});
assert.equal(acceptedButDone.production.status, "accepted_pending_handoff");
assert.equal(acceptedButDone.production.runtimeState, "failed");
assert.equal(acceptedButDone.production.lastStableState.status, "accepted");
assert.equal(acceptedTask.status, "written");
assert.equal(acceptedTask.lastError, "模型失败");

const interrupted = {
  handoffStatus: "stale",
  production: { schemaVersion: 1, status: "revising", stage: "revising" },
};
const interruptedTask = { status: "writing" };
State.markPaused(interrupted, interruptedTask, { at: 21 });
assert.equal(interrupted.production.status, "pending");
assert.equal(interrupted.production.stage, "paused");
assert.equal(interrupted.production.runtimeState, "paused");
assert.equal(interrupted.production.lastStableState.status, "revising");
assert.equal(interruptedTask.status, "pending");

const failedDraft = {
  handoffStatus: "stale",
  production: { schemaVersion: 1, status: "pending", stage: "scene-writing" },
};
const failedDraftTask = { status: "writing" };
State.markFailed(failedDraft, failedDraftTask, { at: 22, reason: "场面失败" });
assert.equal(failedDraft.production.status, "failed");
assert.equal(failedDraft.production.runtimeState, "failed");
assert.equal(failedDraftTask.status, "pending");

assert.equal(State.canTransition("accepted", "done"), true);
assert.equal(State.canTransition("pending", "done"), false);
assert.throws(
  () => State.completeHandoff({ production: { status: "pending" } }, null),
  (error) => error.code === "ILLEGAL_CHAPTER_TRANSITION"
);

const unknown = {
  production: { schemaVersion: 1, status: "future-terminal", stage: "future-terminal" },
};
assert.match(State.validate(unknown, null).errors[0], /unknown production status/);

const legacy = { id: "legacy", body: "正文", handoffStatus: "done" };
const legacyTask = { id: "legacy-task", status: "done" };
assert.equal(State.requestRevision(legacy, legacyTask, { reason: "旧章编辑" }).changed, false);
assert.equal(legacyTask.status, "written");

const timestampFree = {
  handoffStatus: "done",
  production: { schemaVersion: 1, status: "done", stage: "done" },
};
State.repair(timestampFree, null);
assert.equal("handoffAt" in timestampFree, false, "read repair must not invent a completion timestamp");

console.log("test_chapter_state: OK");
