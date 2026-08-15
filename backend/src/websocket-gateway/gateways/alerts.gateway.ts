import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

@WebSocketGateway({ path: "/ws/alerts" })
export class AlertsGateway extends BaseRealtimeGateway {
  protected readonly channel = "alerts";
}
