import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamConfig } from "./types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-queue-delete-"));
process.env.HOME = tmpDir;

const sm = await import("./sessionManager.js");
const {
  createTeamQueueTask,
  deleteTeamQueueItem,
  getTeamQueueRun,
  getTeamQueueStatus,
  getTeamQueueTask,
  listTeamQueueRuns,
  listTeamQueueTasks,
  loadTeamQueueState,
  saveTeamQueueState,
  updateTeamQueueState,
} = await import("./teamQueueStore.js");
const { dispatchTeamQueueOnce } = await import("./teamQueueDispatcher.js");

const statePath = path.join(tmpDir, "team-queue.json");
const now = new Date().toISOString();

function resetQueue(): void {
  saveTeamQueueState({
    version: 1,
    createdAt: now,
    updatedAt: now,
    tasks: {},
    runs: {},
    turns: {},
    resources: {},
  }, { statePath, recoverStaleActive: false });
}

function makeTeam(id: string): TeamConfig {
  return {
    id,
    name: id,
    workingDirectory: tmpDir,
    members: [{
      name: "Lead",
      tool: "codex",
      model: "delete-smoke-model",
      role: "lead",
      sessionId: `session_${id}`,
    }],
    createdAt: now,
    updatedAt: now,
  };
}

function installTeams(...teams: TeamConfig[]): void {
  const state = sm.getState();
  state.teams = Object.fromEntries(teams.map((team) => [team.id, team]));
}

function queueChat(teamId: string, title: string) {
  return createTeamQueueTask({
    teamId,
    source: "chat",
    title,
    description: `Prompt for ${title}`,
    metadata: {
      from: "user",
      to: "*",
      chatPrompt: `Prompt for ${title}`,
    },
  }, { statePath });
}

resetQueue();
const team = makeTeam("team_delete");
installTeams(team);

const queued = queueChat(team.id, "Delete by task id");
updateTeamQueueState((state) => {
  const run = state.runs[queued.run.id];
  if (!run) return;
  run.status = "waiting_for_model";
  run.currentState = "waiting_for_model";
  const turnId = "turn_delete_waiting";
  run.turnIds.push(turnId);
  state.turns[turnId] = {
    id: turnId,
    teamId: team.id,
    taskId: queued.task.id,
    runId: queued.run.id,
    memberName: "Lead",
    role: "lead",
    provider: "codex",
    model: "delete-smoke-model",
    resourceKey: "codex:delete-smoke-model",
    status: "waiting_for_model",
    queuedAt: now,
  };
  state.resources["codex:delete-smoke-model"] = {
    key: "codex:delete-smoke-model",
    provider: "codex",
    model: "delete-smoke-model",
    status: "reserved",
    activeTurnId: turnId,
    queuedTurnIds: [turnId],
    updatedAt: now,
    metadata: {
      owner: {
        turnId,
        runId: queued.run.id,
        teamId: team.id,
        taskId: queued.task.id,
      },
    },
  };
}, { statePath });

const deleted = deleteTeamQueueItem({
  teamId: team.id,
  queueTaskId: queued.task.id,
  deletedBy: "smoke",
  reason: "user deleted queued chat",
}, { statePath });
assert.equal(deleted.ok, true);
assert.equal(deleted.queueTaskId, queued.task.id);
assert.deepEqual(deleted.queueRunIds, [queued.run.id]);
assert.ok(deleted.deletedAt);

const deletedTask = getTeamQueueTask(queued.task.id, { statePath });
const deletedRun = getTeamQueueRun(queued.run.id, { statePath });
const deletedState = loadTeamQueueState({ statePath, recoverStaleActive: false });
const deletedTurn = deletedState.turns.turn_delete_waiting;
assert.equal(deletedTask?.visibility, "deleted");
assert.equal(deletedTask?.deletedBy, "smoke");
assert.equal(deletedTask?.deleteReason, "user deleted queued chat");
assert.equal(deletedTask?.title, "Delete by task id");
assert.equal(deletedTask?.description, "Prompt for Delete by task id");
assert.equal(deletedTask?.metadata?.chatPrompt, "Prompt for Delete by task id");
assert.equal(deletedRun?.status, "cancelled");
assert.equal(deletedRun?.visibility, "deleted");
assert.equal(deletedRun?.currentState, "cancelled");
assert.equal(deletedTurn.status, "cancelled");
assert.equal(deletedTurn.visibility, "deleted");
assert.equal(deletedState.resources["codex:delete-smoke-model"].status, "available");
assert.equal(deletedState.resources["codex:delete-smoke-model"].activeTurnId, undefined);
assert.deepEqual(deletedState.resources["codex:delete-smoke-model"].queuedTurnIds, []);

