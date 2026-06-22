import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { log } from "./utils.js";
import {
  appendOrchestratorEvent,
  createMessageOrchestration,
  finishOrchestratorRun,
  startOrchestratorRun,
} from "./orchestratorRunStore.js";
import { CODER_ROLE_PROMPT, LEAD_ROLE_PROMPT, REVIEWER_ROLE_PROMPT } from "./rolePrompts.js";
import { getCoordinatorMember, normalizeTeamRole } from "./teamRoles.js";
import type { TeamConfig, TeamMember, TeamMessageOrchestration } from "./types.js";

const MAX_CYCLES = 3;
const MAX_TASKS_PER_CYCLE = 2;

export interface DelegationTask {
  to: string;
  task: string;
  expected_summary: string;
}

export interface DelegationResult {
  to: string;
  task: string;
  status: "completed" | "blocked" | "failed";
  resultBlock: string;
  fullResponse: string;
  error?: string;
}

export interface TeamOrchestratorState {
  runId: string;
  teamId: string;
  userText: string;
  leadName?: string;
  lastLeadResponse?: string;
  finalText?: string;
  pendingTasks?: DelegationTask[];
  results?: DelegationResult[];
  cycles: number;
  invalidDelegationAttempts: number;
  parseError?: string;
  decision?: "final" | "delegate" | "invalid" | "fallback" | "force_final";
  fallbackText?: string;
}

interface SessionCompletion {
  status: "idle" | "failed" | "cancelled" | "interrupted";
  responseText: string;
  errorText?: string;
  diagnosticsSummary?: string;
}

interface OrchestratorRuntime {
  team: TeamConfig;
  userText: string;
  invokeMember: (member: TeamMember, prompt: string) => Promise<SessionCompletion>;
  writeFinalMessage: (fromName: string, finalText: string, orchestration?: TeamMessageOrchestration) => void;
  summarizePlan: (memberName: string) => string;
  summarizeBoard: (memberName: string) => string;
}

export interface RunTeamOrchestratorInput extends OrchestratorRuntime {}

const runtimes = new Map<string, OrchestratorRuntime>();
let runCounter = 0;

const OrchestratorAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  teamId: Annotation<string>(),
  userText: Annotation<string>(),
  leadName: Annotation<string | undefined>(),
  lastLeadResponse: Annotation<string | undefined>(),
  finalText: Annotation<string | undefined>(),
  pendingTasks: Annotation<DelegationTask[] | undefined>(),
  results: Annotation<DelegationResult[] | undefined>(),
  cycles: Annotation<number>(),
  invalidDelegationAttempts: Annotation<number>(),
  parseError: Annotation<string | undefined>(),
  decision: Annotation<TeamOrchestratorState["decision"] | undefined>(),
  fallbackText: Annotation<string | undefined>(),
});

function runtimeFor(state: TeamOrchestratorState): OrchestratorRuntime {
  const runtime = runtimes.get(state.runId);
  if (!runtime) {
    throw new Error(`Missing team orchestrator runtime for ${state.runId}`);
  }
  return runtime;
}

function getCoordinator(team: TeamConfig): TeamMember | undefined {
  return getCoordinatorMember(team);
}

function getMember(team: TeamConfig, name: string): TeamMember | undefined {
  return team.members.find((member) => member.name === name);
}

function getRoleExecutionGuidance(role: TeamMember["role"]): string {
  switch (normalizeTeamRole(role)) {
    case "coder":
      return CODER_ROLE_PROMPT;
    case "reviewer":
      return REVIEWER_ROLE_PROMPT;
    case "planner":
      return "You are the planner. Coordinate work and delegate bounded tasks through OV_DELEGATE.";
    case "lead":
      return "Follow the canonical Lead role definition below.";
    case "scribe":
      return "You are the scribe. Capture decisions, summarize delegated work, and provide compact written synthesis.";
    case "tester":
      return "You are the tester. Validate behavior, run focused checks when useful, and report pass/fail status and risks.";
    case "visual":
      return "You are the visual specialist. Focus on UI quality, interaction details, and visible regressions.";
    case "visual_reviewer":
      return "You are the visual reviewer. Review UI changes for layout, clarity, polish, and visible regressions.";
    default:
      return "";
  }
}

