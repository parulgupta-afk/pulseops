import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";
import { publishIncidentEvent } from "../realtime/redisPubSub";
import { enqueuePage } from "../queue/incidentQueue";
import { enqueueEmbedAndSuggest } from "../queue/incidentQueue";

export const incidentsRouter = Router();

incidentsRouter.use(requireAuth);

// List incidents for the org, most recent first. Optional ?status= filter
// is what the dashboard uses to show only "firing" incidents by default.
incidentsRouter.get(
  "/",
  wrapAsync(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await pool.query(
      `SELECT id, org_id, idempotency_key, title, description, status,
              assigned_user_id, fired_at, acked_at, resolved_at
       FROM incidents
       WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY fired_at DESC
       LIMIT 100`,
      [req.user!.orgId, status ?? null]
    );
    res.json(toCamelCase(result.rows));
  })
);

incidentsRouter.get(
  "/:id",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT id, org_id, idempotency_key, title, description, status,
              assigned_user_id, fired_at, acked_at, resolved_at
       FROM incidents WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Incident not found" });
    }
    res.json(toCamelCase(result.rows[0]));
  })
);

const addNoteSchema = z.object({ message: z.string().min(1) });

// Lets a responder record what actually fixed it. This is what gives the
// RAG grounding in Phase 5 something real to cite beyond the original
// description — without notes here, "similar past incidents" only has the
// initial report to go on, not the resolution.
incidentsRouter.post(
  "/:id/notes",
  wrapAsync(async (req, res) => {
    const body = addNoteSchema.parse(req.body);
    const incidentCheck = await pool.query(`SELECT id FROM incidents WHERE id = $1 AND org_id = $2`, [
      req.params.id,
      req.user!.orgId,
    ]);
    if (incidentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Incident not found" });
    }
    await pool.query(
      `INSERT INTO incident_events (incident_id, type, actor_id, message) VALUES ($1, 'note', $2, $3)`,
      [req.params.id, req.user!.id, body.message]
    );
    res.status(201).json({ ok: true });
  })
);

