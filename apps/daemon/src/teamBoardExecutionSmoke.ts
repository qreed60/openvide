import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODER_ROLE_PROMPT, LEAD_ROLE_PROMPT, REVIEWER_ROLE_PROMPT } from "./rolePrompts.js";
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
  createTeamQueueTask,
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

function makeReviewerTeam(id: string, model: string): TeamConfig {
  const team = makeTeam(id, model);
  team.members.push({
    name: "Reviewer",
    tool: "codex",
    model,
    role: "reviewer",
    sessionId: `session_${id}_reviewer`,
  });
  return team;
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
  assert.equal((run?.metadata?.queuedBoardResult as { missing_ov_final_fallback?: boolean } | undefined)?.missing_ov_final_fallback, undefined);
  assert.ok(prompts.some((prompt) => prompt.includes("Board title: 10J board execution smoke")));
  assert.ok(prompts.some((prompt) => prompt.includes("Assigned member intent: Coder.")));
  assert.ok(prompts.some((prompt) => prompt.includes("Priority: 91")));
  assert.ok(prompts.some((prompt) => prompt.includes(LEAD_ROLE_PROMPT)));
  assert.ok(prompts.some((prompt) => prompt.includes("Do not simulate Coder, Reviewer, Scribe, Visual Reviewer, OpenHands, or OpenCode.")));
  assert.ok(prompts.some((prompt) => prompt.includes("You MUST end with OV_FINAL or OV_DELEGATE as defined in the Lead role definition.")));
  assert.ok(prompts.some((prompt) => prompt.includes("<OV_FINAL>\nFinal Board result summary here.\n</OV_FINAL>")));
  assert.ok(turn?.providerStartedAt);
  assert.ok(turn?.executionTimeoutStartedAt);
}

function smokeLeadRolePromptContract(): void {
  assert.ok(LEAD_ROLE_PROMPT.includes("You are Lead."));
  assert.ok(LEAD_ROLE_PROMPT.includes("Do not simulate Coder, Reviewer, Scribe, Visual Reviewer, OpenHands, or OpenCode."));
  assert.ok(LEAD_ROLE_PROMPT.includes("<OV_FINAL>"));
  assert.ok(LEAD_ROLE_PROMPT.includes("</OV_FINAL>"));
  assert.ok(LEAD_ROLE_PROMPT.includes("<OV_DELEGATE>"));
  assert.ok(LEAD_ROLE_PROMPT.includes("</OV_DELEGATE>"));
}

function smokeCoderRolePromptContract(): void {
  assert.ok(CODER_ROLE_PROMPT.includes("You are Coder."));
  assert.ok(CODER_ROLE_PROMPT.includes("Stay inside the assigned repository or worktree."));
  assert.ok(CODER_ROLE_PROMPT.includes("Run relevant validation commands when available and feasible."));
  assert.ok(CODER_ROLE_PROMPT.includes("Do not claim tests passed unless they actually ran."));
  assert.ok(CODER_ROLE_PROMPT.includes("Do not perform review, approval, QA sign-off, or final sign-off as Reviewer."));
}

function smokeReviewerRolePromptContract(): void {
  assert.ok(REVIEWER_ROLE_PROMPT.includes("You are Reviewer."));
  assert.ok(REVIEWER_ROLE_PROMPT.includes("Stay read-only unless the delegated task explicitly says to modify files."));
  assert.ok(REVIEWER_ROLE_PROMPT.includes("Do not claim validation passed unless validation output is present."));
  assert.ok(REVIEWER_ROLE_PROMPT.includes("Do not perform implementation as Coder."));
  assert.ok(REVIEWER_ROLE_PROMPT.includes("Do not act as Lead; return Reviewer findings and recommendation to Lead."));
  assert.ok(REVIEWER_ROLE_PROMPT.includes("If blocked by missing context, missing diffs, missing queue/run metadata, or missing validation output"));
}