function getDelegatedRolePrompt(role: TeamMember["role"]): string {
  switch (normalizeTeamRole(role)) {
    case "coder":
      return CODER_ROLE_PROMPT;
    case "reviewer":
      return REVIEWER_ROLE_PROMPT;
    default:
      return "";
  }
}

function extractTaggedBlock(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function parseFinalBlock(text: string): string | null {
  return extractTaggedBlock(text, "OV_FINAL");
}

export function parseDelegateBlock(text: string): DelegationTask[] | null {
  const block = extractTaggedBlock(text, "OV_DELEGATE");
  if (!block) return null;

  const parsed = JSON.parse(block) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("OV_DELEGATE must contain a JSON array");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`OV_DELEGATE task ${index + 1} must be an object`);
    }
    const task = item as Record<string, unknown>;
    const to = typeof task.to === "string" ? task.to.trim() : "";
    const taskText = typeof task.task === "string" ? task.task.trim() : "";
    const expectedSummary = typeof task.expected_summary === "string" ? task.expected_summary.trim() : "";
    if (!to || !taskText || !expectedSummary) {
      throw new Error(`OV_DELEGATE task ${index + 1} requires to, task, and expected_summary`);
    }
    return { to, task: taskText, expected_summary: expectedSummary };
  });
}

export function parseResultBlock(text: string): string | null {
  const block = extractTaggedBlock(text, "OV_RESULT");
  if (!block) return null;
  return `<OV_RESULT>\n${block}\n</OV_RESULT>`;
}

export function buildLeadInitialPrompt(
  team: TeamConfig,
  lead: TeamMember,
  userText: string,
  summarizePlan: (memberName: string) => string,
  summarizeBoard: (memberName: string) => string,
): string {
  const roster = team.members
    .map((member) => `- ${member.name} (${member.role}, ${member.tool}${member.model ? `, ${member.model}` : ""})`)
    .join("\n");

  return [
    `You are ${lead.name}, the ${lead.role} for OpenVide team "${team.name}".`,
    getRoleExecutionGuidance(lead.role),
    "",
    "Lead role definition:",
    LEAD_ROLE_PROMPT,
    "",
    `Working directory: ${team.workingDirectory}`,
    "",
    "You are participating in daemon-side Team Chat orchestration.",
    "You may answer directly only when no other member needs to run.",
    "If another member should do work, do not simulate that member. Emit an OV_DELEGATE block and the daemon will invoke the selected member session directly.",
    "",
    "Team roster:",
    roster,
    "",
    summarizePlan(lead.name),
    "",
    summarizeBoard(lead.name),
    "",
    "User objective:",
    userText,
    "",
    "Choose exactly one response format.",
    "",
    "Final answer format:",
    "<OV_FINAL>",
    "Final answer to the user here.",
    "</OV_FINAL>",
    "",
    "Delegation format:",
    "<OV_DELEGATE>",
    "[",
    "{\"to\":\"ExactMemberName\",\"task\":\"Bounded task for this member.\",\"expected_summary\":\"What this member must report back.\"}",
    "]",
    "</OV_DELEGATE>",
    "",
    `Limits: at most ${MAX_TASKS_PER_CYCLE} delegated tasks in this cycle. Keep delegated tasks bounded.`,
  ].join("\n");
}

