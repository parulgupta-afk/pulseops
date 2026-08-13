import "../tracing"; // must be first — see comment in tracing.ts

import dotenv from "dotenv";
dotenv.config();

import { Worker, type Job } from "bullmq";
import { bullConnection } from "./connection";
import { INCIDENT_QUEUE_NAME, enqueueEscalationCheck, type IncidentJobData } from "./incidentQueue";
import { pool } from "../db/pool";
import { toVectorLiteral } from "../db/vector";
import { notificationProvider } from "../notifications";
import { embeddingProvider, generationProvider, type SimilarIncidentContext } from "../ai";
import { publishIncidentEvent } from "../realtime/redisPubSub";
import { toCamelCase } from "../utils/caseConvert";
import { logger } from "../utils/logger";

// Runs as its own process (`npm run dev:worker`), separate from the API
// server. This is the actual "worker picks it up, resolves who's on-call,
// triggers notification, escalates on timeout" piece from the spec — none of
// this runs inline inside the HTTP request/response cycle.

interface EscalationStep {
  userId: string;
  timeoutMinutes: number;
  channel: "sms" | "email";
}

async function getIncident(incidentId: string) {
  const result = await pool.query(
    `SELECT id, org_id, title, description, status, escalation_policy_id, current_escalation_step
     FROM incidents WHERE id = $1`,
    [incidentId]
  );
  return result.rows[0] ?? null;
}

async function getPolicySteps(policyId: string): Promise<EscalationStep[]> {
  const result = await pool.query(`SELECT steps FROM escalation_policies WHERE id = $1`, [policyId]);
  return result.rows[0]?.steps ?? [];
}

async function getUser(userId: string) {
  const result = await pool.query(`SELECT id, name, email, phone FROM users WHERE id = $1`, [userId]);
  return result.rows[0] ?? null;
}

async function recordEventAndBroadcast(
  incidentId: string,
  orgId: string,
  type: string,
  message: string,
  targetUserId: string | null = null
) {
  await pool.query(
    `INSERT INTO incident_events (incident_id, type, actor_id, target_user_id, message) VALUES ($1, $2, NULL, $3, $4)`,
    [incidentId, type, targetUserId, message]
  );
  const incidentResult = await pool.query(
    `SELECT id, org_id, idempotency_key, title, description, status,
            assigned_user_id, fired_at, acked_at, resolved_at
     FROM incidents WHERE id = $1`,
    [incidentId]
  );
  if (incidentResult.rows[0]) {
    publishIncidentEvent({ orgId, type: "incident:updated", incident: toCamelCase(incidentResult.rows[0]) });
  }
}

// Pages one escalation step: sends the notification (subject to BullMQ's
// own attempts/backoff on this job if the provider call fails) and logs it
// on the incident's timeline.
async function pageStep(incidentId: string, orgId: string, step: number) {
  const incident = await getIncident(incidentId);
  if (!incident || !incident.escalation_policy_id) return;
  // Someone already resolved/acked it before this job ran — nothing to page.
  if (incident.status !== "firing") return;

  const steps = await getPolicySteps(incident.escalation_policy_id);
  const target = steps[step];
  if (!target) return;

  const user = await getUser(target.userId);
  if (!user) return;

  const result = await notificationProvider.send({
    channel: target.channel,
    to: { name: user.name, email: user.email, phone: user.phone },
    subject: `[PulseOps] ${incident.title}`,
    message: incident.description || "No description provided.",
  });

  if (!result.success) {
    // Throwing makes BullMQ treat this job attempt as failed, triggering its
    // built-in exponential backoff retry (configured in enqueuePage).
    throw new Error(result.error || "Notification send failed");
  }

  await pool.query(`UPDATE incidents SET current_escalation_step = $1 WHERE id = $2`, [step, incidentId]);
  await recordEventAndBroadcast(
    incidentId,
    orgId,
    step === 0 ? "paged" : "escalated",
    `Paged ${user.name} via ${target.channel} (escalation step ${step + 1}/${steps.length}).`,
    user.id
  );

  enqueueEscalationCheck({ incidentId, orgId, step }, target.timeoutMinutes * 60 * 1000);
}

async function handleEscalationCheck(incidentId: string, orgId: string, step: number) {
  const incident = await getIncident(incidentId);
  if (!incident) return;

  // Either resolved/acked already, or a later job already moved past this
  // step (e.g. someone manually escalated) — this check is stale, ignore it.
  if (incident.status !== "firing" || incident.current_escalation_step !== step) return;

  const steps = await getPolicySteps(incident.escalation_policy_id);
  const nextStep = step + 1;

  if (nextStep < steps.length) {
    await pageStep(incidentId, orgId, nextStep);
  } else {
    await recordEventAndBroadcast(
      incidentId,
      orgId,
      "note",
      `Escalation policy exhausted after ${steps.length} step(s) — no further responders to page.`
    );
  }
}

const SIMILARITY_LIMIT = 3;

