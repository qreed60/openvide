import * as child_process from "node:child_process";
import * as sm from "./sessionManager.js";
import type { IpcResponse, TeamMember, TeamTool, Tool } from "./types.js";

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
    cwd?: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
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
const OPENCODE_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

export function isOpenCodeProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[OPENCODE_ENABLE_FLAG] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
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

function resolveOpenCodeCommand(): Promise<string | undefined> {
  return new Promise((resolve) => {
    child_process.execFile("sh", ["-lc", "command -v opencode"], { timeout: 1500, maxBuffer: 4096 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const command = stdout.toString().trim().split(/\r?\n/)[0]?.trim();
      resolve(command || undefined);
    });
  });
}

function execFileCaptured(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    child_process.execFile(command, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const nodeErr = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals }) | null;
      resolve({
        exitCode: typeof nodeErr?.code === "number" ? nodeErr.code : nodeErr ? null : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        error: nodeErr ? nodeErr.message : undefined,
        timedOut: Boolean(nodeErr?.killed && nodeErr?.signal === "SIGTERM"),
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

    const result = await execFileCaptured(command, args, cwd, OPENCODE_EXECUTION_TIMEOUT_MS);
    const diagnostics = {
      command,
      args,
      cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };

    if (result.timedOut) {
      return failedExecution("opencode", member.sessionId, `OpenCode provider timed out after ${OPENCODE_EXECUTION_TIMEOUT_MS}ms`, diagnostics);
    }
    if (result.exitCode !== 0) {
      const stderr = stripAnsi(result.stderr).trim();
      const error = stderr || result.error || `OpenCode provider exited with code ${result.exitCode}`;
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
    ...plannedProviders
      .filter((entry) => entry.id !== "opencode")
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
    return failedExecution(
      request.member.tool,
      request.member.sessionId,
      `Team provider ${request.member.tool} is not enabled for execution`,
    );
  }
  return adapter.execute(request);
}
