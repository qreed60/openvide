import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamConfig } from "./types.js";
import type { TeamQueueState } from "./teamQueueTypes.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-queue-dispatcher-"));
process.env.HOME = tmpDir;

const sm = await import("./sessionManager.js");
const {
  cancelTeamQueueTask,
  createTeamQueueTask,
  loadTeamQueueState,
  saveTeamQueueState,
} = await import("./teamQueueStore.js");
const {
  dispatchTeamQueueOnce,
  getTeamQueueDispatchStatus,
} = await import("./teamQueueDispatcher.js");

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

function queueChat(teamId: string, title: string, priority = 50, clientMessageId?: string) {
  return createTeamQueueTask({
    teamId,
    source: "chat",
    title,
    description: title,
    priority,
    metadata: { from: "user", to: "*", clientMessageId },
  }, { statePath });
}

async function smokeBasicDispatch(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_basic", "model-basic");
  installTeams(team);
  const queued = queueChat(team.id, "Basic queued chat");
  let calls = 0;

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => {
      calls += 1;
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nqueued chat completed\n</OV_FINAL>",
      };
    },
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.equal(calls, 1);
  assert.deepEqual(result.dispatchedRunIds, [queued.run.id]);
  assert.equal(state.runs[queued.run.id]?.status, "completed");
  assert.equal(state.tasks[queued.task.id]?.status, "completed");
  assert.equal(state.runs[queued.run.id]?.metadata?.assistantText, "queued chat completed");
  assert.deepEqual(state.runs[queued.run.id]?.route, ["Lead"]);
  assert.equal((state.runs[queued.run.id]?.metadata?.queuedChatResult as { memberName?: string } | undefined)?.memberName, "Lead");
  assert.ok(Object.values(state.turns).some((turn) => turn.runId === queued.run.id && turn.status === "completed"));
  assert.ok(result.events.some((event) => event.type === "task_dispatch_started"));
  assert.ok(result.events.some((event) => event.type === "model_resource_acquired"));
  assert.ok(result.events.some((event) => event.type === "model_resource_released"));
}

async function smokeQueuedChatPersistsQueueLinkage(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_persist_linkage", "model-persist");
  installTeams(team);
  const queued = queueChat(team.id, "Persist linked queued chat", 50, "client-message-persist-1");

  const result = await dispatchTeamQueueOnce({
    statePath,
    executeMember: async () => ({
      status: "idle",
      responseText: "<OV_FINAL>\nlinked assistant response\n</OV_FINAL>",
    }),
  });

  const messagesPath = path.join(tmpDir, ".openvide-daemon", "teams", team.id, "messages.jsonl");
  const messages = fs.readFileSync(messagesPath, "utf8")
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line) as {
      from?: string;
      to?: string;
      text?: string;
      source?: string;
      clientMessageId?: string;
      queueTaskId?: string;
      queueRunId?: string;
      queueRunIds?: string[];
    });
  const userMessage = messages.find((message) => message.from === "user");
  const assistantMessage = messages.find((message) => message.to === "user" && message.from === "Lead");

  assert.deepEqual(result.dispatchedRunIds, [queued.run.id]);
  assert.equal(userMessage?.source, "queued_chat");
  assert.equal(userMessage?.clientMessageId, "client-message-persist-1");
  assert.equal(userMessage?.queueTaskId, queued.task.id);
  assert.equal(userMessage?.queueRunId, queued.run.id);
  assert.deepEqual(userMessage?.queueRunIds, [queued.run.id]);
  assert.equal(assistantMessage?.source, "queued_chat_result");
  assert.equal(assistantMessage?.clientMessageId, "client-message-persist-1");
  assert.equal(assistantMessage?.queueTaskId, queued.task.id);
  assert.equal(assistantMessage?.queueRunId, queued.run.id);
  assert.deepEqual(assistantMessage?.queueRunIds, [queued.run.id]);
}

async function smokeNoOutputFailsWithDiagnostic(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_no_output", "model-no-output");
  installTeams(team);
  const queued = queueChat(team.id, "No output queued chat");

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.deepEqual(result.dispatchedRunIds, [queued.run.id]);
  assert.ok(result.failedRunIds.includes(queued.run.id));
  assert.equal(state.runs[queued.run.id]?.status, "failed");
  assert.equal(state.tasks[queued.task.id]?.status, "failed");
  assert.match(state.runs[queued.run.id]?.error ?? "", /Lead did not emit|without assistant output/);
  assert.equal((state.runs[queued.run.id]?.metadata?.queuedChatResult as { finalStatus?: string } | undefined)?.finalStatus, "blocked");
  assert.ok(state.runs[queued.run.id]?.metadata?.queuedChatResult);
}

