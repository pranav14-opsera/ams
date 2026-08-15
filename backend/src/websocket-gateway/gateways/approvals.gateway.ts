import { WebSocketGateway } from "@nestjs/websockets";
import { BaseRealtimeGateway } from "./base-realtime.gateway";

@WebSocketGateway({ path: "/ws/approvals" })
export class ApprovalsGateway extends BaseRealtimeGateway {
  protected readonly channel = "approvals";
}
