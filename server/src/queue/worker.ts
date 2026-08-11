import dotenv from "dotenv";
dotenv.config();

import { Worker, type Job } from "bullmq";
import { bullConnection } from "./connection";
import { INCIDENT_QUEUE_NAME, enqueueEscalationCheck, type IncidentJobData } from "./incidentQueue";
import { pool } from "../db/pool";
import { notificationProvider } from "../notifications";
import { publishIncidentEvent } from "../realtime/redisPubSub";
import { toCamelCase } from "../utils/caseConvert";

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

async function recordEventAndBroadcast(incidentId: string, orgId: string, type: string, message: string) {
  await pool.query(
    `INSERT INTO incident_events (incident_id, type, actor_id, message) VALUES ($1, $2, NULL, $3)`,
    [incidentId, type, message]
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
    `Paged ${user.name} via ${target.channel} (escalation step ${step + 1}/${steps.length}).`
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

export const incidentWorker = new Worker<IncidentJobData>(
  INCIDENT_QUEUE_NAME,
  async (job: Job<IncidentJobData>) => {
    if (job.data.type === "page") {
      await pageStep(job.data.incidentId, job.data.orgId, job.data.step);
    } else if (job.data.type === "escalation-check") {
      await handleEscalationCheck(job.data.incidentId, job.data.orgId, job.data.step);
    }
  },
  { connection: bullConnection }
);

incidentWorker.on("completed", (job) => {
  console.log(`[worker] completed ${job.name} (${job.id})`);
});

incidentWorker.on("failed", (job, err) => {
  console.log(`[worker] ${job?.name} (${job?.id}) failed on attempt ${job?.attemptsMade}: ${err.message}`);
});

console.log("PulseOps incident worker started, listening on queue:", INCIDENT_QUEUE_NAME);
