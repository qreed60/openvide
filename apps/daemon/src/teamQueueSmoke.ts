import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTeamQueueStatus, loadTeamQueueState, saveTeamQueueState, updateTeamQueueState } from "./teamQueueStore.js";
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

console.log(JSON.stringify({ ok: true, statePath, globalStatus, teamStatus }, null, 2));
