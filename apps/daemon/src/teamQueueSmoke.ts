import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cancelTeamQueueTask,
  createTeamQueueTask,
  getTeamQueueRun,
  getTeamQueueStatus,
  getTeamQueueTask,
  listTeamQueueRuns,
  listTeamQueueTasks,
  loadTeamQueueState,
  saveTeamQueueState,
  updateTeamQueueState,
} from "./teamQueueStore.js";
import type { TeamQueueState } from "./teamQueueTypes.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-queue-"));
const statePath = path.join(tmpDir, "team-queue.json");
const now = new Date().toISOString();

const staleState: TeamQueueState = {
  version: 1,
  createdAt: now,
  updatedAt: now,
  tasks: {
    task_1: {
      id: "task_1",
      teamId: "team_1",
      source: "board",
      status: "running",
      title: "Smoke task",
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      startedAt: now,
      runIds: ["run_1"],
    },
  },
  runs: {
    run_1: {
      id: "run_1",
      teamId: "team_1",
      taskId: "task_1",
      status: "running",
      currentState: "running",
      currentMember: "Coder",
      currentTurnId: "turn_1",
      route: ["Coder"],
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      startedAt: now,
      attempt: 1,
      turnIds: ["turn_1"],
    },
  },
  turns: {
    turn_1: {
      id: "turn_1",
      teamId: "team_1",
      taskId: "task_1",
      runId: "run_1",
      memberName: "Coder",
      role: "coder",
      provider: "codex",
      model: "qwen35_2b",
      resourceKey: "codex:qwen35_2b",
      status: "running",
      queuedAt: now,
      startedAt: now,
      providerStartedAt: now,
      executionTimeoutStartedAt: now,
    },
  },
  resources: {
    "codex:qwen35_2b": {
      key: "codex:qwen35_2b",
      provider: "codex",
      model: "qwen35_2b",
      status: "running",
      activeTurnId: "turn_1",
      queuedTurnIds: [],
      updatedAt: now,
    },
  },
};

saveTeamQueueState(staleState, { statePath, recoverStaleActive: false });
const recovered = loadTeamQueueState({ statePath });

assert.equal(recovered.runs.run_1.status, "interrupted");
assert.equal(recovered.runs.run_1.currentState, "interrupted");
assert.equal(recovered.runs.run_1.currentMember, undefined);
assert.equal(recovered.runs.run_1.currentTurnId, undefined);
assert.equal(recovered.tasks.task_1.status, "interrupted");
assert.equal(recovered.turns.turn_1.status, "interrupted");
assert.ok(recovered.turns.turn_1.finishedAt);
assert.equal(recovered.resources["codex:qwen35_2b"].status, "available");
assert.equal(recovered.resources["codex:qwen35_2b"].activeTurnId, undefined);
assert.equal(recovered.resources["codex:qwen35_2b"].metadata?.owner, undefined);

updateTeamQueueState((state) => {
  state.tasks.task_2 = {
    id: "task_2",
    teamId: "team_2",
    source: "chat",
    status: "queued",
    title: "Queued chat task",
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    runIds: [],
  };
}, { statePath });

const globalStatus = getTeamQueueStatus(undefined, { statePath });
assert.equal(globalStatus.tasks.total, 2);
assert.equal(globalStatus.tasks.byStatus.interrupted, 1);
assert.equal(globalStatus.runs.byStatus.interrupted, 1);
assert.equal(globalStatus.turns.byStatus.interrupted, 1);
assert.equal(globalStatus.activeRunIds.length, 0);
assert.equal(globalStatus.activeTurnIds.length, 0);

const teamStatus = getTeamQueueStatus("team_2", { statePath });
assert.equal(teamStatus.tasks.total, 1);
assert.equal(teamStatus.tasks.bySource.chat, 1);
assert.equal(teamStatus.runs.total, 0);

