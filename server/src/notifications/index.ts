import type { NotificationProvider, SendNotificationParams, SendNotificationResult } from "./types";
import { MockNotificationProvider } from "./mockProvider";
import { ResendEmailProvider } from "./resendProvider";
import { TextbeltSmsProvider } from "./textbeltProvider";

// Per-channel provider selection: email and SMS are configured (and can be
// real vs. mock) completely independently. That way "I've set up Resend but
// haven't touched SMS yet" degrades gracefully — email pages go out for
// real, SMS pages fall back to the mock — instead of an all-or-nothing switch.
const failureRate = process.env.NOTIFICATION_SIMULATE_FAILURES === "true" ? 0.35 : 0;
const mock = new MockNotificationProvider(failureRate);

const resendKey = process.env.RESEND_API_KEY?.trim();
const emailProvider: NotificationProvider = resendKey ? new ResendEmailProvider(resendKey) : mock;

// Textbelt's shared "textbelt" key needs no signup or key at all, which
// means — unlike every other provider in this project — it's technically
// possible to send a REAL text message with zero configuration. That's
// surprising behavior for something that's supposed to default to safe/mock,
// so SMS requires an explicit opt-in (TEXTBELT_ENABLED=true) even though no
// key is strictly required, rather than silently going live by default.
const textbeltEnabled = process.env.TEXTBELT_ENABLED === "true";
const smsProvider: NotificationProvider = textbeltEnabled
  ? new TextbeltSmsProvider(process.env.TEXTBELT_KEY)
  : mock;

if (!resendKey) {
  console.log(
    "[notifications] No RESEND_API_KEY set — email pages will use the mock provider. " +
      "Get a free key at https://resend.com/api-keys"
  );
}
if (!textbeltEnabled) {
  console.log(
    "[notifications] TEXTBELT_ENABLED is not 'true' — SMS pages will use the mock provider. " +
      "Set TEXTBELT_ENABLED=true to send real SMS via Textbelt's free shared key (1/day), " +
      "or set TEXTBELT_KEY to your own key for more."
  );
}

class CompositeNotificationProvider implements NotificationProvider {
  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    const provider = params.channel === "email" ? emailProvider : smsProvider;
    return provider.send(params);
  }
}

export const notificationProvider: NotificationProvider = new CompositeNotificationProvider();

export * from "./types";
