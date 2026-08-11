import type { NotificationProvider } from "./types";
import { MockNotificationProvider } from "./mockProvider";

// Single place that decides which provider implementation is live. Swapping
// in real Twilio/SendGrid later means writing a TwilioProvider/SendGridProvider
// class that implements NotificationProvider, and changing this one line —
// nothing in the queue worker or escalation logic needs to change.
const failureRate = process.env.NOTIFICATION_SIMULATE_FAILURES === "true" ? 0.35 : 0;

export const notificationProvider: NotificationProvider = new MockNotificationProvider(failureRate);

export * from "./types";
