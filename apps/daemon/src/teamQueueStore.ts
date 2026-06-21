import * as fs from "node:fs";
import * as path from "node:path";
import { daemonDir, newId, nowISO } from "./utils.js";
import type {
  CreateTeamQueueTaskInput,
  DeleteTeamQueueItemInput,
  DeleteTeamQueueItemResult,
  TeamQueueResource,
  TeamQueueResourceStatus,
  TeamQueueRun,
  TeamQueueRunStatus,
  TeamQueueState,
  TeamQueueStatusSummary,
  TeamQueueTask,
  TeamQueueTaskSource,
  TeamQueueTaskStatus,
  TeamQueueTurn,
  TeamQueueTurnStatus,
  UpdateTeamQueuePriorityInput,
  UpdateTeamQueuePriorityResult,
} from "./teamQueueTypes.js";

const QUEUE_STATE_FILE = "team-queue.json";

export interface TeamQueueStoreOptions {
  statePath?: string;
  recoverStaleActive?: boolean;
  includeDeleted?: boolean;
}

export function getTeamQueueStatePath(): string {
  return path.join(daemonDir(), QUEUE_STATE_FILE);
}

function queueStatePath(options?: TeamQueueStoreOptions): string {
  return options?.statePath ?? getTeamQueueStatePath();
}

