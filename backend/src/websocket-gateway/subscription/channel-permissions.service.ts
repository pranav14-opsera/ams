import { Injectable } from "@nestjs/common";
import type { ChannelPermissionRule } from "./subscription.types";

/**
 * Channel -> required-permission mapping. PHI-adjacent channels
 * (`phi-access`) require `audit_access:phi_monitoring:view`, the same
 * permission the REST audit endpoints gate on (rbac.constants.ts) — kept
 * in sync deliberately, not reinvented for WebSocket delivery.
 */
const DEFAULT_CHANNEL_RULES: ChannelPermissionRule[] = [
  { channel: "agent-health" },
  { channel: "credit-balance" },
  { channel: "alerts" },
  { channel: "phi-access", requiredPermissions: ["audit_access:phi_monitoring:view"] },
];

const WILDCARD_SUFFIX = ":*";

@Injectable()
export class ChannelPermissionsService {
  private readonly rulesByChannel: Map<string, ChannelPermissionRule>;

  constructor(rules: ChannelPermissionRule[] = DEFAULT_CHANNEL_RULES) {
    this.rulesByChannel = new Map(rules.map((rule) => [rule.channel, rule]));
  }

  /** No rule registered for a channel = open to any authenticated tenant member (fail-open only for channels nobody has restricted; unknown/mistyped channel names are handled by handleSubscribe never finding a match). */
  checkPermission(channel: string, userPermissions: string[]): boolean {
    const rule = this.rulesByChannel.get(channel);
    if (!rule || !rule.requiredPermissions || rule.requiredPermissions.length === 0) return true;

    return rule.requiredPermissions.some((required) => this.userHasPermission(userPermissions, required));
  }

  private userHasPermission(userPermissions: string[], required: string): boolean {
    if (userPermissions.includes(required)) return true;

    const [featureArea] = required.split(":");
    return userPermissions.includes(`${featureArea}${WILDCARD_SUFFIX}`);
  }

  getRule(channel: string): ChannelPermissionRule | undefined {
    return this.rulesByChannel.get(channel);
  }
}
