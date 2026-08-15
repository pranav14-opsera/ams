import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

/** WO-056: agent health dashboard's real-time push channel — thin subclass, same shape as dashboard.gateway.ts/alerts.gateway.ts. */
@WebSocketGateway({ path: "/ws/health" })
export class HealthGateway extends BaseRealtimeGateway {
  protected readonly channel = "health";
}
