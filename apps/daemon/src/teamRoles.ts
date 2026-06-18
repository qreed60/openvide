import type { TeamConfig, TeamMember } from "./types.js";
import { SUPPORTED_TEAM_ROLES } from "./teamMetadata.js";

const ROLE_ALIASES = new Map<string, string>();
for (const role of SUPPORTED_TEAM_ROLES) {
  ROLE_ALIASES.set(role.id, role.id);
  for (const alias of role.aliases) {
    ROLE_ALIASES.set(alias, role.id);
  }
}

export function normalizeTeamRole(role: string | undefined): TeamMember["role"] {
  const raw = (role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const normalized = ROLE_ALIASES.get(raw);
  if (normalized) return normalized as TeamMember["role"];
  return (raw || "coder") as TeamMember["role"];
}

export function roleMatches(member: TeamMember, roles: string[]): boolean {
  const normalized = normalizeTeamRole(member.role);
  return roles.includes(normalized);
}

export function getCoordinatorMember(team: TeamConfig): TeamMember | undefined {
  return team.members.find((member) => roleMatches(member, ["lead"]))
    ?? team.members.find((member) => member.name.trim().toLowerCase() === "lead")
    ?? team.members.find((member) => roleMatches(member, ["planner"]))
    ?? team.members[0];
}
