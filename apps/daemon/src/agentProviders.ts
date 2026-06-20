import * as child_process from "node:child_process";
import * as sm from "./sessionManager.js";
import type { IpcResponse, TeamMember, TeamTool, Tool } from "./types.js";
import { log } from "./utils.js";

export type AgentProvider = TeamTool;
export type ProviderStatus = "enabled" | "planned" | "installed-but-not-executable" | "installed-but-disabled" | "disabled" | "unavailable";

export interface ProviderCapabilities {
  canEdit: boolean;
  canReview: boolean;
  supportsVision: boolean;
  supportsLongRunning: boolean;
  supportsStatusPolling: boolean;
  supportsModelOverride: boolean;
}

export interface ProviderExecutionCompletion {
  status: "idle" | "failed" | "cancelled" | "interrupted";
  responseText: string;
  errorText?: string;
}

export interface ProviderExecutionRequest {
  member: TeamMember;
  prompt: string;
  cwd?: string;
  waitForCompletion: (sessionId: string) => Promise<ProviderExecutionCompletion>;
}

export interface ProviderExecutionResult extends ProviderExecutionCompletion {
  provider: AgentProvider;
  sessionId: string;
  ok: boolean;
  error?: string;
  diagnostics?: {
    command?: string;
    args?: string[];
    promptLength?: number;
    modelArgApplied?: boolean;
    timeoutMs?: number;
    cwd?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
    stdout?: string;
    stdoutTail?: string;
    stderr?: string;
    stderrTail?: string;
    parsedAssistantEventCount?: number;
    conversationId?: string;
    timedOut?: boolean;
  };
}

export interface ProviderAdapter {
  provider: AgentProvider;
  label: string;
  capabilities: ProviderCapabilities;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export interface ProviderRegistryEntry {
  id: AgentProvider;
  label: string;
  type: "cli" | "planned";
  status: ProviderStatus;
  available: boolean;
  enabled: boolean;
  executable: boolean;
  planned: boolean;
  modelOverride: boolean;
  capabilities: ProviderCapabilities;
  detection?: ProviderDetectionInfo;
}

export interface ProviderDetectionInfo {
  available: boolean;
  command?: string;
  version?: string;
  helpSummary?: string;
  error?: string;
}

const cliCapabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  canEdit: true,
  canReview: true,
  supportsVision: false,
  supportsLongRunning: false,
  supportsStatusPolling: true,
  supportsModelOverride: true,
  ...overrides,
});

const OPENCODE_ENABLE_FLAG = "OPENVIDE_ENABLE_OPENCODE_PROVIDER";
const OPENCODE_COMMAND_ENV = "OPENVIDE_OPENCODE_COMMAND";
const OPENCODE_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
const OPENHANDS_ENABLE_FLAG = "OPENVIDE_ENABLE_OPENHANDS_PROVIDER";
const OPENHANDS_COMMAND_ENV = "OPENVIDE_OPENHANDS_COMMAND";
const OPENHANDS_EXECUTION_TIMEOUT_MS = 8 * 60 * 1000;
const DIAGNOSTIC_TAIL_CHARS = 4000;

function envFlagEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isOpenCodeProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(OPENCODE_ENABLE_FLAG, env);
}

export function isOpenHandsProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(OPENHANDS_ENABLE_FLAG, env);
}

function failedExecution(
  provider: AgentProvider,
  sessionId: string,
  error: string,
  diagnostics?: ProviderExecutionResult["diagnostics"],
): ProviderExecutionResult {
  return {
    provider,
    sessionId,
    ok: false,
    status: "failed",
    responseText: "",
    errorText: error,
    error,
    diagnostics,
  };
}

