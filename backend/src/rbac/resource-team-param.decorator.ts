import { SetMetadata } from "@nestjs/common";

export const RESOURCE_TEAM_PARAM_KEY = "rbac:resource_team_param";

/**
 * Declares which route param (e.g. "teamId" on `/agents/:agentId/team/:teamId`,
 * or a param carrying the resource's own team directly) names the team a
 * requested resource belongs to. RbacGuard only runs the team-scope check
 * (AC #3: team_lead/agent_operator cannot cross into another team) when a
 * route opts in via this decorator — no feature-area resource controllers
 * exist in this codebase yet (agent management, credit management, etc.
 * are separate, later work orders), so there is nothing to enforce this
 * against until those routes declare it.
 */
export const ResourceTeamParam = (paramName: string) => SetMetadata(RESOURCE_TEAM_PARAM_KEY, paramName);
