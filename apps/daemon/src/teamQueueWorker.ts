import { dispatchTeamQueueOnce, type TeamQueueDispatcherOptions } from "./teamQueueDispatcher.js";
import type { TeamQueueDispatchResult, TeamQueueWorkerStatus } from "./teamQueueTypes.js";
import { log, logError, nowISO } from "./utils.js";

const DEFAULT_INTERVAL_MS = 4000;
const MIN_INTERVAL_MS = 1000;

let enabled = parseEnabled(process.env.OPENVIDE_QUEUE_WORKER_ENABLED);
let intervalMs = parseInterval(process.env.OPENVIDE_QUEUE_WORKER_INTERVAL_MS);
let timer: NodeJS.Timeout | undefined;
let running = false;
let startedAt: string | undefined;
let lastTickAt: string | undefined;
let lastDispatchResult: TeamQueueDispatchResult | undefined;
let lastError: string | undefined;
let dispatcherOptions: TeamQueueDispatcherOptions | undefined;

function parseEnabled(value: string | undefined): boolean {
  if (value == null || value.trim() === "") return true;
  const normalized = value.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off");
}

function parseInterval(value: string | undefined): number {
  if (!value) return DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(parsed));
}

function emptyDispatchResult(): TeamQueueDispatchResult {
  return {
    statePath: "",
    dispatchedRunIds: [],
    waitingRunIds: [],
    failedRunIds: [],
    skippedRunIds: [],
    events: [],
  };
}

export function getQueueWorkerStatus(): TeamQueueWorkerStatus {
  return {
    enabled,
    running,
    intervalMs,
    startedAt,
    lastTickAt,
    lastDispatchResult,
    lastError,
  };
}

export function configureQueueWorker(options?: { enabled?: boolean; intervalMs?: number; dispatcherOptions?: TeamQueueDispatcherOptions }): TeamQueueWorkerStatus {
  if (typeof options?.enabled === "boolean") enabled = options.enabled;
  if (typeof options?.intervalMs === "number" && Number.isFinite(options.intervalMs)) {
    intervalMs = Math.max(MIN_INTERVAL_MS, Math.trunc(options.intervalMs));
  }
  dispatcherOptions = options?.dispatcherOptions;
  return getQueueWorkerStatus();
}

export function enableQueueWorker(): TeamQueueWorkerStatus {
  enabled = true;
  return getQueueWorkerStatus();
}

export function disableQueueWorker(): TeamQueueWorkerStatus {
  enabled = false;
  return getQueueWorkerStatus();
}

export async function tickQueueWorkerOnce(options?: TeamQueueDispatcherOptions): Promise<TeamQueueWorkerStatus> {
  if (!enabled) {
    lastTickAt = nowISO();
    lastDispatchResult = emptyDispatchResult();
    lastError = undefined;
    return getQueueWorkerStatus();
  }
  if (running) return getQueueWorkerStatus();

  running = true;
  lastTickAt = nowISO();
  try {
    lastDispatchResult = await dispatchTeamQueueOnce(options ?? dispatcherOptions);
    lastError = undefined;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logError("Queue worker tick failed:", lastError);
  } finally {
    running = false;
  }
  return getQueueWorkerStatus();
}

export function startQueueWorker(options?: { dispatcherOptions?: TeamQueueDispatcherOptions }): TeamQueueWorkerStatus {
  dispatcherOptions = options?.dispatcherOptions;
  if (!startedAt) startedAt = nowISO();
  if (timer) return getQueueWorkerStatus();
  timer = setInterval(() => {
    void tickQueueWorkerOnce();
  }, intervalMs);
  timer.unref?.();
  log(`Queue worker started enabled=${enabled} intervalMs=${intervalMs}`);
  void tickQueueWorkerOnce();
  return getQueueWorkerStatus();
}

export function stopQueueWorker(): TeamQueueWorkerStatus {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  running = false;
  log("Queue worker stopped");
  return getQueueWorkerStatus();
}
