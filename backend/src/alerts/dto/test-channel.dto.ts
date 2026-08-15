import { IsIn } from "class-validator";
import { CHANNEL_TYPES, type ChannelType } from "../alert-delivery.types";

export class TestChannelDto {
  @IsIn(CHANNEL_TYPES)
  channelType!: ChannelType;

  /** Which configured channel instance to test (webhook/email config id) — omitted for "websocket" (nothing to test connectivity to; it's always the same gateway). */
  configId?: string;
}
