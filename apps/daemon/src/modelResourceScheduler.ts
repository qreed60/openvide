import {
  loadTeamQueueState,
  saveTeamQueueState,
  type TeamQueueStoreOptions,
  getTeamQueueStatePath,
} from "./teamQueueStore.js";
import type {
  ModelResourceAcquireResult,
  ModelResourceOwnerMetadata,
  ModelResourceStatus,
  ModelResourceStatusSummary,
  TeamQueueResource,
  TeamQueueState,
} from "./teamQueueTypes.js";
import type { TeamTool } from "./types.js";
import { nowISO } from "./utils.js";

const DEFAULT_MODEL = "default";
const DEFAULT_MODEL_ONLY_PROVIDERS = new Set<TeamTool>(["opencode", "openhands"]);

function normalizeProvider(provider: string): TeamTool {
  const key = provider.trim().toLowerCase();
  if (key === "claude" || key === "codex" || key === "gemini" || key === "opencode" || key === "openhands") {
    return key;
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function normalizeModel(provider: TeamTool, model?: string | null): string {
  if (DEFAULT_MODEL_ONLY_PROVIDERS.has(provider)) return DEFAULT_MODEL;
  const trimmed = typeof model === "string" ? model.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_MODEL;
}

function parseResourceKey(resourceKey: string): { provider: TeamTool; model: string } {
  const [providerPart, ...modelParts] = resourceKey.split(":");
  const provider = normalizeProvider(providerPart ?? "");
  const parsedModel = modelParts.join(":");
  return { provider, model: normalizeModel(provider, parsedModel) };
}

export function modelResourceKey(provider: TeamTool | string, model?: string | null): string {
  const normalizedProvider = normalizeProvider(provider);
  return `${normalizedProvider}:${normalizeModel(normalizedProvider, model)}`;
}

function createResource(resourceKey: string, now: string): TeamQueueResource {
  const { provider, model } = parseResourceKey(resourceKey);
  return {
    key: modelResourceKey(provider, model),
    provider,
    model,
    status: "available",
    queuedTurnIds: [],
    updatedAt: now,
  };
}

function resourceOwner(resource: TeamQueueResource): ModelResourceOwnerMetadata | undefined {
  const owner = resource.metadata?.owner;
  return owner && typeof owner === "object" ? owner as ModelResourceOwnerMetadata : undefined;
}

function toStatus(resource: TeamQueueResource): ModelResourceStatus {
  const owner = resourceOwner(resource);
  return {
    key: resource.key,
    provider: resource.provider,
    model: resource.model,
    status: resource.status,
    activeTurnId: resource.activeTurnId,
    activeRunId: owner?.runId,
    queuedTurnIds: [...resource.queuedTurnIds],
    updatedAt: resource.updatedAt,
    metadata: resource.metadata,
  };
}

function ensureResource(state: TeamQueueState, resourceKey: string): TeamQueueResource {
  const now = nowISO();
  const parsed = parseResourceKey(resourceKey);
  const canonicalKey = modelResourceKey(parsed.provider, parsed.model);
  const existing = state.resources[canonicalKey];
  if (existing) return existing;
  const resource = createResource(canonicalKey, now);
  state.resources[canonicalKey] = resource;
  return resource;
}

function markWaitingTurn(state: TeamQueueState, owner: ModelResourceOwnerMetadata, resourceKey: string, now: string): void {
  if (!owner.turnId) return;
  const turn = state.turns[owner.turnId];
  if (!turn) return;
  turn.status = "waiting_for_model";
  turn.resourceKey = resourceKey;
  turn.providerStartedAt = undefined;
  turn.executionTimeoutStartedAt = undefined;
  turn.metadata = {
    ...(turn.metadata ?? {}),
    modelResourceWaitingSince: now,
  };
}

function markReservedTurn(state: TeamQueueState, owner: ModelResourceOwnerMetadata, resourceKey: string): void {
  if (!owner.turnId) return;
  const turn = state.turns[owner.turnId];
  if (!turn) return;
  turn.status = "waiting_for_model";
  turn.resourceKey = resourceKey;
  turn.providerStartedAt = undefined;
  turn.executionTimeoutStartedAt = undefined;
}

function releaseMatches(resource: TeamQueueResource, turnId?: string, runId?: string): boolean {
  if (turnId && resource.activeTurnId === turnId) return true;
  if (!runId) return false;
  return resourceOwner(resource)?.runId === runId;
}

function activeOperationOptions(options?: TeamQueueStoreOptions): TeamQueueStoreOptions {
  return { ...options, recoverStaleActive: false };
}

export function initializeModelResourceScheduler(options?: TeamQueueStoreOptions): ModelResourceStatusSummary {
  const state = loadTeamQueueState(options);
  return {
    statePath: options?.statePath ?? getTeamQueueStatePath(),
    updatedAt: state.updatedAt,
    resources: Object.values(state.resources).map(toStatus),
  };
}

export function acquireResource(
  resourceKey: string,
  owner: ModelResourceOwnerMetadata,
  options?: TeamQueueStoreOptions,
): ModelResourceAcquireResult {
  const operationOptions = activeOperationOptions(options);
  const state = loadTeamQueueState(operationOptions);
  const now = nowISO();
  const resource = ensureResource(state, resourceKey);
  const ownerRecord: ModelResourceOwnerMetadata = {
    ...owner,
    provider: resource.provider,
    model: resource.model,
    requestedAt: owner.requestedAt ?? now,
  };

  if (resource.status === "disabled") {
    saveTeamQueueState(state, operationOptions);
    return { status: "disabled", resource, owner: ownerRecord };
  }

  if (resource.status === "running" || resource.status === "reserved" || resource.activeTurnId) {
    if (owner.turnId && !resource.queuedTurnIds.includes(owner.turnId)) {
      resource.queuedTurnIds.push(owner.turnId);
    }
    resource.updatedAt = now;
    markWaitingTurn(state, ownerRecord, resource.key, now);
    const saved = saveTeamQueueState(state, operationOptions);
    const savedResource = saved.resources[resource.key] ?? resource;
    const activeOwner = resourceOwner(savedResource);
    return {
      status: "waiting",
      resource: savedResource,
      owner: ownerRecord,
      blockedByTurnId: savedResource.activeTurnId,
      blockedByRunId: activeOwner?.runId,
    };
  }

  resource.status = "reserved";
  resource.activeTurnId = owner.turnId;
  resource.queuedTurnIds = owner.turnId
    ? resource.queuedTurnIds.filter((turnId) => turnId !== owner.turnId)
    : resource.queuedTurnIds;
  resource.updatedAt = now;
  resource.metadata = {
    ...(resource.metadata ?? {}),
    owner: ownerRecord,
  };
  markReservedTurn(state, ownerRecord, resource.key);
  const saved = saveTeamQueueState(state, operationOptions);
  return { status: "acquired", resource: saved.resources[resource.key] ?? resource, owner: ownerRecord };
}

export function releaseResource(
  resourceKey: string,
  ownerRef: { turnId?: string; runId?: string },
  options?: TeamQueueStoreOptions,
): ModelResourceStatus {
  const operationOptions = activeOperationOptions(options);
  const state = loadTeamQueueState(operationOptions);
  const resource = ensureResource(state, resourceKey);
  if (resource.status !== "disabled" && releaseMatches(resource, ownerRef.turnId, ownerRef.runId)) {
    const now = nowISO();
    resource.status = "available";
    resource.activeTurnId = undefined;
    resource.updatedAt = now;
    const { owner: _owner, ...metadata } = resource.metadata ?? {};
    resource.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
  }
  const saved = saveTeamQueueState(state, operationOptions);
  return toStatus(saved.resources[resource.key] ?? resource);
}

export function getResourceStatus(resourceKey: string, options?: TeamQueueStoreOptions): ModelResourceStatus {
  const operationOptions = activeOperationOptions(options);
  const state = loadTeamQueueState(operationOptions);
  const resource = ensureResource(state, resourceKey);
  const saved = saveTeamQueueState(state, operationOptions);
  return toStatus(saved.resources[resource.key] ?? resource);
}

export function listResourceStatus(options?: TeamQueueStoreOptions): ModelResourceStatusSummary {
  const state = loadTeamQueueState(activeOperationOptions(options));
  return {
    statePath: options?.statePath ?? getTeamQueueStatePath(),
    updatedAt: state.updatedAt,
    resources: Object.values(state.resources).sort((a, b) => a.key.localeCompare(b.key)).map(toStatus),
  };
}
