import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cancelTeamBoardItem,
  createTeamBoardItem,
  getTeamBoardItem,
  listTeamBoardItems,
  setTeamBoardReviewStatus,
} from "./teamBoardStore.js";
import { loadTeamQueueState, updateTeamQueueState } from "./teamQueueStore.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-board-queue-"));
const statePath = path.join(tmpDir, "team-queue.json");

const created = createTeamBoardItem({
  teamId: "team_board",
  title: "Queue-backed Board item",
  description: "Verify queue-backed Board state",
  assignedMembers: ["Coder"],
  reviewerMembers: ["Reviewer"],
  priority: 90,
  createdBy: "smoke",
}, { statePath });

assert.equal(created.boardItem.source, "board");
assert.equal(created.boardItem.queueTaskId, created.queueTask.id);
assert.deepEqual(created.boardItem.queueRunIds, created.queueTask.runIds);
assert.equal(created.queueTask.source, "board");
assert.equal(created.queueTask.sourceRef?.boardTaskId, created.boardItem.id);
assert.equal(created.queueRuns.length, 1);
assert.equal(created.queueRuns[0]?.taskId, created.queueTask.id);
assert.equal(created.boardItem.executionStatus, "queued");
assert.equal(created.boardItem.reviewStatus, "not_required");
assert.deepEqual(created.boardItem.assignedMembers, ["Coder"]);
assert.deepEqual(created.boardItem.reviewerMembers, ["Reviewer"]);

const oldBoardStates = new Set(["todo", "done", "review", "approved"]);
assert.equal(oldBoardStates.has(created.boardItem.executionStatus), false);

let state = loadTeamQueueState({ statePath, recoverStaleActive: false });
for (const turn of Object.values(state.turns)) {
  assert.equal(turn.providerStartedAt, undefined);
  assert.equal(turn.executionTimeoutStartedAt, undefined);
}

updateTeamQueueState((draft) => {
  const task = draft.tasks[created.queueTask.id];
  if (!task) return;
  task.metadata = {
    ...(task.metadata ?? {}),
    legacyStatus: "approved",
    board: {
      ...(task.metadata?.board as Record<string, unknown> | undefined),
      legacyStatus: "approved",
    },
  };
}, { statePath });

const withLegacyStatus = getTeamBoardItem(created.boardItem.id, { statePath });
assert.equal(withLegacyStatus?.executionStatus, "queued");
assert.equal(withLegacyStatus?.reviewStatus, "not_required");
assert.equal(oldBoardStates.has(withLegacyStatus?.executionStatus ?? ""), false);

const reviewed = setTeamBoardReviewStatus({
  itemId: created.boardItem.id,
  reviewStatus: "revise",
  reviewFeedback: "Please tighten the acceptance criteria.",
}, { statePath });
assert.equal(reviewed?.executionStatus, "queued");
assert.equal(reviewed?.reviewStatus, "revise");
assert.equal(reviewed?.reviewFeedback, "Please tighten the acceptance criteria.");

const draft = createTeamBoardItem({
  teamId: "team_board",
  title: "Draft Board item",
  executionStatus: "draft",
}, { statePath });
assert.equal(draft.boardItem.executionStatus, "draft");
assert.equal(draft.boardItem.reviewStatus, "not_required");
assert.equal(oldBoardStates.has(draft.boardItem.executionStatus), false);

const blocked = createTeamBoardItem({
  teamId: "team_board",
  title: "Blocked Board item",
  executionStatus: "blocked",
  blockedReason: "Waiting on product input",
}, { statePath });
assert.equal(blocked.boardItem.executionStatus, "blocked");
assert.equal(blocked.boardItem.blockedReason, "Waiting on product input");

const cancelled = cancelTeamBoardItem(created.boardItem.id, { statePath });
assert.equal(cancelled.boardItem?.executionStatus, "cancelled");
assert.equal(cancelled.queueTask?.status, "cancelled");
assert.equal(cancelled.queueRuns[0]?.status, "cancelled");
assert.equal(cancelled.boardItem?.reviewStatus, "revise");

const cancelledDraft = cancelTeamBoardItem(draft.boardItem.id, { statePath });
assert.equal(cancelledDraft.boardItem?.executionStatus, "cancelled");

const items = listTeamBoardItems("team_board", { statePath });
assert.equal(items.length, 3);
assert.deepEqual(items.map((item) => item.executionStatus), ["cancelled", "cancelled", "blocked"]);

state = loadTeamQueueState({ statePath, recoverStaleActive: false });
for (const runId of draft.boardItem.queueRunIds) {
  const run = state.runs[runId];
  assert.equal(run?.startedAt, undefined);
  assert.equal(run?.metadata?.draft, true);
}

console.log(JSON.stringify({
  ok: true,
  statePath,
  boardItems: items,
}, null, 2));
