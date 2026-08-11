import type { NotificationChannel } from "@pulseops/shared-types";

export interface SendNotificationParams {
  channel: NotificationChannel;
  to: { name: string; email: string | null; phone: string | null };
  subject: string;
  message: string;
}

export interface SendNotificationResult {
  success: boolean;
  error?: string;
}

// Every real provider (Twilio, SendGrid, MSG91, whatever) implements this
// same interface. The queue worker only ever talks to this interface — it
// has no idea whether it's hitting a real API or a mock. That's what makes
// swapping in real SMS/email later a one-line change in notifications/index.ts
// instead of a rewrite of the retry/escalation logic.
export interface NotificationProvider {
  send(params: SendNotificationParams): Promise<SendNotificationResult>;
}
