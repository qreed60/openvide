export interface TeamRoleMetadata {
  id: string;
  label: string;
  aliases?: string[];
  canEdit?: boolean;
  canReview?: boolean;
  defaultReadOnly?: boolean;
}

export interface TeamProviderMetadata {
  id: string;
  label: string;
  status: 'enabled' | 'planned' | 'disabled' | 'unavailable';
  available: boolean;
  enabled: boolean;
  planned: boolean;
  modelOverride: boolean;
  capabilities: {
    canEdit: boolean;
    canReview: boolean;
    supportsVision: boolean;
    supportsLongRunning: boolean;
    supportsStatusPolling: boolean;
    supportsModelOverride: boolean;
  };
}

export interface TeamMetadata {
  roles: TeamRoleMetadata[];
  providers: TeamProviderMetadata[];
}

export const FALLBACK_TEAM_METADATA: TeamMetadata = {
  roles: [
    { id: 'lead', label: 'Lead', aliases: ['coordinator'], canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'planner', label: 'Planner', canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'coder', label: 'Coder', canEdit: true, canReview: false, defaultReadOnly: false },
    { id: 'reviewer', label: 'Reviewer', canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'scribe', label: 'Scribe', aliases: ['tester'], canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'tester', label: 'Tester', canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'visual_reviewer', label: 'Visual Reviewer', aliases: ['visual'], canEdit: false, canReview: true, defaultReadOnly: true },
    { id: 'visual', label: 'Visual', canEdit: true, canReview: true, defaultReadOnly: false },
    { id: 'domain_specialist', label: 'Domain Specialist', canEdit: false, canReview: true, defaultReadOnly: true },
  ],
  providers: [
    {
      id: 'claude',
      label: 'Claude',
      status: 'enabled',
      available: true,
      enabled: true,
      planned: false,
      modelOverride: true,
      capabilities: { canEdit: true, canReview: true, supportsVision: true, supportsLongRunning: false, supportsStatusPolling: true, supportsModelOverride: true },
    },
    {
      id: 'codex',
      label: 'Codex',
      status: 'enabled',
      available: true,
      enabled: true,
      planned: false,
      modelOverride: true,
      capabilities: { canEdit: true, canReview: true, supportsVision: false, supportsLongRunning: false, supportsStatusPolling: true, supportsModelOverride: true },
    },
    {
      id: 'gemini',
      label: 'Gemini',
      status: 'enabled',
      available: true,
      enabled: true,
      planned: false,
      modelOverride: true,
      capabilities: { canEdit: true, canReview: true, supportsVision: true, supportsLongRunning: false, supportsStatusPolling: true, supportsModelOverride: true },
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      status: 'planned',
      available: false,
      enabled: false,
      planned: true,
      modelOverride: false,
      capabilities: { canEdit: true, canReview: true, supportsVision: false, supportsLongRunning: false, supportsStatusPolling: false, supportsModelOverride: false },
    },
    {
      id: 'openhands',
      label: 'OpenHands',
      status: 'planned',
      available: false,
      enabled: false,
      planned: true,
      modelOverride: false,
      capabilities: { canEdit: true, canReview: false, supportsVision: false, supportsLongRunning: true, supportsStatusPolling: false, supportsModelOverride: false },
    },
  ],
};

export function roleOptions(metadata: TeamMetadata, currentRole?: string): Array<{ value: string; label: string }> {
  const options = metadata.roles.map((role) => ({ value: role.id, label: role.label }));
  if (currentRole && !options.some((option) => option.value === currentRole)) {
    options.push({ value: currentRole, label: `${currentRole} (custom)` });
  }
  return options;
}

export function executableProviderOptions(metadata: TeamMetadata, currentTool?: string): Array<{ value: string; label: string }> {
  const options = metadata.providers
    .filter((provider) => !provider.planned && provider.id !== 'opencode' && provider.id !== 'openhands')
    .map((provider) => ({
      value: provider.id,
      label: `${provider.label}${provider.available ? '' : ' (unavailable)'}`,
    }));
  if (currentTool && !options.some((option) => option.value === currentTool)) {
    options.push({ value: currentTool, label: `${currentTool} (existing)` });
  }
  return options;
}

export function providerHint(metadata: TeamMetadata, tool: string): string {
  const provider = metadata.providers.find((item) => item.id === tool);
  if (!provider) return 'Custom provider from existing team';
  const status = provider.planned ? 'planned' : provider.available ? 'available' : 'unavailable';
  const flags = [
    provider.modelOverride ? 'model override' : undefined,
    provider.capabilities.supportsVision ? 'vision' : undefined,
    provider.capabilities.canEdit ? 'write-capable' : 'read-focused',
    provider.capabilities.supportsLongRunning ? 'long-running' : undefined,
  ].filter(Boolean);
  return `${provider.label}: ${status}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
}

export function plannedProviderHints(metadata: TeamMetadata): string[] {
  return metadata.providers
    .filter((provider) => provider.planned || provider.id === 'opencode' || provider.id === 'openhands')
    .map((provider) => `${provider.label}: ${provider.status}`);
}

export function roleHint(metadata: TeamMetadata, roleId: string): string {
  const role = metadata.roles.find((item) => item.id === roleId);
  if (!role) return 'Custom role preserved';
  const flags = [
    role.canEdit ? 'can edit' : 'read-focused',
    role.canReview ? 'can review' : undefined,
    role.defaultReadOnly ? 'default read-only' : undefined,
  ].filter(Boolean);
  return flags.join(' · ');
}
