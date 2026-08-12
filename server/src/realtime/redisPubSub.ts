import Redis from "ioredis";

// ioredis requires two separate connections: one for publishing, one for
// subscribing — a subscribed connection can't issue other commands.
// This is what lets multiple backend instances (Phase spec calls for
// horizontal scaling) all broadcast to the same WebSocket clients: instance A
// publishes, every instance (including A) receives it via subscribe and
// forwards to whichever of its own sockets are in that org's room.
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const publisher = new Redis(REDIS_URL);
export const subscriber = new Redis(REDIS_URL);

// ioredis emits 'error' on every connection issue (including transient ones
// during local dev, e.g. Redis not started yet) — without a listener, Node
// treats it as an unhandled error and crashes the process.
publisher.on("error", (err) => console.error("Redis publisher error:", err.message));
subscriber.on("error", (err) => console.error("Redis subscriber error:", err.message));

export const INCIDENT_EVENTS_CHANNEL = "pulseops:incident-events";

export type IncidentEventMessage =
  | { orgId: string; type: "incident:created" | "incident:updated"; incident: unknown }
  | { orgId: string; type: "incident:triage-ready"; incidentId: string };

export function publishIncidentEvent(msg: IncidentEventMessage) {
  return publisher.publish(INCIDENT_EVENTS_CHANNEL, JSON.stringify(msg));
}