incidentsRouter.get(
  "/:id/events",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT e.id, e.incident_id, e.type, e.actor_id, e.message, e.timestamp
       FROM incident_events e
       JOIN incidents i ON i.id = e.incident_id
       WHERE e.incident_id = $1 AND i.org_id = $2
       ORDER BY e.timestamp ASC`,
      [req.params.id, req.user!.orgId]
    );
    res.json(toCamelCase(result.rows));
  })
);

const createIncidentSchema = z.object({
  idempotencyKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  scheduleId: z.string().uuid().optional(), // if given, auto-assign to current on-call
  escalationPolicyId: z.string().uuid().optional(), // if given, worker pages step 0 and escalates on timeout
});

// This is the ingestion endpoint. The DB insert + optional on-call
// auto-assignment still happens synchronously so the caller (often a
// monitoring webhook) gets a fast 201. Everything that can be slow or fail
// transiently — actually sending a notification, and escalating if it's not
// acknowledged in time — is handed off to a BullMQ job so it doesn't block
// this request. Idempotency is still enforced via the DB unique constraint
// on (org_id, idempotency_key) rather than a separate 24h-window cache table
// — functionally equivalent for this project's scale, simpler to reason about.
incidentsRouter.post(
  "/",
  wrapAsync(async (req, res) => {
    const body = createIncidentSchema.parse(req.body);

    // Idempotency: if this key was already used, return the existing incident
    // instead of erroring or creating a duplicate.
    const existing = await pool.query(
      `SELECT id, org_id, idempotency_key, title, description, status,
              assigned_user_id, fired_at, acked_at, resolved_at
       FROM incidents WHERE org_id = $1 AND idempotency_key = $2`,
      [req.user!.orgId, body.idempotencyKey]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json(toCamelCase(existing.rows[0]));
    }

    let assignedUserId: string | null = null;
    if (body.scheduleId) {
      const oncall = await pool.query(
        `SELECT s.user_id FROM schedule_shifts s
         JOIN schedules sch ON sch.id = s.schedule_id
         WHERE s.schedule_id = $1 AND sch.org_id = $2
           AND now() BETWEEN s.starts_at AND s.ends_at
         ORDER BY s.starts_at DESC LIMIT 1`,
        [body.scheduleId, req.user!.orgId]
      );
      assignedUserId = oncall.rows[0]?.user_id ?? null;
    }

    // If an escalation policy is provided, validate it belongs to this org
    // before committing the insert — a bad ID here shouldn't silently create
    // an incident that can never be paged.
    if (body.escalationPolicyId) {
      const policyCheck = await pool.query(
        `SELECT id FROM escalation_policies WHERE id = $1 AND org_id = $2`,
        [body.escalationPolicyId, req.user!.orgId]
      );
      if (policyCheck.rows.length === 0) {
        return res.status(400).json({ error: "escalationPolicyId does not belong to this org" });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const incidentResult = await client.query(
        `INSERT INTO incidents (org_id, idempotency_key, title, description, assigned_user_id, escalation_policy_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, org_id, idempotency_key, title, description, status,
                   assigned_user_id, fired_at, acked_at, resolved_at, escalation_policy_id`,
        [req.user!.orgId, body.idempotencyKey, body.title, body.description, assignedUserId, body.escalationPolicyId ?? null]
      );
      const incident = incidentResult.rows[0];

      await client.query(
        `INSERT INTO incident_events (incident_id, type, actor_id, message)
         VALUES ($1, 'fired', NULL, $2)`,
        [incident.id, assignedUserId ? "Incident fired and auto-assigned" : "Incident fired"]
      );
      // Without an escalation policy, this is the old Phase 1 behavior — a
      // note that someone's assigned, no actual notification sent. With a
      // policy, the queue job below sends a real (mocked) notification and
      // logs its own 'paged' event once it actually runs.
      if (assignedUserId && !body.escalationPolicyId) {
        await client.query(
          `INSERT INTO incident_events (incident_id, type, actor_id, message)
           VALUES ($1, 'paged', NULL, 'Assigned to current on-call responder')`,
          [incident.id]
        );
      }

      await client.query("COMMIT");

      // Fire-and-forget: don't make the caller (often a monitoring webhook)
      // wait on the broadcast fan-out before getting its 201 back.
      publishIncidentEvent({ orgId: req.user!.orgId, type: "incident:created", incident: toCamelCase(incident) });

      if (body.escalationPolicyId) {
        await enqueuePage({ incidentId: incident.id, orgId: req.user!.orgId, step: 0 });
      }

      // Always embed + look for similar past incidents, independent of
      // whether an escalation policy is set — RAG triage isn't gated on
      // paging config the way notifications are.
      await enqueueEmbedAndSuggest({ incidentId: incident.id, orgId: req.user!.orgId });

      res.status(201).json(toCamelCase(incident));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

incidentsRouter.post(
  "/:id/acknowledge",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `UPDATE incidents SET status = 'acknowledged', acked_at = now()
       WHERE id = $1 AND org_id = $2 AND status = 'firing'
       RETURNING id, org_id, idempotency_key, title, description, status,
                 assigned_user_id, fired_at, acked_at, resolved_at`,
      [req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: "Incident not found or not in firing state" });
    }
    await pool.query(
      `INSERT INTO incident_events (incident_id, type, actor_id, message)
       VALUES ($1, 'acknowledged', $2, NULL)`,
      [req.params.id, req.user!.id]
    );
    publishIncidentEvent({ orgId: req.user!.orgId, type: "incident:updated", incident: toCamelCase(result.rows[0]) });
    res.json(toCamelCase(result.rows[0]));
  })
);

incidentsRouter.post(
  "/:id/resolve",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `UPDATE incidents SET status = 'resolved', resolved_at = now()
       WHERE id = $1 AND org_id = $2 AND status != 'resolved'
       RETURNING id, org_id, idempotency_key, title, description, status,
                 assigned_user_id, fired_at, acked_at, resolved_at`,
      [req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: "Incident not found or already resolved" });
    }
    await pool.query(
      `INSERT INTO incident_events (incident_id, type, actor_id, message)
       VALUES ($1, 'resolved', $2, NULL)`,
      [req.params.id, req.user!.id]
    );
    publishIncidentEvent({ orgId: req.user!.orgId, type: "incident:updated", incident: toCamelCase(result.rows[0]) });
    res.json(toCamelCase(result.rows[0]));
  })
);

const assignSchema = z.object({ userId: z.string().uuid() });

// Manual (re-)assignment, for when there's no schedule/current on-call to auto-assign from.
incidentsRouter.patch(
  "/:id/assign",
  wrapAsync(async (req, res) => {
    const body = assignSchema.parse(req.body);
    const result = await pool.query(
      `UPDATE incidents SET assigned_user_id = $1
       WHERE id = $2 AND org_id = $3
       RETURNING id, org_id, idempotency_key, title, description, status,
                 assigned_user_id, fired_at, acked_at, resolved_at`,
      [body.userId, req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Incident not found" });
    }
    publishIncidentEvent({ orgId: req.user!.orgId, type: "incident:updated", incident: toCamelCase(result.rows[0]) });
    res.json(toCamelCase(result.rows[0]));
  })
);

// Phase 5: RAG triage suggestion for an incident. Returns { status: "pending" }
// until the embed-and-suggest worker job has finished (which can take a
// couple seconds for a real Gemini call, or a bit longer if it hit a retry).
incidentsRouter.get(
  "/:id/triage",
  wrapAsync(async (req, res) => {
    const incidentCheck = await pool.query(`SELECT id FROM incidents WHERE id = $1 AND org_id = $2`, [
      req.params.id,
      req.user!.orgId,
    ]);
    if (incidentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Incident not found" });
    }

    const result = await pool.query(
      `SELECT summary, similar_incidents, created_at FROM triage_suggestions WHERE incident_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.json({ status: "pending" });
    }
    res.json(toCamelCase({ status: "ready", ...result.rows[0] }));
  })
);
