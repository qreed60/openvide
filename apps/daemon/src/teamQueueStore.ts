import * as fs from "node:fs";
import * as path from "node:path";
import { daemonDir, newId, nowISO } from "./utils.js";
import type {
  CreateTeamQueueTaskInput,
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
} from "./teamQueueTypes.js";

const QUEUE_STATE_FILE = "team-queue.json";

export interface TeamQueueStoreOptions {
  statePath?: string;
  recoverStaleActive?: boolean;
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
    : 50;

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
    metadata: {
      source: input.source,
      priority,
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

export function listTeamQueueRuns(teamId?: string, options?: TeamQueueStoreOptions): TeamQueueRun[] {
  return Object.values(loadTeamQueueState(options).runs)
    .filter((run) => belongsToTeam(run, teamId))
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

  const tasks = Object.values(state.tasks).filter((task) => belongsToTeam(task, options?.teamId));
  const runs = Object.values(state.runs).filter((run) => belongsToTeam(run, options?.teamId));
  const turns = Object.values(state.turns).filter((turn) => belongsToTeam(turn, options?.teamId));
  const teamResourceKeys = new Set(turns.map((turn) => turn.resourceKey));
  const resources = Object.values(state.resources).filter((resource) => !options?.teamId || teamResourceKeys.has(resource.key));

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
  };
}

export function getTeamQueueStatus(teamId?: string, options?: TeamQueueStoreOptions): TeamQueueStatusSummary {
  const statePath = queueStatePath(options);
  return summarizeTeamQueueState(loadTeamQueueState(options), { teamId, statePath });
}
