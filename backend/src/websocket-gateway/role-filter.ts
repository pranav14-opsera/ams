/**
 * A message with no `requiredRoles` (or an empty array) is visible to
 * everyone connected to that channel; otherwise the connected user must
 * hold at least one of the listed roles — e.g. a Finance Manager never
 * receives agent trace data, an Agent Operator never receives credit
 * allocation changes, per this WO's own example.
 */
export function isAuthorizedForMessage(requiredRoles: string[] | undefined, userRoles: string[]): boolean {
  if (!requiredRoles || requiredRoles.length === 0) return true;
  return requiredRoles.some((role) => userRoles.includes(role));
}