const normalTasks = listTeamQueueTasks(team.id, { statePath });
const normalRuns = listTeamQueueRuns(team.id, { statePath });
assert.equal(normalTasks.some((task) => task.id === queued.task.id), false);
assert.equal(normalRuns.some((run) => run.id === queued.run.id), false);
assert.equal(listTeamQueueTasks(team.id, { statePath, includeDeleted: true }).some((task) => task.id === queued.task.id), true);
assert.equal(listTeamQueueRuns(team.id, { statePath, includeDeleted: true }).some((run) => run.id === queued.run.id), true);

const statusAfterDelete = getTeamQueueStatus(team.id, { statePath });
assert.equal(statusAfterDelete.tasks.total, 0);
assert.equal(statusAfterDelete.runs.total, 0);
assert.equal(statusAfterDelete.turns.total, 0);
assert.equal(statusAfterDelete.deleted.tasks, 1);
assert.equal(statusAfterDelete.deleted.runs, 1);
assert.equal(statusAfterDelete.deleted.turns, 1);
assert.equal(statusAfterDelete.tasks.byStatus.queued, undefined);
assert.equal(statusAfterDelete.runs.byStatus.waiting_for_model, undefined);

let dispatchCalls = 0;
const dispatchResult = await dispatchTeamQueueOnce({
  statePath,
  persistChatMessages: false,
  executeMember: async () => {
    dispatchCalls += 1;
    return {
      status: "idle",
      responseText: "<OV_FINAL>\nshould not dispatch\n</OV_FINAL>",
    };
  },
});
assert.equal(dispatchCalls, 0);
assert.deepEqual(dispatchResult.dispatchedRunIds, []);

const completed = queueChat(team.id, "Delete completed by run id");
updateTeamQueueState((state) => {
  const task = state.tasks[completed.task.id];
  const run = state.runs[completed.run.id];
  if (task) {
    task.status = "completed";
    task.finishedAt = now;
  }
  if (run) {
    run.status = "completed";
    run.currentState = "completed";
    run.finishedAt = now;
  }
}, { statePath });
const deletedByRun = deleteTeamQueueItem({
  teamId: team.id,
  queueRunId: completed.run.id,
  deletedBy: "smoke",
}, { statePath });
assert.equal(deletedByRun.ok, true);
assert.equal(deletedByRun.queueTaskId, completed.task.id);
assert.deepEqual(deletedByRun.queueRunIds, [completed.run.id]);
assert.equal(getTeamQueueTask(completed.task.id, { statePath })?.visibility, "deleted");

const running = queueChat(team.id, "Do not delete running");
updateTeamQueueState((state) => {
  const task = state.tasks[running.task.id];
  const run = state.runs[running.run.id];
  if (task) task.status = "running";
  if (run) {
    run.status = "running";
    run.currentState = "running";
  }
}, { statePath });
const rejected = deleteTeamQueueItem({
  teamId: team.id,
  queueTaskId: running.task.id,
}, { statePath });
assert.equal(rejected.ok, false);
assert.match(rejected.error ?? "", /running/);
assert.equal(getTeamQueueTask(running.task.id, { statePath })?.visibility, undefined);

console.log(JSON.stringify({
  ok: true,
  statePath,
  deletedTaskId: queued.task.id,
  deletedRunId: queued.run.id,
  deletedAt: deleted.deletedAt,
  finalStatus: getTeamQueueStatus(team.id, { statePath }),
}, null, 2));