async function smokeBoardLeadDelegatesToCoderWithRolePrompt(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_board_coder_delegate", "board-coder-model");
  installTeams(team);
  const created = createTeamBoardItem({
    teamId: team.id,
    title: "10J Coder role delegation smoke",
    description: "Ask Coder to inspect code and report without editing files.",
    assignedMembers: ["Coder"],
    priority: 92,
    createdBy: "smoke",
  }, { statePath });
  const prompts: string[] = [];

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async ({ member, prompt }) => {
      prompts.push(prompt);
      if (member.name === "Lead" && prompt.includes("Board title: 10J Coder role delegation smoke")) {
        return {
          status: "idle",
          responseText: [
            "<OV_DELEGATE>",
            "[{\"to\":\"Coder\",\"task\":\"Inspect the delegated Board task and report that no file edits are required.\",\"expected_summary\":\"Coder reports files changed, validation, and blockers.\"}]",
            "</OV_DELEGATE>",
          ].join("\n"),
        };
      }
      if (member.name === "Coder") {
        assert.ok(prompt.includes(CODER_ROLE_PROMPT));
        return {
          status: "idle",
          responseText: [
            "<OV_RESULT>",
            "status: completed",
            "summary: inspected the task; no edits required.",
            "files_changed: none",
            "tests_run: not run; no code changes.",
            "risks: none",
            "recommended_next_step: Lead can finalize.",
            "</OV_RESULT>",
          ].join("\n"),
        };
      }
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nCoder reported no file edits were required.\n</OV_FINAL>",
      };
    },
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.queueRuns[0]!.id];
  const task = state.tasks[created.queueTask.id];
  const boardItem = getTeamBoardItem(created.boardItem.id, { statePath });

  assert.deepEqual(result.dispatchedRunIds, [created.queueRuns[0]!.id]);
  assert.equal(task?.status, "completed");
  assert.equal(run?.status, "completed");
  assert.equal(boardItem?.executionStatus, "completed");
  assert.equal(boardItem?.resultSummary, "Coder reported no file edits were required.");
  assert.deepEqual(boardItem?.resultRoute, ["Lead", "Coder", "Lead"]);
  assert.ok(prompts.some((prompt) => prompt.includes(LEAD_ROLE_PROMPT)));
  assert.ok(prompts.some((prompt) => prompt.includes(CODER_ROLE_PROMPT)));
  assert.ok(prompts.some((prompt) => prompt.includes("Do not perform review, approval, QA sign-off, or final sign-off as Reviewer.")));
}

async function smokeBoardLeadDelegatesToReviewerWithRolePrompt(): Promise<void> {
  resetQueue();
  const team = makeReviewerTeam("team_board_reviewer_delegate", "board-reviewer-model");
  installTeams(team);
  const created = createTeamBoardItem({
    teamId: team.id,
    title: "10J Reviewer role delegation smoke",
    description: "Ask Reviewer to inspect claimed validation evidence without editing files.",
    assignedMembers: ["Reviewer"],
    priority: 93,
    createdBy: "smoke",
  }, { statePath });
  const prompts: string[] = [];

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async ({ member, prompt }) => {
      prompts.push(prompt);
      if (member.name === "Lead" && prompt.includes("Board title: 10J Reviewer role delegation smoke")) {
        return {
          status: "idle",
          responseText: [
            "<OV_DELEGATE>",
            "[{\"to\":\"Reviewer\",\"task\":\"Review the delegated Board task and verify whether validation evidence is present. Do not edit files.\",\"expected_summary\":\"Reviewer reports findings, risks, validation evidence, and recommendation.\"}]",
            "</OV_DELEGATE>",
          ].join("\n"),
        };
      }
      if (member.name === "Reviewer") {
        assert.ok(prompt.includes(REVIEWER_ROLE_PROMPT));
        assert.ok(prompt.includes("Stay read-only unless the delegated task explicitly says to modify files."));
        return {
          status: "idle",
          responseText: [
            "<OV_RESULT>",
            "status: completed",
            "summary: no validation output was present, so validation cannot be confirmed.",
            "files_changed: none",
            "tests_run: not run; review-only delegation and no validation output was provided.",
            "risks: claimed validation would be unsupported without output.",
            "recommended_next_step: Lead should report validation as missing evidence.",
            "</OV_RESULT>",
          ].join("\n"),
        };
      }
      return {
        status: "idle",
        responseText: "<OV_FINAL>\nReviewer found missing validation evidence and no file edits were made.\n</OV_FINAL>",
      };
    },
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.queueRuns[0]!.id];
  const task = state.tasks[created.queueTask.id];
  const boardItem = getTeamBoardItem(created.boardItem.id, { statePath });

  assert.deepEqual(result.dispatchedRunIds, [created.queueRuns[0]!.id]);
  assert.equal(task?.status, "completed");
  assert.equal(run?.status, "completed");
  assert.equal(boardItem?.executionStatus, "completed");
  assert.equal(boardItem?.resultSummary, "Reviewer found missing validation evidence and no file edits were made.");
  assert.deepEqual(boardItem?.resultRoute, ["Lead", "Reviewer", "Lead"]);
  assert.ok(prompts.some((prompt) => prompt.includes(LEAD_ROLE_PROMPT)));
  assert.ok(prompts.some((prompt) => prompt.includes(REVIEWER_ROLE_PROMPT)));
  assert.ok(prompts.some((prompt) => prompt.includes("Do not perform implementation as Coder.")));
}

