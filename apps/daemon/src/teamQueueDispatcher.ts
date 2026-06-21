import {
  acquireResource,
  listResourceStatus,
  modelResourceKey,
  releaseResource,
} from "./modelResourceScheduler.js";
import {
  getTeamQueueStatePath,
  getTeamQueueStatus,
  loadTeamQueueState,
  compareQueueItems,
  updateTeamQueueState,
  type TeamQueueStoreOptions,
} from "./teamQueueStore.js";
import type {
  TeamQueueDispatchEvent,
  TeamQueueDispatchEventType,
  TeamQueueDispatchResult,
  TeamQueueRun,
  TeamQueueState,
  TeamQueueTask,
  TeamQueueTurn,
} from "./teamQueueTypes.js";
import * as tm from "./teamManager.js";
import { getCoordinatorMember } from "./teamRoles.js";
import type { TeamConfig, TeamMember } from "./types.js";
import { newId, nowISO } from "./utils.js";

const DISPATCHABLE_RUN_STATUSES = new Set(["queued", "waiting_for_team_slot", "waiting_for_model"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);

function isDeletedRecord(record: { deletedAt?: string; visibility?: string }): boolean {
  return Boolean(record.deletedAt) || record.visibility === "deleted";
}

class TeamQueueDispatchPause extends Error {
  constructor(
    message: string,
    readonly reason: "team_slot" | "model",
  ) {
    super(message);
    this.name = "TeamQueueDispatchPause";
  }
}

interface QueuedMemberExecutorInput {
  task: TeamQueueTask;
  run: TeamQueueRun;
  turn: TeamQueueTurn;
  member: TeamMember;
  prompt: string;
  team: TeamConfig;
}

export interface TeamQueueDispatcherOptions extends TeamQueueStoreOptions {
  getTeam?: (teamId: string) => TeamConfig | undefined;
  executeMember?: (input: QueuedMemberExecutorInput) => Promise<tm.TeamMemberTurnCompletion>;
  persistChatMessages?: boolean;
}

interface DispatchContext {
  options?: TeamQueueDispatcherOptions;
  events: TeamQueueDispatchEvent[];
}

interface FirstMemberResolution {
  team?: TeamConfig;
  member?: TeamMember;
  resourceKey?: string;
  reason?: string;
}

function activeOptions(options?: TeamQueueDispatcherOptions): TeamQueueStoreOptions {
  return { ...options, recoverStaleActive: false };
}

function eventRecord(
  type: TeamQueueDispatchEventType,
  fields: Omit<TeamQueueDispatchEvent, "id" | "type" | "timestamp">,
): TeamQueueDispatchEvent {
  return {
    ...fields,
    id: newId("queue_event"),
    type,
    timestamp: nowISO(),
  };
}

function appendRunEvent(
  state: TeamQueueState,
  event: TeamQueueDispatchEvent,
): void {
  const run = event.runId ? state.runs[event.runId] : undefined;
  if (!run) return;
  const existing = Array.isArray(run.metadata?.queueEvents)
    ? run.metadata.queueEvents as TeamQueueDispatchEvent[]
    : [];
  run.metadata = {
    ...(run.metadata ?? {}),
    queueEvents: [...existing, event].slice(-100),
  };
  run.updatedAt = event.timestamp;
}

function recordEvent(ctx: DispatchContext, event: TeamQueueDispatchEvent): void {
  ctx.events.push(event);
  updateTeamQueueState((state) => {
    appendRunEvent(state, event);
  }, activeOptions(ctx.options));
}

function setRunWaiting(
  ctx: DispatchContext,
  run: TeamQueueRun,
  status: "waiting_for_team_slot" | "waiting_for_model",
  reason: string,
  eventType: "run_waiting_for_team_slot" | "member_waiting_for_model",
  turn?: TeamQueueTurn,
): void {
  const timestamp = nowISO();
  const event = eventRecord(eventType, {
    teamId: run.teamId,
    taskId: run.taskId,
    runId: run.id,
    turnId: turn?.id,
    memberName: turn?.memberName,
    resourceKey: turn?.resourceKey,
    status,
    reason,
  });
  ctx.events.push(event);
  updateTeamQueueState((state) => {
    const currentRun = state.runs[run.id];
    if (currentRun && !TERMINAL_RUN_STATUSES.has(currentRun.status) && !isDeletedRecord(currentRun)) {
      currentRun.status = status;
      currentRun.currentState = status;
      currentRun.currentMember = turn?.memberName ?? currentRun.currentMember;
      currentRun.currentTurnId = turn?.id ?? currentRun.currentTurnId;
      currentRun.error = undefined;
      currentRun.updatedAt = timestamp;
      currentRun.metadata = {
        ...(currentRun.metadata ?? {}),
        dispatchBlockedReason: reason,
      };
    }
    if (turn) {
      const currentTurn = state.turns[turn.id];
      if (currentTurn && !TERMINAL_TURN_STATUSES.has(currentTurn.status) && !isDeletedRecord(currentTurn)) {
        currentTurn.status = status;
        currentTurn.providerStartedAt = undefined;
        currentTurn.executionTimeoutStartedAt = undefined;
        currentTurn.metadata = {
          ...(currentTurn.metadata ?? {}),
          dispatchBlockedReason: reason,
        };
      }
    }
    appendRunEvent(state, event);
  }, activeOptions(ctx.options));
}

function sortedDispatchableRuns(state: TeamQueueState): Array<{ task: TeamQueueTask; run: TeamQueueRun }> {
  return Object.values(state.runs)
    .map((run) => ({ run, task: state.tasks[run.taskId] }))
    .filter((item): item is { task: TeamQueueTask; run: TeamQueueRun } => Boolean(item.task))
    .filter(({ task, run }) => {
      if (isDeletedRecord(task) || isDeletedRecord(run)) return false;
      if (TERMINAL_TASK_STATUSES.has(task.status)) return false;
      if (task.source === "board" && typeof task.metadata?.board === "object") {
        const board = task.metadata.board as { executionStatus?: unknown };
        if (board.executionStatus === "draft" || board.executionStatus === "blocked") return false;
      }
      return DISPATCHABLE_RUN_STATUSES.has(run.status);
    })
    .sort(compareQueueItems);
}

function teamHasActiveRun(state: TeamQueueState, teamId: string, exceptRunId?: string): boolean {
  return Object.values(state.runs).some((run) => {
    return run.teamId === teamId && run.id !== exceptRunId && !isDeletedRecord(run) && run.status === "running";
  });
}

function existingOpenTurn(state: TeamQueueState, run: TeamQueueRun, member: TeamMember): TeamQueueTurn | undefined {
  return run.turnIds
    .map((turnId) => state.turns[turnId])
    .find((turn) => turn
      && turn.memberName === member.name
      && !TERMINAL_TURN_STATUSES.has(turn.status));
}

function createOrReuseTurn(
  run: TeamQueueRun,
  task: TeamQueueTask,
  member: TeamMember,
  options?: TeamQueueDispatcherOptions,
): TeamQueueTurn {
  const resourceKey = modelResourceKey(member.tool, member.model);
  const state = updateTeamQueueState((draft) => {
    const currentRun = draft.runs[run.id];
    if (!currentRun || isDeletedRecord(currentRun)) return;
    const existing = existingOpenTurn(draft, currentRun, member);
    if (existing) {
      existing.resourceKey = resourceKey;
      existing.provider = member.tool;
      existing.model = member.model;
      return;
    }

    const turn: TeamQueueTurn = {
      id: newId("queue_turn"),
      teamId: run.teamId,
      taskId: task.id,
      runId: run.id,
      memberName: member.name,
      role: member.role,
      provider: member.tool,
      model: member.model,
      resourceKey,
      status: "queued",
      queuedAt: nowISO(),
    };
    draft.turns[turn.id] = turn;
    currentRun.turnIds.push(turn.id);
    currentRun.updatedAt = turn.queuedAt;
  }, activeOptions(options));

  const currentRun = state.runs[run.id] ?? run;
  const turn = existingOpenTurn(state, currentRun, member);
  if (!turn) throw new Error(`Failed to create queue turn for ${member.name}`);
  return turn;
}

function resolveFirstMember(
  task: TeamQueueTask,
  run: TeamQueueRun,
  getTeam: (teamId: string) => TeamConfig | undefined,
): FirstMemberResolution {
  const team = getTeam(run.teamId);
  if (!team) return { reason: `Team ${run.teamId} not found` };

  if (task.source === "chat") {
    const from = typeof task.metadata?.from === "string" ? task.metadata.from : "user";
    const to = typeof task.metadata?.to === "string" ? task.metadata.to : "*";
    if (from !== "user" || to !== "*") {
      return { team, reason: "Queued Chat dispatch currently supports user-to-team messages only" };
    }
    const member = getCoordinatorMember(team);
    if (!member) return { team, reason: `Team ${run.teamId} has no coordinator member` };
    return { team, member, resourceKey: modelResourceKey(member.tool, member.model) };
  }

  if (task.source === "plan") {
    return { team, reason: "Plan queue dispatch is waiting for a scheduler-safe plan-generation adapter" };
  }

  if (task.source === "board" || task.source === "manual") {
    if (run.route.length === 0) {
      return { team, reason: "Board/manual queue dispatch is waiting for an assigned member route" };
    }
    return { team, reason: "Board/manual queue dispatch is waiting for a scheduler-safe board task adapter" };
  }

  return { team, reason: `Queue source ${task.source} has no dispatcher adapter yet` };
}

function markHandoff(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  reason: string,
): void {
  updateTeamQueueState((state) => {
    const currentTask = state.tasks[task.id];
    const currentRun = state.runs[run.id];
    const timestamp = nowISO();
    if (currentTask && currentTask.status !== "cancelled" && !isDeletedRecord(currentTask)) {
      currentTask.status = "queued";
      currentTask.updatedAt = timestamp;
      currentTask.metadata = {
        ...(currentTask.metadata ?? {}),
        dispatchBlockedReason: reason,
      };
    }
    if (currentRun && !TERMINAL_RUN_STATUSES.has(currentRun.status) && !isDeletedRecord(currentRun)) {
      currentRun.status = "queued";
      currentRun.currentState = "queued";
      currentRun.updatedAt = timestamp;
      currentRun.metadata = {
        ...(currentRun.metadata ?? {}),
        dispatchBlockedReason: reason,
      };
    }
  }, activeOptions(ctx.options));
}

function markPlannedResourceWait(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  member: TeamMember,
  resourceKey: string,
  reason: string,
): void {
  const turn = createOrReuseTurn(run, task, member, ctx.options);
  updateTeamQueueState((state) => {
    const resource = state.resources[resourceKey];
    if (resource && !resource.queuedTurnIds.includes(turn.id)) {
      resource.queuedTurnIds.push(turn.id);
      resource.updatedAt = nowISO();
    }
  }, activeOptions(ctx.options));
  setRunWaiting(ctx, run, "waiting_for_model", reason, "member_waiting_for_model", turn);
}

function summarizeDiagnostics(result: tm.TeamMemberTurnCompletion): string | undefined {
  return result.diagnosticsSummary;
}

function trimResultText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function queuedChatFailureSummary(result: tm.QueuedTeamChatResult | undefined): string | undefined {
  const status = result?.assistant?.orchestration?.status;
  if (status === "failed") return trimResultText(result?.assistant?.text) ?? "Queued Team Chat failed without assistant output.";
  if (status === "blocked") return trimResultText(result?.assistant?.text) ?? "Queued Team Chat blocked without assistant output.";
  if (!trimResultText(result?.assistant?.text)) return "Queued Team Chat completed without assistant output.";
  return undefined;
}

function persistQueuedChatResult(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  result: tm.QueuedTeamChatResult | undefined,
): string | undefined {
  const assistant = result?.assistant;
  const orchestration = assistant?.orchestration;
  const assistantText = trimResultText(assistant?.text);
  const route = orchestration?.route ?? [];
  const finalStatus = orchestration?.status ?? (assistantText ? "completed" : "failed");
  const latestTimelineEntry = orchestration?.timeline?.slice().reverse().find((entry) => entry.memberName || entry.tool || entry.model);
  const diagnostic = queuedChatFailureSummary(result);

  updateTeamQueueState((state) => {
    const currentRun = state.runs[run.id];
    const currentTask = state.tasks[task.id];
    const timestamp = nowISO();
    const resultMetadata = {
      assistantText,
      route,
      routeSummary: orchestration?.routeSummary,
      provider: latestTimelineEntry?.tool,
      model: latestTimelineEntry?.model,
      memberName: assistant?.from ?? latestTimelineEntry?.memberName,
      finalStatus,
      orchestrationRunId: orchestration?.runId,
      diagnostics: diagnostic ?? latestTimelineEntry?.diagnostics,
    };
    if (currentRun && !isDeletedRecord(currentRun)) {
      currentRun.route = route.length > 0 ? route : currentRun.route;
      currentRun.metadata = {
        ...(currentRun.metadata ?? {}),
        queuedChatResult: resultMetadata,
        assistantText,
        route,
        provider: resultMetadata.provider,
        model: resultMetadata.model,
        memberName: resultMetadata.memberName,
        finalStatus,
        orchestration,
        noOutputDiagnostic: assistantText ? undefined : diagnostic,
      };
      currentRun.error = finalStatus === "failed" || !assistantText ? diagnostic : currentRun.error;
      currentRun.updatedAt = timestamp;
    }
    if (currentTask && !isDeletedRecord(currentTask)) {
      currentTask.metadata = {
        ...(currentTask.metadata ?? {}),
        queuedChatResult: resultMetadata,
        assistantText,
        route,
        provider: resultMetadata.provider,
        model: resultMetadata.model,
        memberName: resultMetadata.memberName,
        finalStatus,
        orchestration,
        noOutputDiagnostic: assistantText ? undefined : diagnostic,
      };
      currentTask.updatedAt = timestamp;
    }
  }, activeOptions(ctx.options));

  return diagnostic;
}

async function defaultExecuteMember(input: QueuedMemberExecutorInput): Promise<tm.TeamMemberTurnCompletion> {
  return tm.invokeTeamMemberTurn(input.member, input.prompt, input.team.workingDirectory);
}

async function executeQueuedMemberTurn(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  team: TeamConfig,
  member: TeamMember,
  prompt: string,
): Promise<tm.TeamMemberTurnCompletion> {
  const turn = createOrReuseTurn(run, task, member, ctx.options);
  const acquire = acquireResource(turn.resourceKey, {
    turnId: turn.id,
    runId: run.id,
    teamId: run.teamId,
    taskId: task.id,
    memberName: member.name,
  }, activeOptions(ctx.options));

  if (acquire.status === "waiting") {
    setRunWaiting(
      ctx,
      run,
      "waiting_for_model",
      `Waiting for model resource ${turn.resourceKey}`,
      "member_waiting_for_model",
      turn,
    );
    throw new TeamQueueDispatchPause(`Waiting for model resource ${turn.resourceKey}`, "model");
  }

  if (acquire.status === "disabled") {
    throw new Error(`Model resource ${turn.resourceKey} is disabled`);
  }

  const acquiredEvent = eventRecord("model_resource_acquired", {
    teamId: run.teamId,
    taskId: task.id,
    runId: run.id,
    turnId: turn.id,
    memberName: member.name,
    resourceKey: turn.resourceKey,
    status: "reserved",
  });
  recordEvent(ctx, acquiredEvent);

  const startedAt = nowISO();
  updateTeamQueueState((state) => {
    const currentTurn = state.turns[turn.id];
    const shouldStartTurn = Boolean(currentTurn && !isDeletedRecord(currentTurn));
    if (currentTurn && !isDeletedRecord(currentTurn)) {
      currentTurn.status = "running";
      currentTurn.startedAt = currentTurn.startedAt ?? startedAt;
      currentTurn.providerStartedAt = startedAt;
      currentTurn.executionTimeoutStartedAt = startedAt;
      currentTurn.metadata = {
        ...(currentTurn.metadata ?? {}),
        promptLength: prompt.length,
      };
    }
    const currentResource = state.resources[turn.resourceKey];
    if (shouldStartTurn && currentResource && currentResource.status !== "disabled") {
      currentResource.status = "running";
      currentResource.activeTurnId = turn.id;
      currentResource.updatedAt = startedAt;
    }
  }, activeOptions(ctx.options));

  try {
    const executor = ctx.options?.executeMember ?? defaultExecuteMember;
    const result = await executor({ task, run, turn, member, prompt, team });
    const finishedAt = nowISO();
    updateTeamQueueState((state) => {
      const currentTurn = state.turns[turn.id];
      if (!currentTurn || isDeletedRecord(currentTurn)) return;
      currentTurn.status = result.status === "idle" ? "completed" : "failed";
      currentTurn.finishedAt = finishedAt;
      currentTurn.error = result.status === "idle" ? undefined : result.errorText ?? result.responseText;
      currentTurn.metadata = {
        ...(currentTurn.metadata ?? {}),
        diagnosticsSummary: summarizeDiagnostics(result),
      };
    }, activeOptions(ctx.options));
    return result;
  } catch (err) {
    const finishedAt = nowISO();
    updateTeamQueueState((state) => {
      const currentTurn = state.turns[turn.id];
      if (!currentTurn || isDeletedRecord(currentTurn)) return;
      currentTurn.status = "failed";
      currentTurn.finishedAt = finishedAt;
      currentTurn.error = err instanceof Error ? err.message : String(err);
    }, activeOptions(ctx.options));
    throw err;
  } finally {
    const released = releaseResource(turn.resourceKey, { turnId: turn.id, runId: run.id }, activeOptions(ctx.options));
    const releasedEvent = eventRecord("model_resource_released", {
      teamId: run.teamId,
      taskId: task.id,
      runId: run.id,
      turnId: turn.id,
      memberName: member.name,
      resourceKey: turn.resourceKey,
      status: released.status,
    });
    recordEvent(ctx, releasedEvent);
  }
}

function markRunStarted(ctx: DispatchContext, task: TeamQueueTask, run: TeamQueueRun): void {
  const timestamp = nowISO();
  const taskEvent = eventRecord("task_dispatch_started", {
    teamId: run.teamId,
    taskId: task.id,
    runId: run.id,
    status: task.status,
  });
  const runEvent = eventRecord("run_started", {
    teamId: run.teamId,
    taskId: task.id,
    runId: run.id,
    status: "running",
  });
  ctx.events.push(taskEvent, runEvent);
  updateTeamQueueState((state) => {
    const currentTask = state.tasks[task.id];
    if (currentTask && !isDeletedRecord(currentTask)) {
      currentTask.status = "running";
      currentTask.startedAt = currentTask.startedAt ?? timestamp;
      currentTask.updatedAt = timestamp;
    }
    const currentRun = state.runs[run.id];
    if (currentRun && !isDeletedRecord(currentRun)) {
      currentRun.status = "running";
      currentRun.currentState = "running";
      currentRun.startedAt = currentRun.startedAt ?? timestamp;
      currentRun.updatedAt = timestamp;
      currentRun.error = undefined;
    }
    appendRunEvent(state, taskEvent);
    appendRunEvent(state, runEvent);
  }, activeOptions(ctx.options));
}

function markRunFinished(
  ctx: DispatchContext,
  run: TeamQueueRun,
  status: "completed" | "failed",
  summary?: string,
): void {
  const timestamp = nowISO();
  const event = eventRecord(status === "completed" ? "run_completed" : "run_failed", {
    teamId: run.teamId,
    taskId: run.taskId,
    runId: run.id,
    status,
    summary,
    reason: status === "failed" ? summary : undefined,
  });
  ctx.events.push(event);
  updateTeamQueueState((state) => {
    const currentRun = state.runs[run.id];
    if (currentRun && !isDeletedRecord(currentRun)) {
      currentRun.status = status;
      currentRun.currentState = status;
      currentRun.currentMember = undefined;
      currentRun.currentTurnId = undefined;
      currentRun.finishedAt = timestamp;
      currentRun.updatedAt = timestamp;
      currentRun.error = status === "failed" ? summary : undefined;
    }
    const currentTask = state.tasks[run.taskId];
    if (currentTask && !isDeletedRecord(currentTask)) {
      currentTask.status = status;
      currentTask.finishedAt = timestamp;
      currentTask.updatedAt = timestamp;
    }
    appendRunEvent(state, event);
  }, activeOptions(ctx.options));
}

async function executeChatRun(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  team: TeamConfig,
): Promise<tm.QueuedTeamChatResult> {
  const from = typeof task.metadata?.from === "string" ? task.metadata.from : "user";
  const to = typeof task.metadata?.to === "string" ? task.metadata.to : "*";
  const text = task.description ?? task.title;
  return tm.runQueuedTeamChat({
    teamId: run.teamId,
    from,
    to,
    text,
    persistMessages: ctx.options?.persistChatMessages,
    invokeMember: (member, prompt) => executeQueuedMemberTurn(ctx, task, run, team, member, prompt),
  });
}

async function executeRun(
  ctx: DispatchContext,
  task: TeamQueueTask,
  run: TeamQueueRun,
  team: TeamConfig,
): Promise<"completed" | "waiting" | "failed"> {
  markRunStarted(ctx, task, run);
  try {
    if (task.source !== "chat") {
      throw new Error(`No executable dispatcher adapter for ${task.source}`);
    }
    const result = await executeChatRun(ctx, task, run, team);
    const diagnostic = persistQueuedChatResult(ctx, task, run, result);
    const finalStatus = result.assistant?.orchestration?.status;
    if (diagnostic || finalStatus === "failed" || finalStatus === "blocked") {
      markRunFinished(ctx, run, "failed", diagnostic ?? trimResultText(result.assistant?.text) ?? `Queued chat dispatch ended with status ${finalStatus}.`);
      return "failed";
    }
    markRunFinished(ctx, run, "completed", "Queued chat dispatch completed.");
    return "completed";
  } catch (err) {
    if (err instanceof TeamQueueDispatchPause) {
      return "waiting";
    }
    const summary = err instanceof Error ? err.message : String(err);
    markRunFinished(ctx, run, "failed", summary);
    return "failed";
  }
}

export async function dispatchTeamQueueOnce(options?: TeamQueueDispatcherOptions): Promise<TeamQueueDispatchResult> {
  const ctx: DispatchContext = { options, events: [] };
  const getTeam = options?.getTeam ?? tm.getTeam;
  const initialState = loadTeamQueueState(activeOptions(options));
  const candidates = sortedDispatchableRuns(initialState);
  const plannedTeams = new Set<string>();
  const plannedResources = new Set<string>();
  const dispatchedRunIds: string[] = [];
  const waitingRunIds: string[] = [];
  const failedRunIds: string[] = [];
  const skippedRunIds: string[] = [];
  const executions: Array<Promise<{ runId: string; status: "completed" | "waiting" | "failed" }>> = [];

  for (const { task, run } of candidates) {
    if (teamHasActiveRun(loadTeamQueueState(activeOptions(options)), run.teamId, run.id) || plannedTeams.has(run.teamId)) {
      setRunWaiting(ctx, run, "waiting_for_team_slot", `Team ${run.teamId} already has an active run`, "run_waiting_for_team_slot");
      waitingRunIds.push(run.id);
      continue;
    }

    const resolved = resolveFirstMember(task, run, getTeam);
    if (!resolved.team || !resolved.member || !resolved.resourceKey) {
      markHandoff(ctx, task, run, resolved.reason ?? "No dispatcher adapter is available");
      skippedRunIds.push(run.id);
      continue;
    }

    const resourceStatus = listResourceStatus(activeOptions(options)).resources.find((resource) => resource.key === resolved.resourceKey);
    if (
      plannedResources.has(resolved.resourceKey)
      || resourceStatus?.status === "running"
      || resourceStatus?.status === "reserved"
      || Boolean(resourceStatus?.activeTurnId)
    ) {
      markPlannedResourceWait(
        ctx,
        task,
        run,
        resolved.member,
        resolved.resourceKey,
        `Waiting for model resource ${resolved.resourceKey}`,
      );
      waitingRunIds.push(run.id);
      continue;
    }

    plannedTeams.add(run.teamId);
    plannedResources.add(resolved.resourceKey);
    dispatchedRunIds.push(run.id);
    executions.push(
      executeRun(ctx, task, run, resolved.team).then((status) => ({ runId: run.id, status })),
    );
  }

  const results = await Promise.all(executions);
  for (const result of results) {
    if (result.status === "waiting" && !waitingRunIds.includes(result.runId)) waitingRunIds.push(result.runId);
    if (result.status === "failed" && !failedRunIds.includes(result.runId)) failedRunIds.push(result.runId);
  }

  return {
    statePath: options?.statePath ?? getTeamQueueStatePath(),
    dispatchedRunIds,
    waitingRunIds,
    failedRunIds,
    skippedRunIds,
    events: ctx.events,
  };
}

export function getTeamQueueDispatchStatus(options?: TeamQueueDispatcherOptions): TeamQueueDispatchResult & {
  queueStatus: ReturnType<typeof getTeamQueueStatus>;
  resourceStatus: ReturnType<typeof listResourceStatus>;
} {
  const state = loadTeamQueueState(activeOptions(options));
  const dispatchable = sortedDispatchableRuns(state).map(({ run }) => run.id);
  return {
    statePath: options?.statePath ?? getTeamQueueStatePath(),
    dispatchedRunIds: [],
    waitingRunIds: dispatchable.filter((runId) => {
      const run = state.runs[runId];
      return run?.status === "waiting_for_model" || run?.status === "waiting_for_team_slot";
    }),
    failedRunIds: [],
    skippedRunIds: [],
    events: [],
    queueStatus: getTeamQueueStatus(undefined, options),
    resourceStatus: listResourceStatus(activeOptions(options)),
  };
}