function makeCliProviderAdapter(
  provider: Tool,
  label: string,
  capabilities: ProviderCapabilities,
): ProviderAdapter {
  return {
    provider,
    label,
    capabilities,
    async execute(request) {
      const { member, prompt, waitForCompletion } = request;
      const session = sm.getSession(member.sessionId);
      if (!session) {
        return failedExecution(provider, member.sessionId, `Session ${member.sessionId} for ${member.name} was not found`);
      }
      if (session.tool !== provider) {
        return failedExecution(provider, member.sessionId, `Session ${member.sessionId} is ${session.tool}, expected ${provider}`);
      }
      if (session.status !== "idle") {
        return failedExecution(provider, member.sessionId, `Session ${member.sessionId} for ${member.name} is ${session.status}`);
      }

      const result: IpcResponse = sm.sendTurn(member.sessionId, prompt);
      if (!result.ok) {
        const error = result.error ?? `Failed to send team turn to ${member.name}`;
        return failedExecution(provider, member.sessionId, error);
      }

      const completion = await waitForCompletion(member.sessionId);
      return {
        provider,
        sessionId: member.sessionId,
        ok: completion.status === "idle",
        ...completion,
      };
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function extractOpenCodeFinalText(stdout: string): string {
  return stripAnsi(stdout).trim();
}

function supportsOpenCodeModelArg(model: string | undefined): model is string {
  if (!model) return false;
  return /^[^/\s]+\/[^/\s]+$/.test(model);
}

function tailText(text: string, maxChars = DIAGNOSTIC_TAIL_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function diagnosticArgs(model: string | undefined, prompt: string): string[] {
  const args = ["run"];
  if (supportsOpenCodeModelArg(model)) {
    args.push("--model", model);
  }
  args.push(`<prompt:${prompt.length} chars>`);
  return args;
}

function sanitizeProcessError(error: string | undefined, prompt: string): string | undefined {
  if (!error) return undefined;
  return error.split(prompt).join(`<prompt:${prompt.length} chars>`);
}

function resolveCommand(commandEnv: string, executableName: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const override = env[commandEnv]?.trim();
  if (override) return Promise.resolve(override);
  return new Promise((resolve) => {
    child_process.execFile("sh", ["-lc", `command -v ${executableName}`], { timeout: 1500, maxBuffer: 4096 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const command = stdout.toString().trim().split(/\r?\n/)[0]?.trim();
      resolve(command || undefined);
    });
  });
}

function resolveOpenCodeCommand(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return resolveCommand(OPENCODE_COMMAND_ENV, "opencode", env);
}

function resolveOpenHandsCommand(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return resolveCommand(OPENHANDS_COMMAND_ENV, "openhands", env);
}

function execFileCaptured(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let spawnError: string | undefined;

    const child = child_process.spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      spawnError = err.message;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error: spawnError,
        timedOut,
      });
    });
  });
}

export const opencodeProviderAdapter: ProviderAdapter = {
  provider: "opencode",
  label: "OpenCode",
  capabilities: {
    canEdit: true,
    canReview: true,
    supportsVision: false,
    supportsLongRunning: false,
    supportsStatusPolling: false,
    supportsModelOverride: true,
  },
  async execute(request) {
    const { member, prompt, cwd } = request;
    if (!isOpenCodeProviderEnabled()) {
      return failedExecution("opencode", member.sessionId, `OpenCode provider is installed but disabled. Set ${OPENCODE_ENABLE_FLAG}=1 to enable execution.`);
    }

    const command = await resolveOpenCodeCommand();
    if (!command) {
      return failedExecution("opencode", member.sessionId, "OpenCode provider is enabled but the opencode executable was not found");
    }

    const args = ["run"];
    if (supportsOpenCodeModelArg(member.model)) {
      args.push("--model", member.model);
    }
    args.push(prompt);
    const diagnosticsBase = {
      command,
      args: diagnosticArgs(member.model, prompt),
      promptLength: prompt.length,
      modelArgApplied: supportsOpenCodeModelArg(member.model),
      cwd,
      timeoutMs: OPENCODE_EXECUTION_TIMEOUT_MS,
    };

    log(
      "[opencode] starting",
      `command=${command}`,
      `cwd=${cwd ?? ""}`,
      `promptLength=${prompt.length}`,
      `modelArgApplied=${diagnosticsBase.modelArgApplied ? "true" : "false"}`,
      `timeoutMs=${OPENCODE_EXECUTION_TIMEOUT_MS}`,
    );

    const result = await execFileCaptured(command, args, cwd, OPENCODE_EXECUTION_TIMEOUT_MS);
    const diagnostics = {
      ...diagnosticsBase,
      exitCode: result.exitCode,
      signal: result.signal,
      error: sanitizeProcessError(result.error, prompt),
      stdout: result.stdout,
      stdoutTail: tailText(result.stdout),
      stderr: result.stderr,
      stderrTail: tailText(result.stderr),
      timedOut: result.timedOut,
    };

    if (result.timedOut) {
      return failedExecution("opencode", member.sessionId, `OpenCode provider timed out after ${OPENCODE_EXECUTION_TIMEOUT_MS}ms`, diagnostics);
    }
    if (result.exitCode !== 0) {
      const stderr = stripAnsi(result.stderr).trim();
      const error = stderr || sanitizeProcessError(result.error, prompt) || `OpenCode provider exited with code ${result.exitCode}`;
      return failedExecution("opencode", member.sessionId, error, diagnostics);
    }

    return {
      provider: "opencode",
      sessionId: member.sessionId,
      ok: true,
      status: "idle",
      responseText: extractOpenCodeFinalText(result.stdout),
      errorText: stripAnsi(result.stderr).trim() || undefined,
      diagnostics,
    };
  },
};