async function smokeBoardUnstructuredLeadOutputCompletesWithFallback(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_board_fallback", "board-fallback-model");
  installTeams(team);
  const created = createTeamBoardItem({
    teamId: team.id,
    title: "10J board fallback smoke",
    description: "Reply with exactly BOARD_FALLBACK_OK. Do not edit files.",
    priority: 88,
    createdBy: "smoke",
  }, { statePath });

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "BOARD_FALLBACK_OK",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.queueRuns[0]!.id];
  const task = state.tasks[created.queueTask.id];
  const boardItem = getTeamBoardItem(created.boardItem.id, { statePath });
  const queuedBoardResult = run?.metadata?.queuedBoardResult as {
    assistantText?: string;
    finalStatus?: string;
    missing_ov_final_fallback?: boolean;
    fallbackReason?: string;
    originalParserError?: string;
    diagnostics?: string;
    provider?: string;
    model?: string;
  } | undefined;
  const taskBoardResult = task?.metadata?.queuedBoardResult as {
    assistantText?: string;
    missing_ov_final_fallback?: boolean;
    fallbackReason?: string;
    originalParserError?: string;
  } | undefined;
  const boardMetadata = task?.metadata?.board as {
    resultSummary?: string;
    resultStatus?: string;
    resultDiagnostics?: string;
    missing_ov_final_fallback?: boolean;
    fallbackReason?: string;
    originalParserError?: string;
  } | undefined;

  assert.deepEqual(result.dispatchedRunIds, [created.queueRuns[0]!.id]);
  assert.equal(result.failedRunIds.includes(created.queueRuns[0]!.id), false);
  assert.equal(task?.status, "completed");
  assert.equal(run?.status, "completed");
  assert.equal(boardItem?.executionStatus, "completed");
  assert.equal(boardItem?.resultSummary, "BOARD_FALLBACK_OK");
  assert.equal(boardItem?.resultStatus, "completed");
  assert.equal(boardItem?.resultDiagnostics, "Board completed from unstructured Lead output after missing OV_FINAL/OV_DELEGATE.");
  assert.equal(queuedBoardResult?.assistantText, "BOARD_FALLBACK_OK");
  assert.equal(queuedBoardResult?.finalStatus, "completed");
  assert.equal(queuedBoardResult?.provider, "codex");
  assert.equal(queuedBoardResult?.model, "board-fallback-model");
  assert.equal(queuedBoardResult?.missing_ov_final_fallback, true);
  assert.equal(queuedBoardResult?.fallbackReason, "board_unstructured_final");
  assert.equal(queuedBoardResult?.originalParserError, "Lead did not emit OV_FINAL or OV_DELEGATE.");
  assert.equal(taskBoardResult?.assistantText, "BOARD_FALLBACK_OK");
  assert.equal(taskBoardResult?.missing_ov_final_fallback, true);
  assert.equal(taskBoardResult?.fallbackReason, "board_unstructured_final");
  assert.equal(taskBoardResult?.originalParserError, "Lead did not emit OV_FINAL or OV_DELEGATE.");
  assert.equal(boardMetadata?.resultSummary, "BOARD_FALLBACK_OK");
  assert.equal(boardMetadata?.missing_ov_final_fallback, true);
  assert.equal(boardMetadata?.fallbackReason, "board_unstructured_final");
  assert.equal(boardMetadata?.originalParserError, "Lead did not emit OV_FINAL or OV_DELEGATE.");
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
  assert.equal((task?.metadata?.queuedBoardResult as { missing_ov_final_fallback?: boolean } | undefined)?.missing_ov_final_fallback, undefined);
}

async function smokeQueuedChatUnstructuredLeadOutputStillFails(): Promise<void> {
  resetQueue();
  const team = makeTeam("team_chat_strict", "chat-strict-model");
  installTeams(team);
  const created = createTeamQueueTask({
    teamId: team.id,
    source: "chat",
    title: "Queued Chat strict parser smoke",
    description: "Reply with exactly CHAT_RAW_OK.",
    metadata: {
      from: "user",
      to: "*",
      clientMessageId: "chat_strict_smoke",
    },
  }, { statePath });

  const result = await dispatchTeamQueueOnce({
    statePath,
    persistChatMessages: false,
    executeMember: async () => ({
      status: "idle",
      responseText: "CHAT_RAW_OK",
    }),
  });

  const state = loadTeamQueueState({ statePath, recoverStaleActive: false });
  const run = state.runs[created.run.id];
  const task = state.tasks[created.task.id];

  assert.ok(result.failedRunIds.includes(created.run.id));
  assert.equal(task?.status, "failed");
  assert.equal(run?.status, "failed");
  assert.equal(run?.metadata?.assistantText, "CHAT_RAW_OK");
  assert.equal(run?.metadata?.finalStatus, "blocked");
  assert.equal(run?.metadata?.fallbackReason, undefined);
  assert.equal((run?.metadata?.queuedBoardResult as { fallbackReason?: string } | undefined)?.fallbackReason, undefined);
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

smokeLeadRolePromptContract();
smokeCoderRolePromptContract();
smokeReviewerRolePromptContract();
await smokeBoardDispatchesThroughOrchestrator();
await smokeBoardLeadDelegatesToCoderWithRolePrompt();
await smokeBoardLeadDelegatesToReviewerWithRolePrompt();
await smokeBoardUnstructuredLeadOutputCompletesWithFallback();
await smokeBoardNoOutputFailsWithDiagnostic();
await smokeQueuedChatUnstructuredLeadOutputStillFails();
await smokeBoardWaitingDoesNotStartProviderTimeout();

const finalState = loadTeamQueueState({ statePath, recoverStaleActive: false });

console.log(JSON.stringify({
  ok: true,
  statePath,
  taskCount: Object.keys(finalState.tasks).length,
  runCount: Object.keys(finalState.runs).length,
  turnCount: Object.keys(finalState.turns).length,
}, null, 2));
