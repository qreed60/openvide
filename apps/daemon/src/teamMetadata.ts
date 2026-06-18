import type { Tool } from "./types.js";

export type TeamProviderId = Tool | "opencode" | "openhands";
export type TeamProviderStatus = "enabled" | "planned" | "disabled" | "unavailable";

export interface TeamRoleMetadata {
  id: string;
  label: string;
  aliases: string[];
  canEdit: boolean;
  canReview: boolean;
  defaultReadOnly: boolean;
}

export interface TeamProviderCapabilities {
  canEdit: boolean;
  canReview: boolean;
  supportsVision: boolean;
  supportsLongRunning: boolean;
  supportsStatusPolling: boolean;
  supportsModelOverride: boolean;
}

export interface TeamProviderMetadata {
  id: TeamProviderId;
  label: string;
  status: TeamProviderStatus;
  available: boolean;
  enabled: boolean;
  planned: boolean;
  modelOverride: boolean;
  capabilities: TeamProviderCapabilities;
}

export interface TeamMetadata {
  roles: TeamRoleMetadata[];
  providers: TeamProviderMetadata[];
}

export const SUPPORTED_TEAM_ROLES: TeamRoleMetadata[] = [
  { id: "lead", label: "Lead", aliases: ["coordinator"], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "planner", label: "Planner", aliases: [], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "coder", label: "Coder", aliases: [], canEdit: true, canReview: false, defaultReadOnly: false },
  { id: "reviewer", label: "Reviewer", aliases: [], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "scribe", label: "Scribe", aliases: ["tester"], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "tester", label: "Tester", aliases: [], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "visual_reviewer", label: "Visual Reviewer", aliases: ["visual"], canEdit: false, canReview: true, defaultReadOnly: true },
  { id: "visual", label: "Visual", aliases: [], canEdit: true, canReview: true, defaultReadOnly: false },
  { id: "domain_specialist", label: "Domain Specialist", aliases: [], canEdit: false, canReview: true, defaultReadOnly: true },
];

export function isExecutableTeamTool(tool: string | undefined): tool is Tool {
  return tool === "claude" || tool === "codex" || tool === "gemini";
}

function executableProvider(id: Tool, label: string, available: boolean, capabilities: Omit<TeamProviderCapabilities, "supportsModelOverride">): TeamProviderMetadata {
  return {
    id,
    label,
    status: available ? "enabled" : "unavailable",
    available,
    enabled: available,
    planned: false,
    modelOverride: true,
    capabilities: {
      ...capabilities,
      supportsModelOverride: true,
    },
  };
}

function plannedProvider(id: "opencode" | "openhands", label: string, capabilities: TeamProviderCapabilities): TeamProviderMetadata {
  return {
    id,
    label,
    status: "planned",
    available: false,
    enabled: false,
    planned: true,
    modelOverride: false,
    capabilities,
  };
}

export function getTeamMetadata(installedTools: Record<string, boolean>): TeamMetadata {
  return {
    roles: SUPPORTED_TEAM_ROLES,
    providers: [
      executableProvider("claude", "Claude", installedTools.claude === true, {
        canEdit: true,
        canReview: true,
        supportsVision: true,
        supportsLongRunning: false,
        supportsStatusPolling: true,
      }),
      executableProvider("codex", "Codex", installedTools.codex === true, {
        canEdit: true,
        canReview: true,
        supportsVision: false,
        supportsLongRunning: false,
        supportsStatusPolling: true,
      }),
      executableProvider("gemini", "Gemini", installedTools.gemini === true, {
        canEdit: true,
        canReview: true,
        supportsVision: true,
        supportsLongRunning: false,
        supportsStatusPolling: true,
      }),
      plannedProvider("opencode", "OpenCode", {
        canEdit: true,
        canReview: true,
        supportsVision: false,
        supportsLongRunning: false,
        supportsStatusPolling: false,
        supportsModelOverride: false,
      }),
      plannedProvider("openhands", "OpenHands", {
        canEdit: true,
        canReview: false,
        supportsVision: false,
        supportsLongRunning: true,
        supportsStatusPolling: false,
        supportsModelOverride: false,
      }),
    ],
  };
}
