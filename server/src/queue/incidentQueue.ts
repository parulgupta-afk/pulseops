import { Queue } from "bullmq";
import { bullConnection } from "./connection";

export const INCIDENT_QUEUE_NAME = "incident-paging";

// This is the "enqueue" side, used by the API process (index.ts / routes).
// The actual work happens in worker.ts, running as a separate process — that
// separation is the whole point: the API responds to the webhook immediately
// (fast 201) without waiting on a notification send that might be slow or
// retrying, exactly per the spec's "incidents are pushed onto a queue rather
// than handled inline" requirement.
export const incidentQueue = new Queue(INCIDENT_QUEUE_NAME, { connection: bullConnection });

export interface PageJobData {
  type: "page";
  incidentId: string;
  orgId: string;
  step: number; // index into the escalation policy's steps array
}

export interface EscalationCheckJobData {
  type: "escalation-check";
  incidentId: string;
  orgId: string;
  step: number; // the step that was just paged — check if it's still unacked
}

export interface EmbedAndSuggestJobData {
  type: "embed-and-suggest";
  incidentId: string;
  orgId: string;
}

export type IncidentJobData = PageJobData | EscalationCheckJobData | EmbedAndSuggestJobData;

export function enqueuePage(data: Omit<PageJobData, "type">) {
  // 3 attempts with exponential backoff — this is what actually exercises
  // the "retry with backoff before escalating" requirement when the mock
  // provider simulates a transient failure.
  return incidentQueue.add(
    "page",
    { type: "page", ...data },
    { attempts: 3, backoff: { type: "exponential", delay: 2000 } }
  );
}

export function enqueueEscalationCheck(data: Omit<EscalationCheckJobData, "type">, delayMs: number) {
  return incidentQueue.add(
    "escalation-check",
    { type: "escalation-check", ...data },
    { delay: delayMs }
  );
}

export function enqueueEmbedAndSuggest(data: Omit<EmbedAndSuggestJobData, "type">) {
  // Gemini calls (or the mock's simulated latency) shouldn't hold up the
  // incident-creation response any more than notification sends should —
  // same reasoning as enqueuePage, different job.
  return incidentQueue.add(
    "embed-and-suggest",
    { type: "embed-and-suggest", ...data },
    { attempts: 2, backoff: { type: "exponential", delay: 3000 } }
  );
}
