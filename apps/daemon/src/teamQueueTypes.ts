import type { TeamTool } from "./types.js";

export type TeamQueueTaskSource = "board" | "plan" | "chat" | "scheduler" | "manual";

export type TeamQueueTaskStatus =
  | "queued"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TeamQueueRunStatus =
  | "queued"
  | "waiting_for_team_slot"
  | "waiting_for_model"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TeamQueueTurnStatus =
  | "queued"
  | "waiting_for_team_slot"
  | "waiting_for_model"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped";

export type TeamQueueResourceStatus = "available" | "reserved" | "running" | "disabled";

export interface TeamQueueTask {
  id: string;
  teamId: string;
  source: TeamQueueTaskSource;
  status: TeamQueueTaskStatus;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  createdBy?: string;
  sourceRef?: {
    boardTaskId?: string;
    planId?: string;
    planRevisionId?: string;
    messageId?: string;
    scheduleId?: string;
  };
  runIds: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface TeamQueueRun {
  id: string;
  teamId: string;
  taskId: string;
  status: TeamQueueRunStatus;
  route: string[];
  currentMember?: string;
  currentTurnId?: string;
  currentState?: TeamQueueRunStatus;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempt: number;
  turnIds: string[];
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamQueueTurn {
  id: string;
  teamId: string;
  taskId: string;
  runId: string;
  memberName: string;
  role?: string;
  provider: TeamTool;
  model?: string;
  resourceKey: string;
  status: TeamQueueTurnStatus;
  queuedAt: string;
  startedAt?: string;
  providerStartedAt?: string;
  finishedAt?: string;
  executionTimeoutStartedAt?: string;
  exitCode?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamQueueResource {
  key: string;
  provider: TeamTool;
  model: string;
  status: TeamQueueResourceStatus;
  activeTurnId?: string;
  queuedTurnIds: string[];
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ModelResourceOwnerMetadata {
  turnId?: string;
  runId?: string;
  teamId?: string;
  taskId?: string;
  memberName?: string;
  provider?: TeamTool;
  model?: string;
  requestedAt?: string;
  metadata?: Record<string, unknown>;
}

export type ModelResourceAcquireStatus = "acquired" | "waiting" | "disabled";

export interface ModelResourceAcquireResult {
  status: ModelResourceAcquireStatus;
  resource: TeamQueueResource;
  owner: ModelResourceOwnerMetadata;
  blockedByTurnId?: string;
  blockedByRunId?: string;
}

export interface ModelResourceStatus {
  key: string;
  provider: TeamTool;
  model: string;
  status: TeamQueueResourceStatus;
  activeTurnId?: string;
  activeRunId?: string;
  queuedTurnIds: string[];
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ModelResourceStatusSummary {
  statePath: string;
  updatedAt: string;
  resources: ModelResourceStatus[];
}

export interface TeamQueueState {
  version: 1;
  createdAt: string;
  updatedAt: string;
  tasks: Record<string, TeamQueueTask>;
  runs: Record<string, TeamQueueRun>;
  turns: Record<string, TeamQueueTurn>;
  resources: Record<string, TeamQueueResource>;
}

export interface TeamQueueStatusSummary {
  statePath: string;
  updatedAt: string;
  teamId?: string;
  tasks: {
    total: number;
    byStatus: Partial<Record<TeamQueueTaskStatus, number>>;
    bySource: Partial<Record<TeamQueueTaskSource, number>>;
  };
  runs: {
    total: number;
    byStatus: Partial<Record<TeamQueueRunStatus, number>>;
  };
  turns: {
    total: number;
    byStatus: Partial<Record<TeamQueueTurnStatus, number>>;
  };
  resources: {
    total: number;
    byStatus: Partial<Record<TeamQueueResourceStatus, number>>;
  };
  activeRunIds: string[];
  activeTurnIds: string[];
}

export interface CreateTeamQueueTaskInput {
  teamId: string;
  source: TeamQueueTaskSource;
  title: string;
  description?: string;
  assignedMemberNames?: string[];
  priority?: number;
  createdBy?: string;
  sourceRef?: TeamQueueTask["sourceRef"];
  metadata?: Record<string, unknown>;
}

export type TeamQueueDispatchEventType =
  | "task_dispatch_started"
  | "run_waiting_for_team_slot"
  | "member_waiting_for_model"
  | "model_resource_acquired"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "model_resource_released";

export interface TeamQueueDispatchEvent {
  id: string;
  type: TeamQueueDispatchEventType;
  timestamp: string;
  teamId: string;
  taskId?: string;
  runId?: string;
  turnId?: string;
  memberName?: string;
  resourceKey?: string;
  status?: TeamQueueTaskStatus | TeamQueueRunStatus | TeamQueueTurnStatus | TeamQueueResourceStatus;
  reason?: string;
  summary?: string;
}

export interface TeamQueueDispatchResult {
  statePath: string;
  dispatchedRunIds: string[];
  waitingRunIds: string[];
  failedRunIds: string[];
  skippedRunIds: string[];
  events: TeamQueueDispatchEvent[];
}
