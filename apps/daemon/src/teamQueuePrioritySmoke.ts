import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamConfig } from "./types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-queue-priority-"));
process.env.HOME = tmpDir;

const sm = await import("./sessionManager.js");
const {
  createTeamQueueTask,
  deleteTeamQueueItem,
  getTeamQueueStatus,
  loadTeamQueueState,
  saveTeamQueueState,
  updateTeamQueueItemPriority,
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
      model: "priority-model",
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

function queueChat(teamId: string, title: string, priority = 50) {
  return createTeamQueueTask({
    teamId,
    source: "chat",
    title,
    description: title,
    priority,
    metadata: { from: "user", to: "*" },
  }, { statePath, recoverStaleActive: false });
}

async function smokePriorityPersistsAndSorts(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_priority_sort");
  installTeams(team);
  const low = queueChat(team.id, "Low priority", 10);
  const high = queueChat(team.id, "High priority", 20);

  const updated = updateTeamQueueItemPriority({
    queueTaskId: low.task.id,
    priority: 99,
  }, { statePath, recoverStaleActive: false });
  assert.equal(updated.ok, true);
  assert.equal(updated.priority, 99);

  const reloaded = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.equal(reloaded.tasks[low.task.id]?.priority, 99);
  assert.equal(reloaded.runs[low.run.id]?.priority, 99);

  const status = getTeamQueueStatus(team.id, { statePath });
  assert.equal(status.items[0]?.queueTaskId, low.task.id);
  assert.equal(status.items[0]?.priority, 99);
  assert.equal(status.items.find((item) => item.queueTaskId === high.task.id)?.reorderable, true);
}

async function smokeMoveTopBottomChangesDispatchOrder(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_priority_move");
  installTeams(team);
  const first = queueChat(team.id, "First same priority", 50);
  const second = queueChat(team.id, "Second same priority", 50);
  const third = queueChat(team.id, "Third same priority", 50);

  const top = updateTeamQueueItemPriority({ queueTaskId: third.task.id, move: "top" }, { statePath });
  assert.equal(top.ok, true);
  let status = getTeamQueueStatus(team.id, { statePath });
  assert.equal(status.items[0]?.queueTaskId, third.task.id);

  const bottom = updateTeamQueueItemPriority({ queueTaskId: third.task.id, move: "bottom" }, { statePath });
  assert.equal(bottom.ok, true);
  status = getTeamQueueStatus(team.id, { statePath });
  assert.equal(status.items[status.items.length - 1]?.queueTaskId, third.task.id);

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "<OV_FINAL>\npriority done\n</OV_FINAL>",
    }),
  });

  assert.equal(result.dispatchedRunIds[0], first.run.id);
  assert.ok(result.waitingRunIds.includes(second.run.id));
}

async function smokeRunIdFallbackAndRejectedStatuses(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_priority_reject");
  installTeams(team);
  const fallback = queueChat(team.id, "Run id fallback");
  const byRun = updateTeamQueueItemPriority({
    queueRunId: fallback.run.id,
    priority: 77,
  }, { statePath, recoverStaleActive: false });
  assert.equal(byRun.ok, true);
  assert.equal(byRun.queueTaskId, fallback.task.id);
  assert.equal(loadTeamQueueState({ statePath, recoverStaleActive: false }).tasks[fallback.task.id]?.priority, 77);

  const running = queueChat(team.id, "Running cannot move");
  updateTeamQueueState((state) => {
    const task = state.tasks[running.task.id];
    const run = state.runs[running.run.id];
    if (task) task.status = "running";
    if (run) run.status = "running";
  }, { statePath, recoverStaleActive: false });
  const runningRejected = updateTeamQueueItemPriority({ queueTaskId: running.task.id, move: "top" }, { statePath });
  assert.equal(runningRejected.ok, false);
  assert.match(runningRejected.error ?? "", /running/);

  const completed = queueChat(team.id, "Completed cannot move");
  updateTeamQueueState((state) => {
    const task = state.tasks[completed.task.id];
    const run = state.runs[completed.run.id];
    if (task) task.status = "completed";
    if (run) run.status = "completed";
  }, { statePath, recoverStaleActive: false });
  const completedRejected = updateTeamQueueItemPriority({ queueTaskId: completed.task.id, priority: 90 }, { statePath });
  assert.equal(completedRejected.ok, false);
  assert.match(completedRejected.error ?? "", /completed/);

  const deleted = queueChat(team.id, "Deleted cannot move");
  deleteTeamQueueItem({ queueTaskId: deleted.task.id }, { statePath });
  const deletedRejected = updateTeamQueueItemPriority({ queueTaskId: deleted.task.id, move: "bottom" }, { statePath });
  assert.equal(deletedRejected.ok, false);
  assert.match(deletedRejected.error ?? "", /deleted/);

  const status = getTeamQueueStatus(team.id, { statePath, recoverStaleActive: false });
  assert.equal(status.items.some((item) => item.queueTaskId === deleted.task.id), false);
  assert.equal(status.items.find((item) => item.queueTaskId === running.task.id)?.reorderable, false);
  assert.equal(status.items.find((item) => item.queueTaskId === running.task.id)?.status, "running");
}

await smokePriorityPersistsAndSorts();
await smokeMoveTopBottomChangesDispatchOrder();
await smokeRunIdFallbackAndRejectedStatuses();

console.log(JSON.stringify({
  ok: true,
  statePath,
  finalStatus: getTeamQueueStatus(undefined, { statePath, recoverStaleActive: false }),
}, null, 2));
