import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamConfig } from "./types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-team-board-execution-"));
process.env.HOME = tmpDir;

const sm = await import("./sessionManager.js");
const {
  createTeamBoardItem,
  getTeamBoardItem,
} = await import("./teamBoardStore.js");
const {
  dispatchTeamQueueOnce,
} = await import("./teamQueueDispatcher.js");
const {
  loadTeamQueueState,
  saveTeamQueueState,
} = await import("./teamQueueStore.js");

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
    members: [
      {
        name: "Lead",
        tool: "codex",
        model,
        role: "lead",
        sessionId: `session_${id}_lead`,
      },
      {
        name: "Coder",
        tool: "codex",
        model,
        role: "coder",
        sessionId: `session_${id}_coder`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function installTeams(...teams: TeamConfig[]): void {
  const state = sm.getState();
  state.teams = Object.fromEntries(teams.map((team) => [team.id, team]));
}

async function smokeBoardDispatchesThroughOrchestrator(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_board_exec", "board-model");
  installTeams(team);
  const created = createTeamBoardItem({
    teamId: team.id,
    title: "10J board execution smoke",
    description: "Reply with exactly BOARD_EXECUTION_OK. Do not edit files.",
    assignedMembers: ["Coder"],
    priority: 91,
    createdBy: "smoke",
  }, { statePath });
  const prompts: string[] = [];

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nBOARD_EXECUTION_OK\n</OV_FINAL>",
      };
    },
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.queueRuns[0]!.id];
  const task = state.tasks[created.queueTask.id];
  const boardItem = getTeamBoardItem(created.boardItem.id, { statePath });
  const turn = Object.values(state.turns).find((candidate) => candidate.runId === run?.id);

  assert.deepEqual(result.dispatchedRunIds, [created.queueRuns[0]!.id]);
  assert.equal(task?.status, "completed");
  assert.equal(run?.status, "completed");
  assert.equal(boardItem?.executionStatus, "completed");
  assert.equal(boardItem?.reviewStatus, "not_required");
  assert.equal(boardItem?.resultSummary, "BOARD_EXECUTION_OK");
  assert.deepEqual(boardItem?.resultRoute, ["Lead"]);
  assert.equal(task?.metadata?.assistantText, "BOARD_EXECUTION_OK");
  assert.equal(run?.metadata?.assistantText, "BOARD_EXECUTION_OK");
  assert.equal((task?.metadata?.queuedBoardResult as { finalStatus?: string } | undefined)?.finalStatus, "completed");
  assert.equal((run?.metadata?.queuedBoardResult as { provider?: string; model?: string } | undefined)?.provider, "codex");
  assert.equal((run?.metadata?.queuedBoardResult as { provider?: string; model?: string } | undefined)?.model, "board-model");
  assert.ok(prompts.some((prompt) => prompt.includes("Board title: 10J board execution smoke")));
  assert.ok(prompts.some((prompt) => prompt.includes("Assigned member intent: Coder.")));
  assert.ok(prompts.some((prompt) => prompt.includes("Priority: 91")));
  assert.ok(turn?.providerStartedAt);
  assert.ok(turn?.executionTimeoutStartedAt);
}

async function smokeBoardNoOutputFailsWithDiagnostic(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_board_no_output", "board-no-output-model");
  installTeams(team);
  const created = createTeamBoardItem({
    teamId: team.id,
    title: "No output Board task",
    description: "Return no final output.",
  }, { statePath });

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.queueRuns[0]!.id];
  const task = state.tasks[created.queueTask.id];
  const boardItem = getTeamBoardItem(created.boardItem.id, { statePath });

  assert.ok(result.failedRunIds.includes(created.queueRuns[0]!.id));
  assert.equal(task?.status, "failed");
  assert.equal(run?.status, "failed");
  assert.equal(boardItem?.executionStatus, "blocked");
  assert.match(run?.error ?? "", /Lead did not emit|without assistant output/);
  assert.equal((task?.metadata?.queuedBoardResult as { finalStatus?: string } | undefined)?.finalStatus, "blocked");
}

async function smokeBoardWaitingDoesNotStartProviderTimeout(): Promise<void> {
  resetQueue();
  const teamA = makeTeam("team_board_wait_a", "shared-board-model");
  const teamB = makeTeam("team_board_wait_b", "shared-board-model");
  installTeams(teamA, teamB);
  const first = createTeamBoardItem({ teamId: teamA.id, title: "First Board task", priority: 90 }, { statePath });
  const second = createTeamBoardItem({ teamId: teamB.id, title: "Second Board task", priority: 80 }, { statePath });

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "<OV_FINAL>\nfirst board done\n</OV_FINAL>",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const waitingTurn = Object.values(state.turns).find((turn) => turn.runId === second.queueRuns[0]!.id);
  const waitingBoardItem = getTeamBoardItem(second.boardItem.id, { statePath });

  assert.ok(result.dispatchedRunIds.includes(first.queueRuns[0]!.id));
  assert.ok(result.waitingRunIds.includes(second.queueRuns[0]!.id));
  assert.equal(state.runs[second.queueRuns[0]!.id]?.status, "waiting_for_model");
  assert.equal(waitingBoardItem?.executionStatus, "waiting_for_model");
  assert.equal(waitingTurn?.providerStartedAt, undefined);
  assert.equal(waitingTurn?.executionTimeoutStartedAt, undefined);
}

await smokeBoardDispatchesThroughOrchestrator();
await smokeBoardNoOutputFailsWithDiagnostic();
await smokeBoardWaitingDoesNotStartProviderTimeout();

const finalState = loadTeamQueueState({ statePath, recoverStaleActive: false });

console.log(JSON.stringify({
  ok: true,
  statePath,
  taskCount: Object.keys(finalState.tasks).length,
  runCount: Object.keys(finalState.runs).length,
  turnCount: Object.keys(finalState.turns).length,
}, null, 2));
