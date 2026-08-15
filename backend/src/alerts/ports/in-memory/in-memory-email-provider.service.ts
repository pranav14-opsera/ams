import { Injectable } from "@nestjs/common";
import type { EmailMessage, EmailProviderPort } from "../email-provider.port";

@Injectable()
export class InMemoryEmailProviderService implements EmailProviderPort {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
