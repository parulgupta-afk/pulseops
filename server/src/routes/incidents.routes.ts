import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";

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
    res.json(result.rows);
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
    res.json(result.rows[0]);
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
    res.json(result.rows);
  })
);

const createIncidentSchema = z.object({
  idempotencyKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  scheduleId: z.string().uuid().optional(), // if given, auto-assign to current on-call
});

// This is the ingestion endpoint. Phase 1: synchronous insert + optional
// auto-assignment from a schedule's current on-call shift, no paging yet.
// Phase 4 moves the "resolve on-call + notify" work onto a BullMQ worker and
// adds the 24h idempotency-window dedupe this route only approximates today
// via the DB unique constraint on (org_id, idempotency_key).
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
      return res.status(200).json(existing.rows[0]);
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const incidentResult = await client.query(
        `INSERT INTO incidents (org_id, idempotency_key, title, description, assigned_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, org_id, idempotency_key, title, description, status,
                   assigned_user_id, fired_at, acked_at, resolved_at`,
        [req.user!.orgId, body.idempotencyKey, body.title, body.description, assignedUserId]
      );
      const incident = incidentResult.rows[0];

      await client.query(
        `INSERT INTO incident_events (incident_id, type, actor_id, message)
         VALUES ($1, 'fired', NULL, $2)`,
        [incident.id, assignedUserId ? "Incident fired and auto-assigned" : "Incident fired"]
      );
      if (assignedUserId) {
        await client.query(
          `INSERT INTO incident_events (incident_id, type, actor_id, message)
           VALUES ($1, 'paged', NULL, 'Assigned to current on-call responder')`,
          [incident.id]
        );
      }

      await client.query("COMMIT");
      res.status(201).json(incident);
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
    res.json(result.rows[0]);
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
    res.json(result.rows[0]);
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
    res.json(result.rows[0]);
  })
);