function emptyQueueState(now = nowISO()): TeamQueueState {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    tasks: {},
    runs: {},
    turns: {},
    resources: {},
  };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function normalizeState(raw: Partial<TeamQueueState> | null): TeamQueueState {
  if (!raw || raw.version !== 1) return emptyQueueState();
  return {
    version: 1,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowISO(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowISO(),
    tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {},
    runs: raw.runs && typeof raw.runs === "object" ? raw.runs : {},
    turns: raw.turns && typeof raw.turns === "object" ? raw.turns : {},
    resources: raw.resources && typeof raw.resources === "object" ? raw.resources : {},
  };
}

function isRunningRun(run: TeamQueueRun): boolean {
  return run.status === "running" || run.currentState === "running";
}

function isRunningTurn(turn: TeamQueueTurn): boolean {
  return turn.status === "running";
}

function isDeletedRecord(record: { deletedAt?: string; visibility?: string }): boolean {
  return Boolean(record.deletedAt) || record.visibility === "deleted";
}

const DEFAULT_QUEUE_PRIORITY = 50;
const QUEUE_ORDER_STEP = 1000;
const REORDERABLE_TASK_STATUSES = new Set<TeamQueueTaskStatus>(["queued", "ready"]);
const REORDERABLE_RUN_STATUSES = new Set<TeamQueueRunStatus>([
  "queued",
  "waiting_for_team_slot",
  "waiting_for_model",
]);

export function queuePriority(task?: Pick<TeamQueueTask, "priority">, run?: Pick<TeamQueueRun, "priority" | "metadata">): number {
  const taskPriority = task?.priority;
  if (typeof taskPriority === "number" && Number.isFinite(taskPriority)) return taskPriority;
  const runPriority = run?.priority;
  if (typeof runPriority === "number" && Number.isFinite(runPriority)) return runPriority;
  const metadataPriority = run?.metadata?.priority;
  return typeof metadataPriority === "number" && Number.isFinite(metadataPriority)
    ? metadataPriority
    : DEFAULT_QUEUE_PRIORITY;
}

function timestampOrder(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function queueOrderValue(task?: Pick<TeamQueueTask, "queueOrder" | "createdAt">, run?: Pick<TeamQueueRun, "queueOrder" | "createdAt">): number {
  const taskOrder = task?.queueOrder;
  if (typeof taskOrder === "number" && Number.isFinite(taskOrder)) return taskOrder;
  const runOrder = run?.queueOrder;
  if (typeof runOrder === "number" && Number.isFinite(runOrder)) return runOrder;
  return timestampOrder(task?.createdAt ?? run?.createdAt);
}

export function compareQueueItems(
  left: { task?: TeamQueueTask; run: TeamQueueRun },
  right: { task?: TeamQueueTask; run: TeamQueueRun },
): number {
  const priorityDiff = queuePriority(right.task, right.run) - queuePriority(left.task, left.run);
  if (priorityDiff !== 0) return priorityDiff;
  const orderDiff = queueOrderValue(left.task, left.run) - queueOrderValue(right.task, right.run);
  if (orderDiff !== 0) return orderDiff;
  return (left.task?.createdAt ?? left.run.createdAt).localeCompare(right.task?.createdAt ?? right.run.createdAt);
}

export function queueItemReorderBlockedReason(task: TeamQueueTask | undefined, run: TeamQueueRun | undefined): string | undefined {
  if (!run) return "Queue run not found";
  if (!task) return "Queue task not found";
  if (isDeletedRecord(task) || isDeletedRecord(run)) return "Queue item is deleted";
  if (task.source === "board" && typeof task.metadata?.board === "object") {
    const board = task.metadata.board as { executionStatus?: unknown };
    if (board.executionStatus === "draft") return "Queue item is draft";
  }
  if (!REORDERABLE_TASK_STATUSES.has(task.status)) return `Queue task status ${task.status} cannot be reordered`;
  if (!REORDERABLE_RUN_STATUSES.has(run.status)) return `Queue run status ${run.status} cannot be reordered`;
  return undefined;
}

export function isQueueItemReorderable(task: TeamQueueTask | undefined, run: TeamQueueRun | undefined): boolean {
  return queueItemReorderBlockedReason(task, run) === undefined;
}

function recoverStaleActiveState(state: TeamQueueState): { state: TeamQueueState; changed: boolean } {
  const recoveredAt = nowISO();
  let changed = false;

  for (const turn of Object.values(state.turns)) {
    if (!isRunningTurn(turn)) continue;
    turn.status = "interrupted";
    turn.finishedAt = turn.finishedAt ?? recoveredAt;
    turn.error = turn.error ?? "Interrupted by daemon restart";
    changed = true;
  }

  for (const run of Object.values(state.runs)) {
    if (!isRunningRun(run)) continue;
    run.status = "interrupted";
    run.currentState = "interrupted";
    run.currentMember = undefined;
    run.currentTurnId = undefined;
    run.finishedAt = run.finishedAt ?? recoveredAt;
    run.error = run.error ?? "Interrupted by daemon restart";
    changed = true;
  }

  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running") continue;
    const taskRuns = task.runIds.map((runId) => state.runs[runId]).filter(Boolean);
    if (taskRuns.length > 0 && taskRuns.every((run) => run.status === "interrupted")) {
      task.status = "interrupted";
      task.finishedAt = task.finishedAt ?? recoveredAt;
      task.updatedAt = recoveredAt;
      changed = true;
    }
  }

  for (const resource of Object.values(state.resources)) {
    if (!resource.activeTurnId) continue;
    resource.activeTurnId = undefined;
    const { owner: _owner, ...metadata } = resource.metadata ?? {};
    resource.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    if (resource.status === "running" || resource.status === "reserved") {
      resource.status = "available";
    }
    resource.updatedAt = recoveredAt;
    changed = true;
  }

  if (changed) {
    state.updatedAt = recoveredAt;
  }
  return { state, changed };
}

export function loadTeamQueueState(options?: TeamQueueStoreOptions): TeamQueueState {
  const statePath = queueStatePath(options);
  const state = normalizeState(readJson<Partial<TeamQueueState>>(statePath));
  if (options?.recoverStaleActive === false) return state;
  const recovered = recoverStaleActiveState(state);
  if (recovered.changed) saveTeamQueueState(recovered.state, { statePath, recoverStaleActive: false });
  return recovered.state;
}

export function saveTeamQueueState(state: TeamQueueState, options?: TeamQueueStoreOptions): TeamQueueState {
  const next: TeamQueueState = {
    ...state,
    version: 1,
    updatedAt: nowISO(),
  };
  writeJson(queueStatePath(options), next);
  return next;
}

export function updateTeamQueueState(
  updater: (state: TeamQueueState) => TeamQueueState | void,
  options?: TeamQueueStoreOptions,
): TeamQueueState {
  const state = loadTeamQueueState(options);
  const updated = updater(state) ?? state;
  return saveTeamQueueState(updated, options);
}

export function upsertTeamQueueTask(task: TeamQueueTask, options?: TeamQueueStoreOptions): TeamQueueState {
  return updateTeamQueueState((state) => {
    state.tasks[task.id] = task;
  }, options);
}

export function upsertTeamQueueRun(run: TeamQueueRun, options?: TeamQueueStoreOptions): TeamQueueState {
  return updateTeamQueueState((state) => {
    state.runs[run.id] = run;
    const task = state.tasks[run.taskId];
    if (task && !task.runIds.includes(run.id)) {
      task.runIds.push(run.id);
      task.updatedAt = nowISO();
    }
  }, options);
}

export function upsertTeamQueueTurn(turn: TeamQueueTurn, options?: TeamQueueStoreOptions): TeamQueueState {
  return updateTeamQueueState((state) => {
    state.turns[turn.id] = turn;
    const run = state.runs[turn.runId];
    if (run && !run.turnIds.includes(turn.id)) {
      run.turnIds.push(turn.id);
      run.updatedAt = nowISO();
    }
  }, options);
}

export function upsertTeamQueueResource(resource: TeamQueueResource, options?: TeamQueueStoreOptions): TeamQueueState {
  return updateTeamQueueState((state) => {
    state.resources[resource.key] = resource;
  }, options);
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function cleanMembers(value: string[] | undefined): string[] {
  return Array.isArray(value)
    ? value.map((member) => member.trim()).filter((member) => member.length > 0)
    : [];
}

export function createTeamQueueTask(
  input: CreateTeamQueueTaskInput,
  options?: TeamQueueStoreOptions,
): { task: TeamQueueTask; run: TeamQueueRun; state: TeamQueueState } {
  const teamId = cleanString(input.teamId);
  const title = cleanString(input.title);
  if (!teamId || !title) {
    throw new Error("Missing required: teamId, title");
  }

  const now = nowISO();
  const taskId = newId("queue_task");
  const runId = newId("queue_run");
  const route = cleanMembers(input.assignedMemberNames);
  const priority = typeof input.priority === "number" && Number.isFinite(input.priority)
    ? input.priority
    : DEFAULT_QUEUE_PRIORITY;
  const queueOrder = timestampOrder(now);

  const task: TeamQueueTask = {
    id: taskId,
    teamId,
    source: input.source,
    status: "queued",
    title,
    description: cleanString(input.description),
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    createdBy: cleanString(input.createdBy),
    sourceRef: input.sourceRef,
    runIds: [runId],
    priority,
    queueOrder,
    metadata: input.metadata,
  };

  const run: TeamQueueRun = {
    id: runId,
    teamId,
    taskId,
    status: "queued",
    route,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    attempt: 1,
    turnIds: [],
    priority,
    queueOrder,
    metadata: {
      source: input.source,
      priority,
      queueOrder,
      ...(input.metadata ?? {}),
    },
  };

  const state = updateTeamQueueState((draft) => {
    draft.tasks[task.id] = task;
    draft.runs[run.id] = run;
  }, options);

  return { task: state.tasks[task.id] ?? task, run: state.runs[run.id] ?? run, state };
}

export function listTeamQueueTasks(teamId?: string, options?: TeamQueueStoreOptions): TeamQueueTask[] {
  return Object.values(loadTeamQueueState(options).tasks)
    .filter((task) => belongsToTeam(task, teamId))
    .filter((task) => options?.includeDeleted || !isDeletedRecord(task))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTeamQueueTask(taskId: string, options?: TeamQueueStoreOptions): TeamQueueTask | undefined {
  return loadTeamQueueState(options).tasks[taskId];
}

export function cancelTeamQueueTask(
  taskId: string,
  options?: TeamQueueStoreOptions,
): { task?: TeamQueueTask; runs: TeamQueueRun[]; state: TeamQueueState } {
  const state = updateTeamQueueState((draft) => {
    const task = draft.tasks[taskId];
    if (!task) return;
    const now = nowISO();
    if (task.status === "queued" || task.status === "ready") {
      task.status = "cancelled";
      task.finishedAt = task.finishedAt ?? now;
    }
    task.updatedAt = now;
    for (const runId of task.runIds) {
      const run = draft.runs[runId];
      if (!run) continue;
      if (run.status === "queued" || run.status === "waiting_for_team_slot" || run.status === "waiting_for_model") {
        run.status = "cancelled";
        run.currentState = "cancelled";
        run.finishedAt = run.finishedAt ?? now;
      }
      run.updatedAt = now;
    }
  }, options);
  const task = state.tasks[taskId];
  const runs = task ? task.runIds.map((runId) => state.runs[runId]).filter(Boolean) : [];
  return { task, runs, state };
}

function cleanDeleteReason(value: string | undefined): string | undefined {
  return cleanString(value)?.slice(0, 500);
}

function runBelongsToTask(run: TeamQueueRun, task: TeamQueueTask): boolean {
  return run.taskId === task.id || task.runIds.includes(run.id);
}

function taskHasRunningWork(state: TeamQueueState, task: TeamQueueTask): boolean {
  if (task.status === "running") return true;
  const linkedRunIds = new Set(task.runIds);
  for (const run of Object.values(state.runs)) {
    if (!runBelongsToTask(run, task)) continue;
    if (isRunningRun(run)) return true;
    linkedRunIds.add(run.id);
  }
  for (const turn of Object.values(state.turns)) {
    if (turn.taskId === task.id || linkedRunIds.has(turn.runId)) {
      if (isRunningTurn(turn)) return true;
    }
  }
  return false;
}

function terminalizeDeletedTask(state: TeamQueueState, task: TeamQueueTask, deletedAt: string): TeamQueueRun[] {
  const linkedRuns = Object.values(state.runs)
    .filter((run) => runBelongsToTask(run, task))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const linkedRunIds = new Set(linkedRuns.map((run) => run.id));
  for (const runId of task.runIds) linkedRunIds.add(runId);

  if (task.status === "queued" || task.status === "ready") {
    task.status = "cancelled";
    task.finishedAt = task.finishedAt ?? deletedAt;
  }
  task.updatedAt = deletedAt;

  for (const run of linkedRuns) {
    if (run.status === "queued" || run.status === "waiting_for_team_slot" || run.status === "waiting_for_model") {
      run.status = "cancelled";
      run.currentState = "cancelled";
      run.currentMember = undefined;
      run.currentTurnId = undefined;
      run.finishedAt = run.finishedAt ?? deletedAt;
    }
    run.updatedAt = deletedAt;
  }

  for (const turn of Object.values(state.turns)) {
    if (turn.taskId !== task.id && !linkedRunIds.has(turn.runId)) continue;
    if (turn.status === "queued" || turn.status === "waiting_for_team_slot" || turn.status === "waiting_for_model") {
      turn.status = "cancelled";
      turn.finishedAt = turn.finishedAt ?? deletedAt;
    }
    turn.updatedAt = deletedAt;
  }

  return linkedRuns;
}

function detachDeletedTurnsFromNonRunningResources(state: TeamQueueState, task: TeamQueueTask, runIds: Set<string>, deletedAt: string): void {
  const deletedTurnIds = new Set(Object.values(state.turns)
    .filter((turn) => turn.taskId === task.id || runIds.has(turn.runId))
    .map((turn) => turn.id));
  for (const resource of Object.values(state.resources)) {
    const nextQueuedTurnIds = resource.queuedTurnIds.filter((turnId) => !deletedTurnIds.has(turnId));
    if (nextQueuedTurnIds.length !== resource.queuedTurnIds.length) {
      resource.queuedTurnIds = nextQueuedTurnIds;
      resource.updatedAt = deletedAt;
    }
    if (resource.status === "reserved" && resource.activeTurnId && deletedTurnIds.has(resource.activeTurnId)) {
      resource.status = "available";
      resource.activeTurnId = undefined;
      const { owner: _owner, ...metadata } = resource.metadata ?? {};
      resource.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
      resource.updatedAt = deletedAt;
    }
  }
}

export function deleteTeamQueueItem(
  input: DeleteTeamQueueItemInput,
  options?: TeamQueueStoreOptions,
): DeleteTeamQueueItemResult {
  const operationOptions: TeamQueueStoreOptions = { ...options, recoverStaleActive: false };
  const queueTaskId = cleanString(input.queueTaskId);
  const queueRunId = cleanString(input.queueRunId);
  const requestedTeamId = cleanString(input.teamId);
  const deletedBy = cleanString(input.deletedBy) ?? "user";
  const deleteReason = cleanDeleteReason(input.reason);
  if (!queueTaskId && !queueRunId) {
    return { ok: false, queueRunIds: [], state: loadTeamQueueState(operationOptions), error: "Missing required: queueTaskId or queueRunId" };
  }

  let result: Omit<DeleteTeamQueueItemResult, "state"> = { ok: false, queueRunIds: [] };
  const state = updateTeamQueueState((draft) => {
    const run = queueRunId ? draft.runs[queueRunId] : undefined;
    const task = queueTaskId ? draft.tasks[queueTaskId] : run ? draft.tasks[run.taskId] : undefined;
    if (!task) {
      result = {
        ok: false,
        queueRunIds: [],
        error: queueTaskId ? `Queue task ${queueTaskId} not found` : `Queue run ${queueRunId} not found`,
      };
      return;
    }
    if (requestedTeamId && task.teamId !== requestedTeamId) {
      result = { ok: false, queueRunIds: [], error: `Queue task ${task.id} does not belong to team ${requestedTeamId}` };
      return;
    }
    if (taskHasRunningWork(draft, task)) {
      result = { ok: false, queueTaskId: task.id, queueRunIds: [], error: `Queue task ${task.id} is running and cannot be deleted` };
      return;
    }

    const deletedAt = nowISO();
    const linkedRuns = terminalizeDeletedTask(draft, task, deletedAt);
    const linkedRunIds = new Set(linkedRuns.map((linkedRun) => linkedRun.id));
    for (const runId of task.runIds) linkedRunIds.add(runId);
    detachDeletedTurnsFromNonRunningResources(draft, task, linkedRunIds, deletedAt);

    task.visibility = "deleted";
    task.deletedAt = task.deletedAt ?? deletedAt;
    task.deletedBy = task.deletedBy ?? deletedBy;
    task.deleteReason = task.deleteReason ?? deleteReason;
    task.updatedAt = deletedAt;

    const deletedRunIds: string[] = [];
    for (const runId of linkedRunIds) {
      const linkedRun = draft.runs[runId];
      if (!linkedRun) continue;
      linkedRun.visibility = "deleted";
      linkedRun.deletedAt = linkedRun.deletedAt ?? deletedAt;
      linkedRun.deletedBy = linkedRun.deletedBy ?? deletedBy;
      linkedRun.deleteReason = linkedRun.deleteReason ?? deleteReason;
      linkedRun.updatedAt = deletedAt;
      deletedRunIds.push(linkedRun.id);
    }

    for (const turn of Object.values(draft.turns)) {
      if (turn.taskId !== task.id && !linkedRunIds.has(turn.runId)) continue;
      turn.visibility = "deleted";
      turn.deletedAt = turn.deletedAt ?? deletedAt;
      turn.deletedBy = turn.deletedBy ?? deletedBy;
      turn.deleteReason = turn.deleteReason ?? deleteReason;
      turn.updatedAt = deletedAt;
    }

    result = {
      ok: true,
      queueTaskId: task.id,
      queueRunIds: deletedRunIds.sort(),
      deletedAt,
    };
  }, operationOptions);

  return { ...result, state };
}

function linkedRunsForTask(state: TeamQueueState, task: TeamQueueTask): TeamQueueRun[] {
  const linked = new Map<string, TeamQueueRun>();
  for (const run of Object.values(state.runs)) {
    if (runBelongsToTask(run, task)) linked.set(run.id, run);
  }
  for (const runId of task.runIds) {
    const run = state.runs[runId];
    if (run) linked.set(run.id, run);
  }
  return [...linked.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function peerQueueOrdersForPriority(state: TeamQueueState, priority: number, excludeTaskId: string): number[] {
  return Object.values(state.tasks)
    .filter((task) => task.id !== excludeTaskId)
    .flatMap((task) => linkedRunsForTask(state, task).map((run) => ({ task, run })))
    .filter(({ task, run }) => isQueueItemReorderable(task, run))
    .filter(({ task, run }) => queuePriority(task, run) === priority)
    .map(({ task, run }) => queueOrderValue(task, run));
}

function syncTaskPriorityToRuns(task: TeamQueueTask, runs: TeamQueueRun[], timestamp: string): void {
  for (const run of runs) {
    run.priority = task.priority;
    run.queueOrder = task.queueOrder;
    run.updatedAt = timestamp;
    run.metadata = {
      ...(run.metadata ?? {}),
      priority: task.priority,
      queueOrder: task.queueOrder,
    };
  }
}

export function updateTeamQueueItemPriority(
  input: UpdateTeamQueuePriorityInput,
  options?: TeamQueueStoreOptions,
): UpdateTeamQueuePriorityResult {
  const operationOptions: TeamQueueStoreOptions = { ...options, recoverStaleActive: false };
  const queueTaskId = cleanString(input.queueTaskId);
  const queueRunId = cleanString(input.queueRunId);
  const requestedTeamId = cleanString(input.teamId);
  const nextPriority = typeof input.priority === "number" && Number.isFinite(input.priority)
    ? input.priority
    : undefined;
  if (!queueTaskId && !queueRunId) {
    return { ok: false, queueRunIds: [], state: loadTeamQueueState(operationOptions), error: "Missing required: queueTaskId or queueRunId" };
  }
  if (nextPriority === undefined && !input.move) {
    return { ok: false, queueRunIds: [], state: loadTeamQueueState(operationOptions), error: "Missing required: priority or move" };
  }

  let result: Omit<UpdateTeamQueuePriorityResult, "state"> = { ok: false, queueRunIds: [] };
  const state = updateTeamQueueState((draft) => {
    const run = queueRunId ? draft.runs[queueRunId] : undefined;
    const task = queueTaskId ? draft.tasks[queueTaskId] : run ? draft.tasks[run.taskId] : undefined;
    const primaryRun = run ?? (task ? linkedRunsForTask(draft, task)[0] : undefined);
    if (!task || !primaryRun) {
      result = {
        ok: false,
        queueRunIds: [],
        error: queueTaskId ? `Queue task ${queueTaskId} not found` : `Queue run ${queueRunId} not found`,
      };
      return;
    }
    if (requestedTeamId && task.teamId !== requestedTeamId) {
      result = { ok: false, queueRunIds: [], error: `Queue task ${task.id} does not belong to team ${requestedTeamId}` };
      return;
    }
    const blockedReason = queueItemReorderBlockedReason(task, primaryRun);
    if (blockedReason) {
      result = { ok: false, queueTaskId: task.id, queueRunIds: [primaryRun.id], error: blockedReason };
      return;
    }

    const timestamp = nowISO();
    task.priority = nextPriority ?? queuePriority(task, primaryRun);
    if (input.move === "top" || input.move === "bottom") {
      const peerOrders = peerQueueOrdersForPriority(draft, task.priority, task.id);
      if (input.move === "top") {
        const minOrder = peerOrders.length > 0 ? Math.min(...peerOrders) : queueOrderValue(task, primaryRun);
        task.queueOrder = minOrder - QUEUE_ORDER_STEP;
      } else {
        const maxOrder = peerOrders.length > 0 ? Math.max(...peerOrders) : queueOrderValue(task, primaryRun);
        task.queueOrder = maxOrder + QUEUE_ORDER_STEP;
      }
    } else {
      task.queueOrder = queueOrderValue(task, primaryRun);
    }
    task.updatedAt = timestamp;
    task.metadata = {
      ...(task.metadata ?? {}),
      priority: task.priority,
      queueOrder: task.queueOrder,
    };

    const linkedRuns = linkedRunsForTask(draft, task);
    syncTaskPriorityToRuns(task, linkedRuns, timestamp);
    result = {
      ok: true,
      queueTaskId: task.id,
      queueRunIds: linkedRuns.map((linkedRun) => linkedRun.id).sort(),
      priority: task.priority,
      queueOrder: task.queueOrder,
    };
  }, operationOptions);

  return { ...result, state };
}

export function listTeamQueueRuns(teamId?: string, options?: TeamQueueStoreOptions): TeamQueueRun[] {
  return Object.values(loadTeamQueueState(options).runs)
    .filter((run) => belongsToTeam(run, teamId))
    .filter((run) => options?.includeDeleted || !isDeletedRecord(run))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTeamQueueRun(runId: string, options?: TeamQueueStoreOptions): TeamQueueRun | undefined {
  return loadTeamQueueState(options).runs[runId];
}

function increment<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function belongsToTeam(record: { teamId: string }, teamId?: string): boolean {
  return !teamId || record.teamId === teamId;
}

export function summarizeTeamQueueState(
  state: TeamQueueState,
  options?: { teamId?: string; statePath?: string },
): TeamQueueStatusSummary {
  const taskStatusCounts: Partial<Record<TeamQueueTaskStatus, number>> = {};
  const taskSourceCounts: Partial<Record<TeamQueueTaskSource, number>> = {};
  const runStatusCounts: Partial<Record<TeamQueueRunStatus, number>> = {};
  const turnStatusCounts: Partial<Record<TeamQueueTurnStatus, number>> = {};
  const resourceStatusCounts: Partial<Record<TeamQueueResourceStatus, number>> = {};

  const allTasks = Object.values(state.tasks).filter((task) => belongsToTeam(task, options?.teamId));
  const allRuns = Object.values(state.runs).filter((run) => belongsToTeam(run, options?.teamId));
  const allTurns = Object.values(state.turns).filter((turn) => belongsToTeam(turn, options?.teamId));
  const tasks = allTasks.filter((task) => !isDeletedRecord(task));
  const runs = allRuns.filter((run) => !isDeletedRecord(run));
  const turns = allTurns.filter((turn) => !isDeletedRecord(turn));
  const teamResourceKeys = new Set(turns.map((turn) => turn.resourceKey));
  const resources = Object.values(state.resources).filter((resource) => !options?.teamId || teamResourceKeys.has(resource.key));
  const orderedItems = runs
    .map((run) => ({ run, task: state.tasks[run.taskId] }))
    .filter(({ task }) => !task || !isDeletedRecord(task))
    .sort(compareQueueItems);

  for (const task of tasks) {
    increment(taskStatusCounts, task.status);
    increment(taskSourceCounts, task.source);
  }
  for (const run of runs) increment(runStatusCounts, run.status);
  for (const turn of turns) increment(turnStatusCounts, turn.status);
  for (const resource of resources) increment(resourceStatusCounts, resource.status);

  return {
    statePath: options?.statePath ?? getTeamQueueStatePath(),
    updatedAt: state.updatedAt,
    teamId: options?.teamId,
    items: orderedItems.map(({ task, run }, index) => {
      const reorderBlockedReason = queueItemReorderBlockedReason(task, run);
      return {
        queueTaskId: task?.id,
        queueRunId: run.id,
        teamId: run.teamId,
        source: task?.source,
        title: task?.title,
        status: run.status,
        taskStatus: task?.status,
        priority: queuePriority(task, run),
        queueOrder: task?.queueOrder ?? run.queueOrder,
        rank: index + 1,
        createdAt: task?.createdAt ?? run.createdAt,
        queuedAt: task?.queuedAt ?? run.queuedAt,
        startedAt: run.startedAt ?? task?.startedAt,
        finishedAt: run.finishedAt ?? task?.finishedAt,
        reorderable: !reorderBlockedReason,
        reorderBlockedReason,
      };
    }),
    tasks: {
      total: tasks.length,
      byStatus: taskStatusCounts,
      bySource: taskSourceCounts,
    },
    runs: {
      total: runs.length,
      byStatus: runStatusCounts,
    },
    turns: {
      total: turns.length,
      byStatus: turnStatusCounts,
    },
    resources: {
      total: resources.length,
      byStatus: resourceStatusCounts,
    },
    activeRunIds: runs.filter((run) => run.status === "running").map((run) => run.id),
    activeTurnIds: turns.filter((turn) => turn.status === "running").map((turn) => turn.id),
    deleted: {
      tasks: allTasks.filter(isDeletedRecord).length,
      runs: allRuns.filter(isDeletedRecord).length,
      turns: allTurns.filter(isDeletedRecord).length,
    },
  };
}

export function getTeamQueueStatus(teamId?: string, options?: TeamQueueStoreOptions): TeamQueueStatusSummary {
  const statePath = queueStatePath(options);
  return summarizeTeamQueueState(loadTeamQueueState(options), { teamId, statePath });
}
