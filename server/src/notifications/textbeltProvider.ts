import type { NotificationProvider, SendNotificationParams, SendNotificationResult } from "./types";

// Real SMS delivery via Textbelt (textbelt.com) — genuinely no signup: the
// shared key "textbelt" sends 1 free real SMS per day, no account, no phone
// verification. Enough to demo a real SMS page once; beyond that it fails
// with a quota error until the next day (or you buy credit / set your own key).
//
// Handles the 'sms' channel only; the composite router in index.ts falls
// back to the mock provider for 'email'.
export class TextbeltSmsProvider implements NotificationProvider {
  constructor(private apiKey: string = process.env.TEXTBELT_KEY || "textbelt") {}

  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    if (params.channel !== "sms") {
      return { success: false, error: "TextbeltSmsProvider only handles the 'sms' channel" };
    }
    if (!params.to.phone) {
      return { success: false, error: "No phone number on file for this responder" };
    }

    const res = await fetch("https://textbelt.com/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: params.to.phone,
        message: `${params.subject}\n${params.message}`,
        key: this.apiKey,
      }),
    });

    const data = await res.json();
    if (!data.success) {
      // The most common failure on the free shared key is simply "you're out
      // of today's 1-message quota" — surfaced explicitly so it reads as a
      // known limitation in logs, not a mysterious silent failure.
      return { success: false, error: data.error || "Textbelt send failed" };
    }
    return { success: true };
  }
}
