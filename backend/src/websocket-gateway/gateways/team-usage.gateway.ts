import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

/** WO-075: team-scoped usage dashboard's real-time push channel — thin subclass, same shape as org-usage.gateway.ts. Path matches this WO's own api_contracts intent: "WebSocket: ws://gateway/ws/dashboard/usage/team". */
@WebSocketGateway({ path: "/ws/dashboard/usage/team" })
export class TeamUsageGateway extends BaseRealtimeGateway {
  protected readonly channel = "team_usage";
}