function openHandsDiagnosticArgs(prompt: string): string[] {
  return [
    "-t",
    `<prompt:${prompt.length} chars>`,
    "--headless",
    "--json",
    "--always-approve",
    "--exit-without-confirmation",
  ];
}

function maybeJsonObjectFromLine(line: string): unknown | undefined {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Continue looking for parseable JSON within noisy output lines.
    }
  }
  return undefined;
}

function valueAtPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join("\n").trim();
  }
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text.trim();
  return [
    record.text,
    record.content,
    record.message,
    record.body,
  ].map(textFromUnknown).filter(Boolean).join("\n").trim();
}

function extractOpenHandsEventText(event: unknown): string {
  const candidatePaths = [
    ["message"],
    ["message", "content"],
    ["message", "text"],
    ["llm_message", "content"],
    ["llm_message", "text"],
    ["content"],
    ["text"],
    ["body"],
    ["payload", "message"],
    ["payload", "content"],
    ["payload", "text"],
    ["data", "message"],
    ["data", "content"],
    ["data", "text"],
  ];
  return candidatePaths
    .map((pathParts) => textFromUnknown(valueAtPath(event, pathParts)))
    .find((text) => text.length > 0) ?? "";
}

function stringField(event: unknown, paths: string[][]): string {
  for (const pathParts of paths) {
    const value = valueAtPath(event, pathParts);
    if (typeof value === "string") return value;
  }
  return "";
}

function isOpenHandsAssistantMessageEvent(event: unknown): boolean {
  const eventKind = stringField(event, [
    ["type"],
    ["event"],
    ["event_type"],
    ["kind"],
    ["class"],
    ["name"],
  ]).toLowerCase();
  const source = stringField(event, [
    ["source"],
    ["role"],
    ["sender"],
    ["author"],
    ["message", "role"],
    ["llm_message", "role"],
    ["payload", "source"],
    ["data", "source"],
  ]).toLowerCase();
  const looksLikeMessageEvent = !eventKind || /message/.test(eventKind);
  const fromAssistant = source === "assistant" || source === "agent" || source === "openhands";
  return looksLikeMessageEvent && fromAssistant;
}

function isOpenHandsNoiseText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return !normalized
    || normalized === "agent is working"
    || normalized === "goodbye"
    || normalized.startsWith("agent is working")
    || normalized.startsWith("conversation summary")
    || normalized.startsWith("conversation id")
    || normalized.startsWith("resume id");
}

function conversationIdFromEvent(event: unknown): string | undefined {
  const value = stringField(event, [
    ["conversation_id"],
    ["conversationId"],
    ["conversation", "id"],
    ["session_id"],
    ["sessionId"],
    ["resume_id"],
    ["resumeId"],
    ["payload", "conversation_id"],
    ["payload", "conversationId"],
    ["data", "conversation_id"],
    ["data", "conversationId"],
  ]).trim();
  return value || undefined;
}

