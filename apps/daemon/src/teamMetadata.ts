import { isExecutableAgentProvider, listProviderRegistryEntries } from "./agentProviders.js";
import type { AgentProvider, ProviderCapabilities, ProviderStatus } from "./agentProviders.js";

export type TeamProviderId = AgentProvider;
export type TeamProviderStatus = ProviderStatus;

export interface TeamRoleMetadata {
  id: string;
  label: string;
  aliases: string[];
  canEdit: boolean;
  canReview: boolean;
  defaultReadOnly: boolean;
}

export interface TeamProviderCapabilities extends ProviderCapabilities {}

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

export const isExecutableTeamTool = isExecutableAgentProvider;

export function getTeamMetadata(installedTools: Record<string, boolean>): TeamMetadata {
  return {
    roles: SUPPORTED_TEAM_ROLES,
    providers: listProviderRegistryEntries(installedTools),
  };
}
