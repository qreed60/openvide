import { newId, nowISO } from "./utils.js";
import {
  cancelTeamQueueTask,
  createTeamQueueTask,
  loadTeamQueueState,
  updateTeamQueueState,
  type TeamQueueStoreOptions,
} from "./teamQueueStore.js";
import type {
  CreateTeamBoardItemInput,
  TeamBoardExecutionStatus,
  TeamBoardItem,
  TeamBoardReviewStatus,
  TeamQueueRun,
  TeamQueueTask,
} from "./teamQueueTypes.js";

const BOARD_REVIEW_STATUSES = new Set<TeamBoardReviewStatus>([
  "not_required",
  "pending_review",
  "approved",
  "revise",
  "rejected",
]);

interface BoardMetadata {
  boardItemId?: string;
  assignedMembers?: string[];
  reviewerMembers?: string[];
  reviewStatus?: TeamBoardReviewStatus;
  reviewFeedback?: string;
  blockedReason?: string;
  executionStatus?: TeamBoardExecutionStatus;
}

export interface SetTeamBoardReviewStatusInput {
  itemId: string;
  reviewStatus: TeamBoardReviewStatus;
  reviewFeedback?: string;
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

function boardMetadata(task: TeamQueueTask): BoardMetadata {
  const raw = task.metadata?.board;
  return raw && typeof raw === "object" ? raw as BoardMetadata : {};
}

function isDeletedQueueTask(task: TeamQueueTask): boolean {
  return Boolean(task.deletedAt) || task.visibility === "deleted";
}

function reviewStatusValue(value: unknown): TeamBoardReviewStatus {
  return typeof value === "string" && BOARD_REVIEW_STATUSES.has(value as TeamBoardReviewStatus)
    ? value as TeamBoardReviewStatus
    : "not_required";
}

function latestRun(task: TeamQueueTask, runs: TeamQueueRun[]): TeamQueueRun | undefined {
  const taskRunIds = new Set(task.runIds);
  return runs
    .filter((run) => taskRunIds.has(run.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function runExecutionStatus(run: TeamQueueRun | undefined): TeamBoardExecutionStatus | undefined {
  if (!run) return undefined;
  if (
    run.status === "queued"
    || run.status === "waiting_for_team_slot"
    || run.status === "waiting_for_model"
    || run.status === "running"
    || run.status === "completed"
    || run.status === "failed"
    || run.status === "cancelled"
    || run.status === "interrupted"
  ) {
    return run.status;
  }
  return undefined;
}

function taskExecutionStatus(task: TeamQueueTask): TeamBoardExecutionStatus {
  if (
    task.status === "queued"
    || task.status === "running"
    || task.status === "completed"
    || task.status === "failed"
    || task.status === "cancelled"
    || task.status === "interrupted"
  ) {
    return task.status;
  }
  if (task.status === "ready") return "queued";
  return "queued";
}

function isTerminalExecutionStatus(status: TeamBoardExecutionStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function deriveExecutionStatus(
  task: TeamQueueTask,
  run: TeamQueueRun | undefined,
  metadata: BoardMetadata,
): TeamBoardExecutionStatus {
  const runStatus = runExecutionStatus(run);
  const taskStatus = taskExecutionStatus(task);
  if (isTerminalExecutionStatus(runStatus)) return runStatus!;
  if (isTerminalExecutionStatus(taskStatus)) return taskStatus;
  if (metadata.executionStatus === "draft") return "draft";
  if (metadata.executionStatus === "blocked") return "blocked";
  return runStatus ?? taskStatus;
}

function deriveBlockedReason(task: TeamQueueTask, run: TeamQueueRun | undefined, metadata: BoardMetadata): string | undefined {
  return cleanString(metadata.blockedReason)
    ?? cleanString(typeof run?.metadata?.dispatchBlockedReason === "string" ? run.metadata.dispatchBlockedReason : undefined)
    ?? cleanString(typeof task.metadata?.dispatchBlockedReason === "string" ? task.metadata.dispatchBlockedReason : undefined);
}

function toBoardItem(task: TeamQueueTask, runsById: Record<string, TeamQueueRun>): TeamBoardItem | undefined {
  if (task.source !== "board") return undefined;
  const metadata = boardMetadata(task);
  const id = cleanString(metadata.boardItemId) ?? cleanString(task.sourceRef?.boardTaskId) ?? task.id;
  const runs = task.runIds.map((runId) => runsById[runId]).filter((run): run is TeamQueueRun => Boolean(run));
  const currentRun = latestRun(task, runs);
  const executionStatus = deriveExecutionStatus(task, currentRun, metadata);
  const blockedReason = deriveBlockedReason(task, currentRun, metadata);

  return {
    id,
    teamId: task.teamId,
    title: task.title,
    description: task.description,
    source: "board",
    executionStatus,
    reviewStatus: reviewStatusValue(metadata.reviewStatus),
    assignedMembers: cleanMembers(metadata.assignedMembers),
    reviewerMembers: cleanMembers(metadata.reviewerMembers),
    priority: task.priority ?? 50,
    queueTaskId: task.id,
    queueRunIds: task.runIds,
    createdAt: task.createdAt,
    updatedAt: currentRun?.updatedAt && currentRun.updatedAt > task.updatedAt ? currentRun.updatedAt : task.updatedAt,
    queuedAt: task.queuedAt,
    startedAt: currentRun?.startedAt ?? task.startedAt,
    finishedAt: currentRun?.finishedAt ?? task.finishedAt,
    blockedReason: executionStatus === "blocked" || blockedReason ? blockedReason : undefined,
    reviewFeedback: cleanString(metadata.reviewFeedback),
  };
}

export function listTeamBoardItems(teamId?: string, options?: TeamQueueStoreOptions): TeamBoardItem[] {
  const state = loadTeamQueueState(options);
  return Object.values(state.tasks)
    .filter((task) => task.source === "board")
    .filter((task) => !isDeletedQueueTask(task))
    .filter((task) => !teamId || task.teamId === teamId)
    .map((task) => toBoardItem(task, state.runs))
    .filter((item): item is TeamBoardItem => Boolean(item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTeamBoardItem(itemId: string, options?: TeamQueueStoreOptions): TeamBoardItem | undefined {
  const id = cleanString(itemId);
  if (!id) return undefined;
  return listTeamBoardItems(undefined, options).find((item) => item.id === id || item.queueTaskId === id);
}

export function createTeamBoardItem(
  input: CreateTeamBoardItemInput,
  options?: TeamQueueStoreOptions,
): { boardItem: TeamBoardItem; queueTask: TeamQueueTask; queueRuns: TeamQueueRun[] } {
  const teamId = cleanString(input.teamId);
  const title = cleanString(input.title);
  if (!teamId || !title) throw new Error("Missing required: teamId, title");

  const assignedMembers = cleanMembers(input.assignedMembers);
  const reviewerMembers = cleanMembers(input.reviewerMembers);
  const reviewStatus = input.reviewStatus && BOARD_REVIEW_STATUSES.has(input.reviewStatus)
    ? input.reviewStatus
    : "not_required";
  const priority = typeof input.priority === "number" && Number.isFinite(input.priority)
    ? input.priority
    : 50;
  const boardItemId = newId("board_item");
  const executionStatus = input.executionStatus === "draft" || input.executionStatus === "blocked"
    ? input.executionStatus
    : "queued";

  const created = createTeamQueueTask({
    teamId,
    source: "board",
    title,
    description: input.description,
    assignedMemberNames: assignedMembers,
    priority,
    createdBy: input.createdBy,
    sourceRef: {
      boardTaskId: boardItemId,
    },
    metadata: {
      producerCommand: "team.board.item.create",
      board: {
        boardItemId,
        assignedMembers,
        reviewerMembers,
        reviewStatus,
        reviewFeedback: cleanString(input.reviewFeedback),
        blockedReason: cleanString(input.blockedReason),
        executionStatus,
      },
    },
  }, options);

  let state = created.state;
  if (executionStatus === "draft") {
    state = updateTeamQueueState((draft) => {
      const task = draft.tasks[created.task.id];
      if (!task) return;
      task.metadata = {
        ...(task.metadata ?? {}),
        board: {
          ...boardMetadata(task),
          executionStatus: "draft",
        },
      };
      const now = nowISO();
      for (const runId of task.runIds) {
        const run = draft.runs[runId];
        if (!run) continue;
        run.metadata = {
          ...(run.metadata ?? {}),
          draft: true,
        };
        run.updatedAt = now;
      }
      task.updatedAt = now;
    }, options);
  }

  const task = state.tasks[created.task.id] ?? created.task;
  const queueRuns = task.runIds.map((runId) => state.runs[runId]).filter((run): run is TeamQueueRun => Boolean(run));
  const boardItem = toBoardItem(task, state.runs);
  if (!boardItem) throw new Error(`Failed to create Board item for queue task ${task.id}`);
  return { boardItem, queueTask: task, queueRuns };
}

export function cancelTeamBoardItem(
  itemId: string,
  options?: TeamQueueStoreOptions,
): { boardItem?: TeamBoardItem; queueTask?: TeamQueueTask; queueRuns: TeamQueueRun[] } {
  const existing = getTeamBoardItem(itemId, options);
  if (!existing) return { queueRuns: [] };
  cancelTeamQueueTask(existing.queueTaskId, options);
  const state = updateTeamQueueState((draft) => {
    const task = draft.tasks[existing.queueTaskId];
    if (!task) return;
    const timestamp = nowISO();
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "interrupted") {
      task.status = "cancelled";
      task.finishedAt = task.finishedAt ?? timestamp;
    }
    task.metadata = {
      ...(task.metadata ?? {}),
      board: {
        ...boardMetadata(task),
        executionStatus: "cancelled",
      },
    };
    task.updatedAt = timestamp;
    for (const runId of task.runIds) {
      const run = draft.runs[runId];
      if (!run || run.status === "completed" || run.status === "failed" || run.status === "interrupted") continue;
      run.status = "cancelled";
      run.currentState = "cancelled";
      run.finishedAt = run.finishedAt ?? timestamp;
      run.updatedAt = timestamp;
    }
  }, options);
  const queueTask = state.tasks[existing.queueTaskId];
  const queueRuns = queueTask
    ? queueTask.runIds.map((runId) => state.runs[runId]).filter((run): run is TeamQueueRun => Boolean(run))
    : [];
  const boardItem = queueTask ? toBoardItem(queueTask, state.runs) : undefined;
  return { boardItem, queueTask, queueRuns };
}

export function setTeamBoardReviewStatus(
  input: SetTeamBoardReviewStatusInput,
  options?: TeamQueueStoreOptions,
): TeamBoardItem | undefined {
  const itemId = cleanString(input.itemId);
  if (!itemId || !BOARD_REVIEW_STATUSES.has(input.reviewStatus)) return undefined;
  const existing = getTeamBoardItem(itemId, options);
  if (!existing) return undefined;

  const state = updateTeamQueueState((draft) => {
    const task = draft.tasks[existing.queueTaskId];
    if (!task) return;
    task.metadata = {
      ...(task.metadata ?? {}),
      board: {
        ...boardMetadata(task),
        reviewStatus: input.reviewStatus,
        reviewFeedback: cleanString(input.reviewFeedback),
      },
    };
    task.updatedAt = nowISO();
  }, options);
  return toBoardItem(state.tasks[existing.queueTaskId], state.runs);
}