function conversationIdFromText(text: string): string | undefined {
  const clean = stripAnsi(text);
  const patterns = [
    /conversation(?:\s+id|\s*\/\s*resume\s+id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{5,})/i,
    /resume\s+id\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{5,})/i,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function parseOpenHandsStdout(stdout: string): { finalText: string; assistantEventCount: number; conversationId?: string } {
  let finalText = "";
  let assistantEventCount = 0;
  let conversationId = conversationIdFromText(stdout);

  for (const line of stdout.split(/\r?\n/)) {
    const event = maybeJsonObjectFromLine(line);
    if (!event) continue;
    conversationId = conversationIdFromEvent(event) ?? conversationId;
    if (!isOpenHandsAssistantMessageEvent(event)) continue;
    const text = extractOpenHandsEventText(event);
    if (isOpenHandsNoiseText(text)) continue;
    assistantEventCount += 1;
    finalText = text;
  }

  return {
    finalText: finalText.trim(),
    assistantEventCount,
    conversationId,
  };
}

export const openHandsProviderAdapter: ProviderAdapter = {
  provider: "openhands",
  label: "OpenHands",
  capabilities: {
    canEdit: true,
    canReview: true,
    supportsVision: false,
    supportsLongRunning: true,
    supportsStatusPolling: false,
    supportsModelOverride: false,
  },
  async execute(request) {
    const { member, prompt, cwd } = request;
    if (!isOpenHandsProviderEnabled()) {
      return failedExecution("openhands", member.sessionId, `OpenHands provider is installed but disabled. Set ${OPENHANDS_ENABLE_FLAG}=1 to enable execution.`);
    }

    const command = await resolveOpenHandsCommand();
    if (!command) {
      return failedExecution("openhands", member.sessionId, "OpenHands provider is enabled but the openhands executable was not found");
    }

    const args = ["-t", prompt, "--headless", "--json", "--always-approve", "--exit-without-confirmation"];
    const diagnosticsBase = {
      command,
      args: openHandsDiagnosticArgs(prompt),
      promptLength: prompt.length,
      modelArgApplied: false,
      cwd,
      timeoutMs: OPENHANDS_EXECUTION_TIMEOUT_MS,
    };

    log(
      "[openhands] starting",
      `command=${command}`,
      `cwd=${cwd ?? ""}`,
      `promptLength=${prompt.length}`,
      "modelArgApplied=false",
      `timeoutMs=${OPENHANDS_EXECUTION_TIMEOUT_MS}`,
    );

    const result = await execFileCaptured(command, args, cwd, OPENHANDS_EXECUTION_TIMEOUT_MS);
    const parsed = parseOpenHandsStdout(result.stdout);
    const diagnostics = {
      ...diagnosticsBase,
      exitCode: result.exitCode,
      signal: result.signal,
      error: sanitizeProcessError(result.error, prompt),
      stdout: result.stdout,
      stdoutTail: tailText(result.stdout),
      stderr: result.stderr,
      stderrTail: tailText(result.stderr),
      parsedAssistantEventCount: parsed.assistantEventCount,
      conversationId: parsed.conversationId,
      timedOut: result.timedOut,
    };

    if (result.timedOut) {
      return failedExecution("openhands", member.sessionId, `OpenHands provider timed out after ${OPENHANDS_EXECUTION_TIMEOUT_MS}ms`, diagnostics);
    }
    if (result.exitCode !== 0) {
      const stderr = stripAnsi(result.stderr).trim();
      const error = stderr || sanitizeProcessError(result.error, prompt) || `OpenHands provider exited with code ${result.exitCode}`;
      return failedExecution("openhands", member.sessionId, error, diagnostics);
    }
    if (!parsed.finalText) {
      return failedExecution("openhands", member.sessionId, "OpenHands provider exited successfully but no assistant MessageEvent text was found", diagnostics);
    }

    return {
      provider: "openhands",
      sessionId: member.sessionId,
      ok: true,
      status: "idle",
      responseText: parsed.finalText,
      errorText: stripAnsi(result.stderr).trim() || undefined,
      diagnostics,
    };
  },
};

export const codexProviderAdapter: ProviderAdapter = makeCliProviderAdapter(
  "codex",
  "Codex",
  cliCapabilities(),
);

const cliProviderAdapters = new Map<Tool, ProviderAdapter>([
  ["claude", makeCliProviderAdapter("claude", "Claude", cliCapabilities({ supportsVision: true }))],
  ["codex", codexProviderAdapter],
  ["gemini", makeCliProviderAdapter("gemini", "Gemini", cliCapabilities({ supportsVision: true }))],
]);

const plannedProviders: ProviderRegistryEntry[] = [
  {
    id: "opencode",
    label: "OpenCode",
    type: "planned",
    status: "planned",
    available: false,
    enabled: false,
    executable: false,
    planned: true,
    modelOverride: false,
    capabilities: {
      canEdit: false,
      canReview: false,
      supportsVision: false,
      supportsLongRunning: false,
      supportsStatusPolling: false,
      supportsModelOverride: false,
    },
  },
  {
    id: "openhands",
    label: "OpenHands",
    type: "planned",
    status: "planned",
    available: false,
    enabled: false,
    executable: false,
    planned: true,
    modelOverride: false,
    capabilities: {
      canEdit: false,
      canReview: false,
      supportsVision: false,
      supportsLongRunning: false,
      supportsStatusPolling: false,
      supportsModelOverride: false,
    },
  },
];

export function getProviderAdapter(provider: string | undefined): ProviderAdapter | undefined {
  if (!provider) return undefined;
  if (provider === "opencode") return isOpenCodeProviderEnabled() ? opencodeProviderAdapter : undefined;
  if (provider === "openhands") return isOpenHandsProviderEnabled() ? openHandsProviderAdapter : undefined;
  return cliProviderAdapters.get(provider as Tool);
}

export function isExecutableAgentProvider(provider: string | undefined): provider is AgentProvider {
  return getProviderAdapter(provider) !== undefined;
}

function normalizeDetection(
  installedTools: Record<string, boolean | ProviderDetectionInfo>,
  provider: string,
): ProviderDetectionInfo {
  const detection = installedTools[provider];
  if (typeof detection === "boolean") return { available: detection };
  return detection ?? { available: false };
}

function plannedProviderEntry(
  entry: ProviderRegistryEntry,
  installedTools: Record<string, boolean | ProviderDetectionInfo>,
): ProviderRegistryEntry {
  const detection = normalizeDetection(installedTools, entry.id);
  const available = detection.available === true;
  return {
    ...entry,
    status: available ? "installed-but-not-executable" : entry.status,
    available,
    enabled: false,
    executable: false,
    detection,
  };
}

function openCodeProviderEntry(installedTools: Record<string, boolean | ProviderDetectionInfo>): ProviderRegistryEntry {
  const detection = normalizeDetection(installedTools, "opencode");
  const available = detection.available === true;
  const enabled = isOpenCodeProviderEnabled();
  return {
    id: "opencode",
    label: "OpenCode",
    type: enabled ? "cli" : "planned",
    status: available ? (enabled ? "enabled" : "installed-but-disabled") : "unavailable",
    available,
    enabled,
    executable: available && enabled,
    planned: !enabled,
    modelOverride: enabled && opencodeProviderAdapter.capabilities.supportsModelOverride,
    capabilities: opencodeProviderAdapter.capabilities,
    detection,
  };
}

function openHandsProviderEntry(installedTools: Record<string, boolean | ProviderDetectionInfo>): ProviderRegistryEntry {
  const detection = normalizeDetection(installedTools, "openhands");
  const available = detection.available === true;
  const enabled = isOpenHandsProviderEnabled();
  return {
    id: "openhands",
    label: "OpenHands",
    type: enabled ? "cli" : "planned",
    status: available ? (enabled ? "enabled" : "installed-but-disabled") : "unavailable",
    available,
    enabled,
    executable: available && enabled,
    planned: !enabled,
    modelOverride: false,
    capabilities: openHandsProviderAdapter.capabilities,
    detection,
  };
}

export function listProviderRegistryEntries(installedTools: Record<string, boolean | ProviderDetectionInfo>): ProviderRegistryEntry[] {
  const executable = [...cliProviderAdapters.values()].map((adapter) => {
    const detection = normalizeDetection(installedTools, adapter.provider);
    const available = detection.available === true;
    return {
      id: adapter.provider,
      label: adapter.label,
      type: "cli",
      status: available ? "enabled" : "unavailable",
      available,
      enabled: available,
      executable: true,
      planned: false,
      modelOverride: adapter.capabilities.supportsModelOverride,
      capabilities: adapter.capabilities,
      detection,
    } satisfies ProviderRegistryEntry;
  });

  return [
    ...executable,
    openCodeProviderEntry(installedTools),
    openHandsProviderEntry(installedTools),
    ...plannedProviders
      .filter((entry) => entry.id !== "opencode")
      .filter((entry) => entry.id !== "openhands")
      .map((entry) => plannedProviderEntry(entry, installedTools)),
  ];
}

export async function executeProviderTurn(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
  const adapter = getProviderAdapter(request.member.tool);
  if (!adapter) {
    if (request.member.tool === "opencode" && !isOpenCodeProviderEnabled()) {
      return failedExecution(
        "opencode",
        request.member.sessionId,
        `OpenCode provider is installed but disabled. Set ${OPENCODE_ENABLE_FLAG}=1 to enable execution.`,
      );
    }
    if (request.member.tool === "openhands" && !isOpenHandsProviderEnabled()) {
      return failedExecution(
        "openhands",
        request.member.sessionId,
        `OpenHands provider is installed but disabled. Set ${OPENHANDS_ENABLE_FLAG}=1 to enable execution.`,
      );
    }
    return failedExecution(
      request.member.tool,
      request.member.sessionId,
      `Team provider ${request.member.tool} is not enabled for execution`,
    );
  }
  return adapter.execute(request);
}