const board = createTeamQueueTask({
  teamId: "team_producers",
  source: "board",
  title: "Board task",
  description: "Implement a board item",
  assignedMemberNames: ["Coder"],
}, { statePath });
assert.equal(board.task.status, "queued");
assert.equal(board.task.source, "board");
assert.equal(board.task.priority, 50);
assert.deepEqual(board.run.route, ["Coder"]);
assert.equal(board.run.status, "queued");
assert.equal(board.run.startedAt, undefined);

const plan = createTeamQueueTask({
  teamId: "team_producers",
  source: "plan",
  title: "Plan request",
  description: "Draft a consensus plan",
  metadata: {
    reviewMode: "consensus",
    simple: false,
    consensus: true,
  },
}, { statePath });
assert.equal(plan.task.source, "plan");
assert.equal(plan.task.metadata?.consensus, true);
assert.equal(plan.run.metadata?.source, "plan");

const chat = createTeamQueueTask({
  teamId: "team_producers",
  source: "chat",
  title: "Chat request",
  description: "Ask the team a question",
  assignedMemberNames: ["Lead", "Reviewer"],
}, { statePath });
assert.equal(chat.task.source, "chat");
assert.deepEqual(chat.run.route, ["Lead", "Reviewer"]);

const producerTasks = listTeamQueueTasks("team_producers", { statePath });
assert.equal(producerTasks.length, 3);
assert.deepEqual(producerTasks.map((task) => task.source), ["board", "plan", "chat"]);
assert.equal(getTeamQueueTask(board.task.id, { statePath })?.id, board.task.id);

const producerRuns = listTeamQueueRuns("team_producers", { statePath });
assert.equal(producerRuns.length, 3);
assert.equal(getTeamQueueRun(chat.run.id, { statePath })?.id, chat.run.id);

const reloaded = loadTeamQueueState({ statePath, recoverStaleActive: false });
assert.ok(reloaded.tasks[board.task.id]);
assert.ok(reloaded.tasks[plan.task.id]);
assert.ok(reloaded.tasks[chat.task.id]);
for (const run of [reloaded.runs[board.run.id], reloaded.runs[plan.run.id], reloaded.runs[chat.run.id]]) {
  assert.equal(run.status, "queued");
  assert.equal(run.startedAt, undefined);
  assert.equal(run.turnIds.length, 0);
}
for (const task of [reloaded.tasks[board.task.id], reloaded.tasks[plan.task.id], reloaded.tasks[chat.task.id]]) {
  assert.equal(task.startedAt, undefined);
}
for (const run of [reloaded.runs[board.run.id], reloaded.runs[plan.run.id], reloaded.runs[chat.run.id]]) {
  assert.equal(run.turnIds.some((turnId) => {
    const turn = reloaded.turns[turnId];
    return Boolean(turn?.providerStartedAt || turn?.executionTimeoutStartedAt);
  }), false);
}

const cancelled = cancelTeamQueueTask(board.task.id, { statePath });
assert.equal(cancelled.task?.status, "cancelled");
assert.equal(cancelled.runs[0]?.status, "cancelled");
assert.ok(loadTeamQueueState({ statePath, recoverStaleActive: false }).tasks[board.task.id]);

const producerStatus = getTeamQueueStatus("team_producers", { statePath });
assert.equal(producerStatus.tasks.total, 3);
assert.equal(producerStatus.tasks.bySource.board, 1);
assert.equal(producerStatus.tasks.bySource.plan, 1);
assert.equal(producerStatus.tasks.bySource.chat, 1);
assert.equal(producerStatus.tasks.byStatus.cancelled, 1);
assert.equal(producerStatus.tasks.byStatus.queued, 2);
assert.equal(producerStatus.runs.byStatus.cancelled, 1);
assert.equal(producerStatus.runs.byStatus.queued, 2);

const finalGlobalStatus = getTeamQueueStatus(undefined, { statePath });
assert.equal(finalGlobalStatus.tasks.bySource.board, 2);
assert.equal(finalGlobalStatus.tasks.bySource.plan, 1);
assert.equal(finalGlobalStatus.tasks.bySource.chat, 2);

console.log(JSON.stringify({ ok: true, statePath, globalStatus: finalGlobalStatus, teamStatus, producerStatus }, null, 2));
