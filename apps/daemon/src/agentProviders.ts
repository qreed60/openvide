import * as sm from "./sessionManager.js";
import type { IpcResponse, TeamMember, Tool } from "./types.js";

export type AgentProvider = Tool | "opencode" | "openhands";
export type ProviderStatus = "enabled" | "planned" | "disabled" | "unavailable";

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
  waitForCompletion: (sessionId: string) => Promise<ProviderExecutionCompletion>;
}

export interface ProviderExecutionResult extends ProviderExecutionCompletion {
  provider: AgentProvider;
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface ProviderAdapter {
  provider: Tool;
  label: string;
  capabilities: ProviderCapabilities;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

export interface ProviderRegistryEntry {
  id: AgentProvider;
  label: string;
  status: ProviderStatus;
  available: boolean;
  enabled: boolean;
  planned: boolean;
  modelOverride: boolean;
  capabilities: ProviderCapabilities;
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

function failedExecution(
  provider: AgentProvider,
  sessionId: string,
  error: string,
): ProviderExecutionResult {
  return {
    provider,
    sessionId,
    ok: false,
    status: "failed",
    responseText: "",
    errorText: error,
    error,
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

export const codexProviderAdapter: ProviderAdapter = makeCliProviderAdapter(
  "codex",
  "Codex",
  cliCapabilities(),
);

const providerAdapters = new Map<Tool, ProviderAdapter>([
  ["claude", makeCliProviderAdapter("claude", "Claude", cliCapabilities({ supportsVision: true }))],
  ["codex", codexProviderAdapter],
  ["gemini", makeCliProviderAdapter("gemini", "Gemini", cliCapabilities({ supportsVision: true }))],
]);

const plannedProviders: ProviderRegistryEntry[] = [
  {
    id: "opencode",
    label: "OpenCode",
    status: "planned",
    available: false,
    enabled: false,
    planned: true,
    modelOverride: false,
    capabilities: {
      canEdit: true,
      canReview: true,
      supportsVision: false,
      supportsLongRunning: false,
      supportsStatusPolling: false,
      supportsModelOverride: false,
    },
  },
  {
    id: "openhands",
    label: "OpenHands",
    status: "planned",
    available: false,
    enabled: false,
    planned: true,
    modelOverride: false,
    capabilities: {
      canEdit: true,
      canReview: false,
      supportsVision: false,
      supportsLongRunning: true,
      supportsStatusPolling: false,
      supportsModelOverride: false,
    },
  },
];

export function getProviderAdapter(provider: string | undefined): ProviderAdapter | undefined {
  if (!provider) return undefined;
  return providerAdapters.get(provider as Tool);
}

export function isExecutableAgentProvider(provider: string | undefined): provider is Tool {
  return getProviderAdapter(provider) !== undefined;
}

export function listProviderRegistryEntries(installedTools: Record<string, boolean>): ProviderRegistryEntry[] {
  const executable = [...providerAdapters.values()].map((adapter) => {
    const available = installedTools[adapter.provider] === true;
    return {
      id: adapter.provider,
      label: adapter.label,
      status: available ? "enabled" : "unavailable",
      available,
      enabled: available,
      planned: false,
      modelOverride: adapter.capabilities.supportsModelOverride,
      capabilities: adapter.capabilities,
    } satisfies ProviderRegistryEntry;
  });

  return [...executable, ...plannedProviders];
}

export async function executeProviderTurn(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
  const adapter = getProviderAdapter(request.member.tool);
  if (!adapter) {
    return failedExecution(
      request.member.tool,
      request.member.sessionId,
      `Team provider ${request.member.tool} is not enabled for execution`,
    );
  }
  return adapter.execute(request);
}