async function smokeSameTeamWaits(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_slot", "model-team-slot");
  installTeams(team);
  const first = queueChat(team.id, "First same-team chat", 90);
  const second = queueChat(team.id, "Second same-team chat", 80);

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "<OV_FINAL>\nfirst done\n</OV_FINAL>",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.ok(result.dispatchedRunIds.includes(first.run.id));
  assert.ok(result.waitingRunIds.includes(second.run.id));
  assert.equal(state.runs[second.run.id]?.status, "waiting_for_team_slot");
  assert.equal(state.runs[second.run.id]?.startedAt, undefined);
}

async function smokeSameResourceWaits(): Promise<void> {
  resetQueue();
  const teamA = makeTeam("team_resource_a", "shared-model");
  const teamB = makeTeam("team_resource_b", "shared-model");
  installTeams(teamA, teamB);
  const first = queueChat(teamA.id, "First same-resource chat", 90);
  const second = queueChat(teamB.id, "Second same-resource chat", 80);

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "<OV_FINAL>\nresource first done\n</OV_FINAL>",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.ok(result.dispatchedRunIds.includes(first.run.id));
  assert.ok(result.waitingRunIds.includes(second.run.id));
  assert.equal(state.runs[second.run.id]?.status, "waiting_for_model");
  const waitingTurn = Object.values(state.turns).find((turn) => turn.runId === second.run.id);
  assert.ok(waitingTurn);
  assert.equal(waitingTurn.providerStartedAt, undefined);
  assert.equal(waitingTurn.executionTimeoutStartedAt, undefined);
}

async function smokeDifferentResourcesRunIndependently(): Promise<void> {
  resetQueue();
  const teamA = makeTeam("team_independent_a", "resource-a");
  const teamB = makeTeam("team_independent_b", "resource-b");
  installTeams(teamA, teamB);
  const first = queueChat(teamA.id, "First independent chat", 90);
  const second = queueChat(teamB.id, "Second independent chat", 80);
  let active = 0;
  let maxActive = 0;

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nindependent done\n</OV_FINAL>",
      };
    },
  });

  assert.ok(result.dispatchedRunIds.includes(first.run.id));
  assert.ok(result.dispatchedRunIds.includes(second.run.id));
  assert.equal(maxActive, 2);
}

async function smokeResourceReleaseAfterFailure(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_failure_release", "failure-model");
  installTeams(team);
  const queued = queueChat(team.id, "Failure release chat");

  await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => {
      throw new Error("fake provider failure");
    },
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const turn = Object.values(state.turns).find((candidate) => candidate.runId === queued.run.id);
  assert.ok(turn);
  assert.equal(state.resources[turn.resourceKey]?.status, "available");
  assert.equal(state.resources[turn.resourceKey]?.activeTurnId, undefined);
  assert.equal(turn.status, "failed");
}

async function smokeReloadAndCancel(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_reload_cancel", "reload-model");
  installTeams(team);
  const reload = queueChat(team.id, "Reload survives");
  const cancelled = queueChat(team.id, "Cancelled work", 100);
  cancelTeamQueueTask(cancelled.task.id, { statePath });

  const reloaded = loadTeamQueueState({ statePath, recoverStaleActive: false });
  saveTeamQueueState(reloaded, { statePath, recoverStaleActive: false });
  const afterReload = loadTeamQueueState({ statePath, recoverStaleActive: false });
  assert.ok(afterReload.tasks[reload.task.id]);
  assert.equal(afterReload.tasks[cancelled.task.id]?.status, "cancelled");

  let calls = 0;
  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => {
      calls += 1;
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nreload done\n</OV_FINAL>",
      };
    },
  });
  assert.ok(!result.dispatchedRunIds.includes(cancelled.run.id));
  assert.equal(calls, 1);
}

await smokeBasicDispatch();
await smokeQueuedChatPersistsQueueLinkage();
await smokeNoOutputFailsWithDiagnostic();
await smokeSameTeamWaits();
await smokeSameResourceWaits();
await smokeDifferentResourcesRunIndependently();
await smokeResourceReleaseAfterFailure();
await smokeReloadAndCancel();

const finalState: TeamQueueState = loadTeamQueueState({ statePath, recoverStaleActive: false });
const dispatchStatus = getTeamQueueDispatchStatus({ statePath });

console.log(JSON.stringify({
  ok: true,
  statePath,
  taskCount: Object.keys(finalState.tasks).length,
  runCount: Object.keys(finalState.runs).length,
  turnCount: Object.keys(finalState.turns).length,
  dispatchableWaiting: dispatchStatus.waitingRunIds.length,
}, null, 2));