export function buildLeadReviewPrompt(results: DelegationResult[]): string {
  const resultText = results
    .map((result) => [
      `Result from ${result.to}:`,
      result.resultBlock,
      result.error ? `Error: ${result.error}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  return [
    "Lead role definition:",
    LEAD_ROLE_PROMPT,
    "",
    "The following delegated tasks have completed.",
    "",
    "<OV_DELEGATION_RESULTS>",
    resultText,
    "</OV_DELEGATION_RESULTS>",
    "",
    "Based on these results, either:",
    "1. emit another <OV_DELEGATE> block for one more bounded delegation cycle, or",
    "2. emit an <OV_FINAL> block with the final user-facing answer.",
    "",
    "Do not pretend to call agents yourself. If more work is needed, emit OV_DELEGATE. If enough information is available, emit OV_FINAL.",
  ].join("\n");
}

export function buildDelegatedTaskPrompt(team: TeamConfig, member: TeamMember, task: DelegationTask): string {
  const delegatedRolePrompt = getDelegatedRolePrompt(member.role);
  return [
    `You are the OpenVide Team member named: ${member.name}.`,
    `Your role is: ${member.role}.`,
    `You are working in: ${team.workingDirectory}.`,
    "",
    delegatedRolePrompt,
    "",
    "The Lead delegated this bounded task to you.",
    "",
    "<TASK>",
    task.task,
    "</TASK>",
    "",
    "Expected summary:",
    task.expected_summary,
    "",
    "Rules:",
    "* Complete only this delegated task.",
    "* Do not delegate to another agent.",
    "* Do not continue into unrelated work.",
    "* Do not ask the user for information already present in the team context.",
    "* Do not edit files unless the delegated task explicitly allows edits.",
    "* If you edit files, list every file changed.",
    "* End your response with exactly one result block.",
    "",
    "Required result format:",
    "",
    "<OV_RESULT>",
    "status: completed | blocked | failed",
    "summary:",
    "files_changed:",
    "tests_run:",
    "risks:",
    "recommended_next_step:",
    "</OV_RESULT>",
  ].filter((line, index, lines) => line || lines[index - 1]).join("\n");
}

function buildRepairPrompt(parseError: string, leadText: string): string {
  return [
    "Lead role definition:",
    LEAD_ROLE_PROMPT,
    "",
    "Your previous Team Chat orchestration response could not be parsed.",
    "",
    `Parse error: ${parseError}`,
    "",
    "Previous response:",
    leadText,
    "",
    "Emit exactly one valid response now:",
    "",
    "<OV_FINAL>",
    "Final answer to the user here.",
    "</OV_FINAL>",
    "",
    "or",
    "",
    "<OV_DELEGATE>",
    "[{\"to\":\"ExactMemberName\",\"task\":\"Bounded task.\",\"expected_summary\":\"Expected summary.\"}]",
    "</OV_DELEGATE>",
    "",
    "Do not include markdown fences around the JSON.",
  ].join("\n");
}

function buildForceFinalPrompt(): string {
  return [
    "Lead role definition:",
    LEAD_ROLE_PROMPT,
    "",
    `The daemon-side Team Chat orchestrator has reached maxCycles=${MAX_CYCLES}.`,
    "You must now emit a final user-facing answer.",
    "",
    "<OV_FINAL>",
    "Concise final answer based on the work completed and any remaining limitations.",
    "</OV_FINAL>",
  ].join("\n");
}

function blockedResult(to: string, task: string, summary: string): DelegationResult {
  const resultBlock = [
    "<OV_RESULT>",
    "status: blocked",
    `summary: ${summary}`,
    "files_changed:",
    "tests_run:",
    "risks:",
    "recommended_next_step: Lead should choose another available member or answer with current information.",
    "</OV_RESULT>",
  ].join("\n");
  return { to, task, status: "blocked", resultBlock, fullResponse: resultBlock, error: summary };
}

function failedResult(to: string, task: string, summary: string): DelegationResult {
  const resultBlock = [
    "<OV_RESULT>",
    "status: failed",
    `summary: ${summary}`,
    "files_changed:",
    "tests_run:",
    "risks:",
    "recommended_next_step: Lead should account for this failure in the final answer or delegate a recovery task.",
    "</OV_RESULT>",
  ].join("\n");
  return { to, task, status: "failed", resultBlock, fullResponse: resultBlock, error: summary };
}

function synthesizeResultBlock(status: DelegationResult["status"], summary: string): string {
  return [
    "<OV_RESULT>",
    `status: ${status}`,
    "summary:",
    summary || "No structured result was returned.",
    "files_changed:",
    "tests_run:",
    "risks:",
    "recommended_next_step:",
    "</OV_RESULT>",
  ].join("\n");
}

function summarizeText(text: string, max = 260): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function resultSummary(resultBlock: string): string {
  const match = resultBlock.match(/summary:\s*([\s\S]*?)(?:\n[a-z_]+:|<\/OV_RESULT>)/i);
  return summarizeText(match?.[1] ?? resultBlock);
}

function completionText(completion: SessionCompletion): string {
  return (completion.status === "idle" ? completion.responseText : completion.errorText ?? completion.responseText).trim();
}

function completionSummary(text: string, completion: SessionCompletion): string {
  const diagnostics = completion.diagnosticsSummary ? `Diagnostics: ${completion.diagnosticsSummary}` : "";
  return [text, diagnostics].filter(Boolean).join("\n");
}

function eventMember(member: TeamMember): Pick<import("./orchestratorRunStore.js").OrchestratorRunEvent, "memberName" | "role" | "tool" | "model"> {
  return {
    memberName: member.name,
    role: normalizeTeamRole(member.role),
    tool: member.tool,
    model: member.model,
  };
}

export function getTeamOrchestratorStatus(): { available: boolean; enabled: boolean; provider: "langgraph"; runStore: boolean } {
  return {
    available: true,
    enabled: true,
    provider: "langgraph",
    runStore: true,
  };
}

async function leadTurn(state: TeamOrchestratorState): Promise<Partial<TeamOrchestratorState>> {
  const runtime = runtimeFor(state);
  const lead = getCoordinator(runtime.team);
  if (!lead) {
    return {
      decision: "fallback",
      fallbackText: "Team orchestration could not start because this team has no members.",
    };
  }

  log(`team.orchestrator.lead team=${runtime.team.id} lead=${lead.name} cycle=${state.cycles}`);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_started",
    ...eventMember(lead),
    status: "started",
    summary: state.cycles === 0 ? "Initial lead turn started." : "Lead turn started.",
  });
  const startedAt = Date.now();
  const completion = await runtime.invokeMember(
    lead,
    buildLeadInitialPrompt(runtime.team, lead, runtime.userText, runtime.summarizePlan, runtime.summarizeBoard),
  );
  const response = completionText(completion);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_completed",
    ...eventMember(lead),
    status: completion.status === "idle" ? "completed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: completionSummary(response || `Lead turn ended with status ${completion.status}.`, completion),
    diagnostics: completion.diagnosticsSummary,
  });
  if (completion.status !== "idle") {
    return {
      leadName: lead.name,
      decision: "fallback",
      fallbackText: response || `Lead session failed with status ${completion.status}.`,
    };
  }
  return { leadName: lead.name, lastLeadResponse: response };
}

async function leadRepairTurn(state: TeamOrchestratorState): Promise<Partial<TeamOrchestratorState>> {
  const runtime = runtimeFor(state);
  const lead = getCoordinator(runtime.team);
  if (!lead) {
    return { decision: "fallback", fallbackText: "No Lead is available to repair the delegation response." };
  }

  log(`team.orchestrator.error team=${runtime.team.id} reason=invalid_delegate repair=1`);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_started",
    ...eventMember(lead),
    status: "started",
    summary: "Lead repair turn started after invalid delegation output.",
  });
  const startedAt = Date.now();
  const completion = await runtime.invokeMember(
    lead,
    buildRepairPrompt(state.parseError ?? "Invalid OV_DELEGATE JSON", state.lastLeadResponse ?? ""),
  );
  const response = completionText(completion);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_completed",
    ...eventMember(lead),
    status: completion.status === "idle" ? "completed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: completionSummary(response || `Lead repair ended with status ${completion.status}.`, completion),
    diagnostics: completion.diagnosticsSummary,
  });
  return {
    lastLeadResponse: response || state.lastLeadResponse,
    invalidDelegationAttempts: state.invalidDelegationAttempts + 1,
  };
}

function routeLeadDecision(state: TeamOrchestratorState): Partial<TeamOrchestratorState> {
  const leadText = state.lastLeadResponse ?? "";
  const finalText = parseFinalBlock(leadText);
  if (finalText) {
    return { decision: "final", finalText };
  }

  try {
    const tasks = parseDelegateBlock(leadText);
    if (tasks) {
      if (state.cycles >= MAX_CYCLES) {
        return { decision: "force_final", pendingTasks: undefined };
      }
      return { decision: "delegate", pendingTasks: tasks.slice(0, MAX_TASKS_PER_CYCLE), parseError: undefined };
    }
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    if (state.invalidDelegationAttempts < 1) {
      return { decision: "invalid", parseError };
    }
    return {
      decision: "fallback",
      parseError,
      fallbackText: leadText || `Lead emitted invalid OV_DELEGATE JSON: ${parseError}`,
    };
  }

  return {
    decision: "fallback",
    fallbackText: leadText || "Lead did not emit OV_FINAL or OV_DELEGATE.",
  };
}

async function runDelegations(state: TeamOrchestratorState): Promise<Partial<TeamOrchestratorState>> {
  const runtime = runtimeFor(state);
  const tasks = (state.pendingTasks ?? []).slice(0, MAX_TASKS_PER_CYCLE);
  const results: DelegationResult[] = [];

  for (const task of tasks) {
    log(`team.orchestrator.delegate team=${runtime.team.id} to=${task.to}`);
    const member = getMember(runtime.team, task.to);
    appendOrchestratorEvent(state.runId, {
      teamId: runtime.team.id,
      type: "delegation_created",
      memberName: task.to,
      role: member ? normalizeTeamRole(member.role) : undefined,
      tool: member?.tool,
      model: member?.model,
      status: "started",
      summary: task.expected_summary || task.task,
    });
    if (!member) {
      const result = blockedResult(task.to, task.task, `Unknown team member: ${task.to}`);
      results.push(result);
      appendOrchestratorEvent(state.runId, {
        teamId: runtime.team.id,
        type: "member_turn_completed",
        memberName: task.to,
        status: "blocked",
        summary: resultSummary(result.resultBlock),
      });
      continue;
    }

    appendOrchestratorEvent(state.runId, {
      teamId: runtime.team.id,
      type: "member_turn_started",
      ...eventMember(member),
      status: "started",
      summary: task.expected_summary || task.task,
    });
    const startedAt = Date.now();
    const completion = await runtime.invokeMember(member, buildDelegatedTaskPrompt(runtime.team, member, task));
    const raw = completionText(completion);
    if (completion.status !== "idle") {
      const status = raw.toLowerCase().includes("already running") || raw.toLowerCase().includes(" is running")
        ? "blocked"
        : "failed";
      const result = status === "blocked"
        ? blockedResult(task.to, task.task, raw || `Session for ${task.to} is busy`)
        : failedResult(task.to, task.task, raw || `${task.to} failed with status ${completion.status}`);
      results.push(result);
      appendOrchestratorEvent(state.runId, {
        teamId: runtime.team.id,
        type: "member_turn_completed",
        ...eventMember(member),
        status,
        durationMs: Date.now() - startedAt,
        summary: completionSummary(resultSummary(result.resultBlock), completion),
        diagnostics: completion.diagnosticsSummary,
      });
      continue;
    }

    const resultBlock = parseResultBlock(raw) ?? synthesizeResultBlock("completed", raw);
    const result: DelegationResult = {
      to: task.to,
      task: task.task,
      status: resultBlock.toLowerCase().includes("status: failed")
        ? "failed"
        : resultBlock.toLowerCase().includes("status: blocked")
          ? "blocked"
          : "completed",
      resultBlock,
      fullResponse: raw,
    };
    results.push(result);
    appendOrchestratorEvent(state.runId, {
      teamId: runtime.team.id,
      type: "member_turn_completed",
      ...eventMember(member),
      status: result.status,
      durationMs: Date.now() - startedAt,
      summary: completionSummary(resultSummary(result.resultBlock), completion),
      diagnostics: completion.diagnosticsSummary,
    });
    log(`team.orchestrator.result team=${runtime.team.id} from=${task.to}`);
  }

  return {
    results,
    cycles: state.cycles + 1,
    pendingTasks: undefined,
  };
}

async function leadReviewTurn(state: TeamOrchestratorState): Promise<Partial<TeamOrchestratorState>> {
  const runtime = runtimeFor(state);
  const lead = getCoordinator(runtime.team);
  if (!lead) {
    return { decision: "fallback", fallbackText: "No Lead is available to review delegation results." };
  }

  log(`team.orchestrator.lead team=${runtime.team.id} lead=${lead.name} reviewCycle=${state.cycles}`);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_review_started",
    ...eventMember(lead),
    status: "started",
    summary: "Lead review started after delegated member results.",
  });
  const startedAt = Date.now();
  const completion = await runtime.invokeMember(lead, buildLeadReviewPrompt(state.results ?? []));
  const response = completionText(completion);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_completed",
    ...eventMember(lead),
    status: completion.status === "idle" ? "completed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: completionSummary(response || `Lead review ended with status ${completion.status}.`, completion),
    diagnostics: completion.diagnosticsSummary,
  });
  if (completion.status !== "idle") {
    return {
      decision: "fallback",
      fallbackText: response || `Lead review turn failed with status ${completion.status}.`,
    };
  }
  return { lastLeadResponse: response };
}

async function forceFinal(state: TeamOrchestratorState): Promise<Partial<TeamOrchestratorState>> {
  const runtime = runtimeFor(state);
  const lead = getCoordinator(runtime.team);
  if (!lead) {
    return { fallbackText: "Team orchestration hit maxCycles and no Lead is available for a final answer." };
  }

  log(`team.orchestrator.error team=${runtime.team.id} reason=max_cycles`);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "orchestrator_error",
    ...eventMember(lead),
    status: "blocked",
    summary: `Reached maxCycles=${MAX_CYCLES}.`,
  });
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_started",
    ...eventMember(lead),
    status: "started",
    summary: "Forced final lead turn started.",
  });
  const startedAt = Date.now();
  const completion = await runtime.invokeMember(lead, buildForceFinalPrompt());
  const response = completionText(completion);
  appendOrchestratorEvent(state.runId, {
    teamId: runtime.team.id,
    type: "lead_turn_completed",
    ...eventMember(lead),
    status: completion.status === "idle" ? "completed" : "failed",
    durationMs: Date.now() - startedAt,
    summary: completionSummary(response || `Forced final lead turn ended with status ${completion.status}.`, completion),
    diagnostics: completion.diagnosticsSummary,
  });
  const finalText = parseFinalBlock(response);
  if (finalText) {
    return { finalText, decision: "final" };
  }

  return {
    fallbackText: [
      "Team orchestration reached the maximum delegation cycles.",
      response ? `Lead response: ${response}` : "The Lead did not produce an OV_FINAL response.",
    ].join("\n"),
  };
}

function routeAfterDecision(state: TeamOrchestratorState): string {
  return state.decision ?? "fallback";
}

function routeAfterReview(state: TeamOrchestratorState): string {
  return state.decision ?? "fallback";
}

const graph = new StateGraph(OrchestratorAnnotation)
  .addNode("leadTurn", leadTurn)
  .addNode("routeLeadDecision", routeLeadDecision)
  .addNode("runDelegations", runDelegations)
  .addNode("leadReviewTurn", leadReviewTurn)
  .addNode("leadRepairTurn", leadRepairTurn)
  .addNode("forceFinal", forceFinal)
  .addEdge(START, "leadTurn")
  .addEdge("leadTurn", "routeLeadDecision")
  .addConditionalEdges("routeLeadDecision", routeAfterDecision, {
    final: END,
    delegate: "runDelegations",
    invalid: "leadRepairTurn",
    fallback: END,
    force_final: "forceFinal",
  })
  .addEdge("leadRepairTurn", "routeLeadDecision")
  .addEdge("runDelegations", "leadReviewTurn")
  .addEdge("leadReviewTurn", "routeLeadDecision")
  .addConditionalEdges("forceFinal", routeAfterReview, {
    final: END,
    fallback: END,
    delegate: END,
    invalid: END,
    force_final: END,
  })
  .compile();

export async function runTeamOrchestrator(input: RunTeamOrchestratorInput): Promise<void> {
  const lead = getCoordinator(input.team);
  const runId = `team_orch_${Date.now()}_${++runCounter}`;
  runtimes.set(runId, input);
  startOrchestratorRun({ runId, teamId: input.team.id, leadName: lead?.name });
  appendOrchestratorEvent(runId, {
    teamId: input.team.id,
    type: "orchestrator_start",
    memberName: lead?.name,
    role: lead ? normalizeTeamRole(lead.role) : undefined,
    tool: lead?.tool,
    model: lead?.model,
    status: "started",
    summary: `Team orchestrator started for ${input.team.name}.`,
  });
  log(`team.orchestrator.start team=${input.team.id} lead=${lead?.name ?? "none"}`);

  try {
    const finalState = await graph.invoke({
      runId,
      teamId: input.team.id,
      userText: input.userText,
      leadName: lead?.name,
      cycles: 0,
      invalidDelegationAttempts: 0,
    }) as TeamOrchestratorState;

    const finalText = finalState.finalText ?? finalState.fallbackText;
    if (!finalText) {
      log(`team.orchestrator.error team=${input.team.id} reason=no_final`);
      appendOrchestratorEvent(runId, {
        teamId: input.team.id,
        type: "orchestrator_error",
        memberName: lead?.name,
        role: lead ? normalizeTeamRole(lead.role) : undefined,
        tool: lead?.tool,
        model: lead?.model,
        status: "failed",
        summary: "Team orchestration ended without a final answer.",
      });
      finishOrchestratorRun(runId, "failed", "Team orchestration ended without a final answer.");
      input.writeFinalMessage(
        lead?.name ?? "Lead",
        "Team orchestration ended without a final answer.",
        createMessageOrchestration(runId),
      );
      return;
    }

    log(`team.orchestrator.final team=${input.team.id} lead=${lead?.name ?? "Lead"}`);
    appendOrchestratorEvent(runId, {
      teamId: input.team.id,
      type: "final_created",
      memberName: lead?.name ?? "Lead",
      role: lead ? normalizeTeamRole(lead.role) : "lead",
      tool: lead?.tool,
      model: lead?.model,
      status: finalState.fallbackText && !finalState.finalText ? "blocked" : "completed",
      summary: finalText,
    });
    finishOrchestratorRun(
      runId,
      finalState.fallbackText && !finalState.finalText ? "blocked" : "completed",
      finalText,
    );
    input.writeFinalMessage(lead?.name ?? "Lead", finalText, createMessageOrchestration(runId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "TeamQueueDispatchPause") {
      log(`team.orchestrator.pause team=${input.team.id} reason=${message}`);
      appendOrchestratorEvent(runId, {
        teamId: input.team.id,
        type: "orchestrator_error",
        memberName: lead?.name,
        role: lead ? normalizeTeamRole(lead.role) : undefined,
        tool: lead?.tool,
        model: lead?.model,
        status: "blocked",
        summary: message,
      });
      finishOrchestratorRun(runId, "blocked", message);
      throw err;
    }
    log(`team.orchestrator.error team=${input.team.id} reason=exception error=${message}`);
    appendOrchestratorEvent(runId, {
      teamId: input.team.id,
      type: "orchestrator_error",
      memberName: lead?.name,
      role: lead ? normalizeTeamRole(lead.role) : undefined,
      tool: lead?.tool,
      model: lead?.model,
      status: "failed",
      summary: message,
    });
    finishOrchestratorRun(runId, "failed", message);
    input.writeFinalMessage(lead?.name ?? "Lead", `Team orchestration failed: ${message}`, createMessageOrchestration(runId));
  } finally {
    runtimes.delete(runId);
  }
}
