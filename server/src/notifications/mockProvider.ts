import type { NotificationProvider, SendNotificationParams, SendNotificationResult } from "./types";

// Stands in for Twilio/SendGrid so the retry-with-backoff and escalation
// logic is real and testable without a paid SMS number or API keys. Logs to
// stdout instead of actually sending anything.
//
// Set NOTIFICATION_SIMULATE_FAILURES=true to make it fail a fraction of the
// time on purpose — useful for actually watching BullMQ's retry/backoff
// kick in during a demo, rather than just trusting it works.
export class MockNotificationProvider implements NotificationProvider {
  private failureRate: number;

  constructor(failureRate = 0) {
    this.failureRate = failureRate;
  }

  async send(params: SendNotificationParams): Promise<SendNotificationResult> {
    // Simulate real network latency so retry/backoff timing is visible in logs.
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (Math.random() < this.failureRate) {
      console.log(
        `[mock-notify] SIMULATED FAILURE sending ${params.channel} to ${params.to.name}: "${params.subject}"`
      );
      return { success: false, error: "Simulated transient provider failure" };
    }

    const destination =
      params.channel === "sms" ? params.to.phone ?? "(no phone on file)" : params.to.email ?? "(no email on file)";

    console.log(
      `[mock-notify] ${params.channel.toUpperCase()} to ${params.to.name} <${destination}>: "${params.subject}" — ${params.message}`
    );
    return { success: true };
  }
}
