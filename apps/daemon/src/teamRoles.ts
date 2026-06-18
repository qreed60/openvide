import type { TeamConfig, TeamMember } from "./types.js";

export function normalizeTeamRole(role: string | undefined): TeamMember["role"] {
  const raw = (role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "coordinator") return "lead";
  if (raw === "lead") return "lead";
  if (raw === "tester") return "tester";
  if (raw === "visual" || raw === "visual_reviewer") return raw;
  if (raw === "scribe") return "scribe";
  if (raw === "coder" || raw === "reviewer" || raw === "planner") return raw;
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
