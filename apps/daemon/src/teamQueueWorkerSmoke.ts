import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamConfig } from "./types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-queue-worker-"));
process.env.HOME = tmpDir;

const sm = await import("./sessionManager.js");
const {
  createTeamQueueTask,
  deleteTeamQueueItem,
  loadTeamQueueState,
  saveTeamQueueState,
  updateTeamQueueState,
} = await import("./teamQueueStore.js");
const { dispatchTeamQueueOnce } = await import("./teamQueueDispatcher.js");
const { configureQueueWorker, tickQueueWorkerOnce } = await import("./teamQueueWorker.js");

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

function makeTeam(id: string, model: string): TeamConfig {
  return {
    id,
    name: id,
    workingDirectory: tmpDir,
    members: [{
      name: "Lead",
      tool: "codex",
      model,
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
  }, { statePath });
}

async function workerOptions(calls: { count: number }) {
  return {
    statePath,
    persistChatMessages: false,
    executeMember: async () => {
      calls.count += 1;
      return {
        status: "idle" as const,
        responseText: "<OV_FINAL>\nworker done\n</OV_FINAL>",
      };
    },
  };
}

async function smokeWorkerDispatchesChat(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_worker_dispatch", "worker-model");
  installTeams(team);
  const queued = queueChat(team.id, "Auto dispatch chat");
  const calls = { count: 0 };
  configureQueueWorker({ enabled: true });

  const status = await tickQueueWorkerOnce(await workerOptions(calls));
  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });

  assert.equal(calls.count, 1);
  assert.equal(status.lastDispatchResult?.dispatchedRunIds[0], queued.run.id);
  assert.equal(state.runs[queued.run.id]?.status, "completed");
  assert.ok(status.lastTickAt);
}

async function smokeDisabledWorkerDoesNotDispatch(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_worker_disabled", "disabled-model");
  installTeams(team);
  const queued = queueChat(team.id, "Disabled worker chat");
  const calls = { count: 0 };
  configureQueueWorker({ enabled: false });

  const status = await tickQueueWorkerOnce(await workerOptions(calls));
  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });

  assert.equal(calls.count, 0);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.lastDispatchResult?.dispatchedRunIds, []);
  assert.equal(state.runs[queued.run.id]?.status, "queued");
  configureQueueWorker({ enabled: true });
}

async function smokeWorkerSkipsDeletedCancelledDraftBlocked(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_worker_skip", "skip-model");
  installTeams(team);
  const deleted = queueChat(team.id, "Deleted chat", 100);
  deleteTeamQueueItem({ queueTaskId: deleted.task.id }, { statePath });
  const cancelled = queueChat(team.id, "Cancelled chat", 90);
  updateTeamQueueState((state) => {
    const task = state.tasks[cancelled.task.id];
    const run = state.runs[cancelled.run.id];
    if (task) task.status = "cancelled";
    if (run) run.status = "cancelled";
  }, { statePath });
  const draft = createTeamQueueTask({
    teamId: team.id,
    source: "board",
    title: "Draft board task",
    priority: 80,
    metadata: { board: { executionStatus: "draft" } },
  }, { statePath });
  const blocked = createTeamQueueTask({
    teamId: team.id,
    source: "board",
    title: "Blocked board task",
    priority: 70,
    metadata: { board: { executionStatus: "blocked" } },
  }, { statePath });
  const calls = { count: 0 };

  const status = await tickQueueWorkerOnce(await workerOptions(calls));
  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });

  assert.equal(calls.count, 0);
  assert.deepEqual(status.lastDispatchResult?.dispatchedRunIds, []);
  assert.equal(state.runs[draft.run.id]?.status, "queued");
  assert.equal(state.runs[blocked.run.id]?.status, "queued");
}

async function smokeWorkerRespectsTeamAndResourceSlots(): Promise<void> {
  resetQueue();
  const teamA = makeTeam("team_worker_slot_a", "shared-worker-model");
  const teamB = makeTeam("team_worker_slot_b", "shared-worker-model");
  installTeams(teamA, teamB);
  const active = queueChat(teamA.id, "Already active", 100);
  const sameTeam = queueChat(teamA.id, "Wait for team", 90);
  const firstResource = queueChat(teamB.id, "Use resource", 80);
  const secondResource = createTeamQueueTask({
    teamId: "team_worker_slot_c",
    source: "chat",
    title: "Wait for resource",
    description: "Wait for resource",
    priority: 70,
    metadata: { from: "user", to: "*" },
  }, { statePath });
  installTeams(teamA, teamB, makeTeam("team_worker_slot_c", "shared-worker-model"));
  updateTeamQueueState((state) => {
    const task = state.tasks[active.task.id];
    const run = state.runs[active.run.id];
    if (task) task.status = "running";
    if (run) run.status = "running";
  }, { statePath });
  const calls = { count: 0 };

  const status = await tickQueueWorkerOnce(await workerOptions(calls));
  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const waitingTurn = Object.values(state.turns).find((turn) => turn.runId === secondResource.run.id);

  assert.equal(calls.count, 1);
  assert.ok(status.lastDispatchResult?.waitingRunIds.includes(sameTeam.run.id));
  assert.ok(status.lastDispatchResult?.dispatchedRunIds.includes(firstResource.run.id));
  assert.ok(status.lastDispatchResult?.waitingRunIds.includes(secondResource.run.id));
  assert.equal(state.runs[sameTeam.run.id]?.status, "waiting_for_team_slot");
  assert.equal(waitingTurn?.providerStartedAt, undefined);
  assert.equal(waitingTurn?.executionTimeoutStartedAt, undefined);
}

async function smokeManualDispatchStillWorks(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_worker_manual", "manual-model");
  installTeams(team);
  const queued = queueChat(team.id, "Manual dispatch chat");
  const calls = { count: 0 };
  const result = await dispatchTeamQueueOnce(await workerOptions(calls));

  assert.equal(calls.count, 1);
  assert.deepEqual(result.dispatchedRunIds, [queued.run.id]);
}

await smokeWorkerDispatchesChat();
await smokeDisabledWorkerDoesNotDispatch();
await smokeWorkerSkipsDeletedCancelledDraftBlocked();
await smokeWorkerRespectsTeamAndResourceSlots();
await smokeManualDispatchStillWorks();

console.log(JSON.stringify({
  ok: true,
  statePath,
  workerStatus: configureQueueWorker({ enabled: true }),
}, null, 2));
