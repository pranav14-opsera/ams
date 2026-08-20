import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

/** WO-074: org-wide usage dashboard's real-time push channel — thin subclass, same shape as health.gateway.ts/dashboard.gateway.ts. Path matches the WO's own api_contracts: "WebSocket: ws://gateway/ws/dashboard/usage/org". */
@WebSocketGateway({ path: "/ws/dashboard/usage/org" })
export class OrgUsageGateway extends BaseRealtimeGateway {
  protected readonly channel = "org_usage";
}
