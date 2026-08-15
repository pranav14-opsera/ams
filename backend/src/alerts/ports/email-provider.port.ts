export const EMAIL_PROVIDER = "EMAIL_PROVIDER";

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
}

export interface EmailProviderPort {
  send(message: EmailMessage): Promise<void>;
}
