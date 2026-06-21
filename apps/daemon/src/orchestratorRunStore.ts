import * as fs from "node:fs";
import * as path from "node:path";
import { daemonDir, nowISO } from "./utils.js";
import type { TeamMessageOrchestration, TeamTool } from "./types.js";

export type OrchestratorEventType =
  | "orchestrator_start"
  | "lead_turn_started"
  | "lead_turn_completed"
  | "delegation_created"
  | "member_turn_started"
  | "member_turn_completed"
  | "lead_review_started"
  | "final_created"
  | "orchestrator_error";

export type OrchestratorEventStatus = "started" | "completed" | "blocked" | "failed";

export interface OrchestratorRunEvent {
  id: string;
  runId: string;
  teamId: string;
  type: OrchestratorEventType;
  timestamp: string;
  memberName?: string;
  role?: string;
  tool?: TeamTool;
  model?: string;
  status?: OrchestratorEventStatus;
  durationMs?: number;
  summary?: string;
  diagnostics?: string;
}

export interface OrchestratorRunRecord {
  runId: string;
  teamId: string;
  orchestrator: "langgraph";
  status: "running" | "completed" | "blocked" | "failed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  leadName?: string;
  route: string[];
  routeSummary: string;
  eventCount: number;
  summary?: string;
}

export interface OrchestratorRunWithEvents extends OrchestratorRunRecord {
  events: OrchestratorRunEvent[];
}

export interface OrchestratorRunSummary {
  runId: string;
  teamId: string;
  status: OrchestratorRunRecord["status"];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  route: string[];
  routeSummary: string;
  eventCount: number;
  summary?: string;
}

export interface OrchestratorRunTimelineEvent {
  id: string;
  type: OrchestratorEventType;
  timestamp: string;
  memberName?: string;
  role?: string;
  tool?: TeamTool;
  model?: string;
  status?: OrchestratorEventStatus;
  durationMs?: number;
  summary?: string;
  diagnostics?: string;
}

export interface OrchestratorRunMemberSummary {
  name: string;
  role?: string;
  tool?: TeamTool;
  model?: string;
}

export interface OrchestratorRunDetails {
  summary: OrchestratorRunSummary;
  events: OrchestratorRunTimelineEvent[];
  route: string[];
  routeSummary: string;
  members: OrchestratorRunMemberSummary[];
}

const RUNS_DIR = path.join(daemonDir(), "orchestrator-runs");
const DEFAULT_RECENT_RUN_LIMIT = 10;
const MAX_RECENT_RUN_LIMIT = 50;

