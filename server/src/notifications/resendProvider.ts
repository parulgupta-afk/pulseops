import type { NotificationProvider, SendNotificationParams, SendNotificationResult } from "./types";

// Real email delivery via Resend (resend.com) — free tier (100/day), signup
// is just an email + password, no domain verification required to start
// sending. Without a verified domain, Resend requires sending FROM their
// shared "onboarding@resend.dev" address and restricts delivery to the email
// you signed up with — fine for paging yourself in a demo, not for paging a
// teammate's real inbox unless you verify your own domain.
//
// Handles the 'email' channel only; the composite router in index.ts falls
// back to the mock provider for 'sms'.
export class ResendEmailProvider implements NotificationProvider {
  constructor(
    private apiKey: string,
    private fromAddress: string = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev"
  ) {}

  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    if (params.channel !== "email") {
      return { success: false, error: "ResendEmailProvider only handles the 'email' channel" };
    }
    if (!params.to.email) {
      return { success: false, error: "No email address on file for this responder" };
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: params.to.email,
        subject: params.subject,
        text: params.message,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { success: false, error: `Resend request failed (${res.status}): ${body}` };
    }
    return { success: true };
  }
}
