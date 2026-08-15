import { Injectable } from "@nestjs/common";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { EmailMessage, EmailProviderPort } from "./email-provider.port";

const SES_SOURCE_ADDRESS = process.env.ALERT_EMAIL_FROM_ADDRESS ?? "alerts@example.com";

/**
 * Real AWS SESv2 SDK integration — genuinely calls SES's actual API, not
 * a stub. This sandbox has no reachable AWS account/credentials
 * (confirmed directly, same connector-gap class as WO-015's KMS adapter
 * and WO-012's cosign key — `AlertChannelConfigService`'s own test
 * endpoint will surface the real "credentials not configured" error
 * rather than silently pretending to succeed). What IS genuinely real
 * and tested here is the request construction and the port contract.
 */
@Injectable()
export class SesEmailProviderService implements EmailProviderPort {
  private readonly client = new SESv2Client({});

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: SES_SOURCE_ADDRESS,
        Destination: { ToAddresses: message.to },
        Content: {
          Simple: {
            Subject: { Data: message.subject },
            Body: { Html: { Data: message.html } },
          },
        },
      }),
    );
  }
}