function ensureDir(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function runPath(runId: string): string {
  return path.join(RUNS_DIR, `${runId}.json`);
}

function eventsPath(runId: string): string {
  return path.join(RUNS_DIR, `${runId}.events.jsonl`);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeRun(run: OrchestratorRunRecord): void {
  ensureDir();
  fs.writeFileSync(runPath(run.runId), JSON.stringify(run, null, 2));
}

function readEvents(runId: string): OrchestratorRunEvent[] {
  try {
    return fs.readFileSync(eventsPath(runId), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OrchestratorRunEvent);
  } catch {
    return [];
  }
}

function compactSummary(text: string | undefined, max = 260): string | undefined {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function compactRouteSummary(route: string[], fallback?: string): string {
  if (route.length > 0) return route.join(" -> ");
  return compactSummary(fallback, 160) ?? "";
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_RECENT_RUN_LIMIT;
  return Math.min(MAX_RECENT_RUN_LIMIT, Math.max(1, Math.floor(limit)));
}

function runDurationMs(run: OrchestratorRunRecord): number | undefined {
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.completedAt ?? run.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined;
  return finished - started;
}

export function summarizeOrchestratorRun(run: OrchestratorRunRecord): OrchestratorRunSummary {
  return {
    runId: run.runId,
    teamId: run.teamId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.completedAt,
    durationMs: runDurationMs(run),
    route: run.route,
    routeSummary: compactRouteSummary(run.route, run.routeSummary),
    eventCount: run.eventCount,
    summary: compactSummary(run.summary),
  };
}

function timelineEvent(event: OrchestratorRunEvent): OrchestratorRunTimelineEvent {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    memberName: event.memberName,
    role: event.role,
    tool: event.tool,
    model: event.model,
    status: event.status,
    durationMs: event.durationMs,
    summary: compactSummary(event.summary),
    diagnostics: compactSummary(event.diagnostics, 2000),
  };
}

function memberSummaries(events: OrchestratorRunEvent[]): OrchestratorRunMemberSummary[] {
  const members = new Map<string, OrchestratorRunMemberSummary>();
  for (const event of events) {
    if (!event.memberName) continue;
    const existing = members.get(event.memberName) ?? { name: event.memberName };
    members.set(event.memberName, {
      name: event.memberName,
      role: event.role ?? existing.role,
      tool: event.tool ?? existing.tool,
      model: event.model ?? existing.model,
    });
  }
  return Array.from(members.values());
}

export function detailOrchestratorRun(run: OrchestratorRunWithEvents): OrchestratorRunDetails {
  const summary = summarizeOrchestratorRun(run);
  return {
    summary,
    events: run.events.map(timelineEvent),
    route: summary.route,
    routeSummary: summary.routeSummary,
    members: memberSummaries(run.events),
  };
}

function eventId(runId: string, index: number): string {
  return `${runId}_event_${index}`;
}

export function startOrchestratorRun(input: { runId: string; teamId: string; leadName?: string }): OrchestratorRunRecord {
  const startedAt = nowISO();
  const run: OrchestratorRunRecord = {
    runId: input.runId,
    teamId: input.teamId,
    orchestrator: "langgraph",
    status: "running",
    startedAt,
    updatedAt: startedAt,
    leadName: input.leadName,
    route: [],
    routeSummary: "",
    eventCount: 0,
  };
  writeRun(run);
  return run;
}

export function appendOrchestratorEvent(
  runId: string,
  event: Omit<OrchestratorRunEvent, "id" | "runId" | "timestamp"> & { timestamp?: string },
): OrchestratorEventStatus | undefined {
  ensureDir();
  const run = readJson<OrchestratorRunRecord>(runPath(runId));
  const nextCount = (run?.eventCount ?? readEvents(runId).length) + 1;
  const record: OrchestratorRunEvent = {
    ...event,
    id: eventId(runId, nextCount),
    runId,
    timestamp: event.timestamp ?? nowISO(),
    summary: compactSummary(event.summary),
  };
  fs.appendFileSync(eventsPath(runId), JSON.stringify(record) + "\n");
  if (run) {
    const route = routeFromEvents(readEvents(runId));
    writeRun({
      ...run,
      updatedAt: record.timestamp,
      eventCount: nextCount,
      route,
      routeSummary: route.join(" -> "),
    });
  }
  return record.status;
}

export function finishOrchestratorRun(
  runId: string,
  status: OrchestratorRunRecord["status"],
  summary?: string,
): OrchestratorRunRecord | null {
  const run = readJson<OrchestratorRunRecord>(runPath(runId));
  if (!run) return null;
  const completedAt = nowISO();
  const events = readEvents(runId);
  const route = routeFromEvents(events);
  const next = {
    ...run,
    status,
    updatedAt: completedAt,
    completedAt,
    route,
    routeSummary: route.join(" -> "),
    eventCount: events.length,
    summary: compactSummary(summary),
  };
  writeRun(next);
  return next;
}

export function listRecentOrchestratorRuns(limit?: number, teamId?: string): OrchestratorRunSummary[] {
  try {
    return fs.readdirSync(RUNS_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJson<OrchestratorRunRecord>(path.join(RUNS_DIR, file)))
      .filter((run): run is OrchestratorRunRecord => Boolean(run && (!teamId || run.teamId === teamId)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, clampLimit(limit))
      .map(summarizeOrchestratorRun);
  } catch {
    return [];
  }
}

export function getOrchestratorRun(runId: string): OrchestratorRunWithEvents | null {
  const run = readJson<OrchestratorRunRecord>(runPath(runId));
  if (!run) return null;
  return { ...run, events: readEvents(runId) };
}

export function createMessageOrchestration(runId: string): TeamMessageOrchestration | undefined {
  const run = getOrchestratorRun(runId);
  if (!run) return undefined;
  const status = run.status === "failed" ? "failed" : run.status === "blocked" ? "blocked" : "completed";
  const timeline = run.events
    .filter((event) => event.type === "lead_turn_completed" || event.type === "member_turn_completed")
    .map((event) => ({
      memberName: event.memberName,
      role: event.role,
      tool: event.tool,
      model: event.model,
      status: event.status,
      durationMs: event.durationMs,
      summary: event.summary,
      diagnostics: event.diagnostics,
    }));
  return {
    runId: run.runId,
    teamId: run.teamId,
    status,
    route: run.route,
    routeSummary: run.routeSummary,
    timeline,
  };
}

function routeFromEvents(events: OrchestratorRunEvent[]): string[] {
  const route: string[] = [];
  for (const event of events) {
    if (
      (event.type === "lead_turn_completed" || event.type === "member_turn_completed" || event.type === "final_created")
      && event.memberName
      && route[route.length - 1] !== event.memberName
    ) {
      route.push(event.memberName);
    }
  }
  return route;
}