// The actual RAG pipeline: embed the new incident, find the most similar
// past *resolved* incidents via pgvector cosine distance, pull their
// resolution notes for grounding, and ask the generation provider for a
// summary — explicitly instructed to use only what was retrieved, not invent
// anything. Runs as a queue job so a slow/flaky Gemini call never blocks the
// incident-creation response.
async function embedAndSuggest(incidentId: string, orgId: string) {
  const incidentResult = await pool.query(
    `SELECT id, title, description FROM incidents WHERE id = $1 AND org_id = $2`,
    [incidentId, orgId]
  );
  const incident = incidentResult.rows[0];
  if (!incident) return;

  // Embed on title+description — deliberately not re-run on resolution, so
  // the embedding reflects "what the incident looked like when it fired,"
  // which is what a *new* incident's description will actually resemble.
  const embedding = await embeddingProvider.embed(`${incident.title}\n${incident.description}`);
  await pool.query(`UPDATE incidents SET embedding_vector = $1::vector WHERE id = $2`, [
    toVectorLiteral(embedding),
    incidentId,
  ]);

  const similarResult = await pool.query(
    `SELECT id, title, description, resolved_at, embedding_vector <=> $1::vector AS distance
     FROM incidents
     WHERE org_id = $2 AND status = 'resolved' AND id != $3 AND embedding_vector IS NOT NULL
     ORDER BY distance ASC
     LIMIT $4`,
    [toVectorLiteral(embedding), orgId, incidentId, SIMILARITY_LIMIT]
  );

  const similarIncidents = [];
  const contexts: SimilarIncidentContext[] = [];

  for (const row of similarResult.rows) {
    const notesResult = await pool.query(
      `SELECT message FROM incident_events
       WHERE incident_id = $1 AND type IN ('note', 'resolved') AND message IS NOT NULL`,
      [row.id]
    );
    const resolutionNotes = notesResult.rows.map((r) => r.message).filter(Boolean);

    contexts.push({ title: row.title, description: row.description, resolutionNotes });
    similarIncidents.push({
      incidentId: row.id,
      title: row.title,
      // Cosine distance is 0 (identical) to 2 (opposite); convert to a
      // 0-1 "similarity" score, which reads more intuitively in the UI.
      similarity: Math.max(0, 1 - row.distance / 2),
      resolvedAt: row.resolved_at,
    });
  }

  const summary = await generationProvider.summarize(
    { title: incident.title, description: incident.description },
    contexts
  );

  await pool.query(
    `INSERT INTO triage_suggestions (incident_id, summary, similar_incidents)
     VALUES ($1, $2, $3)
     ON CONFLICT (incident_id) DO UPDATE SET summary = $2, similar_incidents = $3, created_at = now()`,
    [incidentId, summary, JSON.stringify(similarIncidents)]
  );

  publishIncidentEvent({ orgId, type: "incident:triage-ready", incidentId });
}

// Runs once an incident is resolved: pulls the full event timeline (fired,
// paged, escalated, acknowledged, notes, resolved — everything) and asks the
// generation provider to draft a postmortem grounded in exactly that
// timeline, explicitly instructed not to invent a root cause that isn't
// actually reflected in the recorded events.
async function generatePostmortem(incidentId: string, orgId: string) {
  const incidentResult = await pool.query(
    `SELECT id, title, description, status FROM incidents WHERE id = $1 AND org_id = $2`,
    [incidentId, orgId]
  );
  const incident = incidentResult.rows[0];
  if (!incident || incident.status !== "resolved") return;

  const eventsResult = await pool.query(
    `SELECT type, message, timestamp FROM incident_events WHERE incident_id = $1 ORDER BY timestamp ASC`,
    [incidentId]
  );
  const events = eventsResult.rows.map((r) => ({
    type: r.type,
    message: r.message,
    timestamp: r.timestamp.toISOString ? r.timestamp.toISOString() : String(r.timestamp),
  }));

  const content = await generationProvider.draftPostmortem(
    { title: incident.title, description: incident.description },
    events
  );

  await pool.query(
    `INSERT INTO postmortems (incident_id, content, generated_by_ai)
     VALUES ($1, $2, true)
     ON CONFLICT (incident_id) DO UPDATE SET content = $2, generated_by_ai = true, created_at = now()`,
    [incidentId, content]
  );

  publishIncidentEvent({ orgId, type: "incident:postmortem-ready", incidentId });
}

export const incidentWorker = new Worker<IncidentJobData>(
  INCIDENT_QUEUE_NAME,
  async (job: Job<IncidentJobData>) => {
    if (job.data.type === "page") {
      await pageStep(job.data.incidentId, job.data.orgId, job.data.step);
    } else if (job.data.type === "escalation-check") {
      await handleEscalationCheck(job.data.incidentId, job.data.orgId, job.data.step);
    } else if (job.data.type === "embed-and-suggest") {
      await embedAndSuggest(job.data.incidentId, job.data.orgId);
    } else if (job.data.type === "generate-postmortem") {
      await generatePostmortem(job.data.incidentId, job.data.orgId);
    }
  },
  { connection: bullConnection }
);

incidentWorker.on("completed", (job) => {
  logger.info({ jobName: job.name, jobId: job.id }, "worker job completed");
});

incidentWorker.on("failed", (job, err) => {
  logger.warn(
    { jobName: job?.name, jobId: job?.id, attempt: job?.attemptsMade, error: err.message },
    "worker job failed"
  );
});

logger.info({ queue: INCIDENT_QUEUE_NAME }, "PulseOps incident worker started");
