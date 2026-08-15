import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

@WebSocketGateway({ path: "/ws/dashboard" })
export class DashboardGateway extends BaseRealtimeGateway {
  protected readonly channel = "dashboard";
}
