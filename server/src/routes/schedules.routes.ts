import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";

export const schedulesRouter = Router();

schedulesRouter.use(requireAuth);

schedulesRouter.get(
  "/",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT id, org_id, name, rotation_length_days, max_consecutive_days, blackout_dates, created_at
       FROM schedules WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.user!.orgId]
    );
    res.json(result.rows);
  })
);

const createScheduleSchema = z.object({
  name: z.string().min(1),
  rotationLengthDays: z.number().int().positive().default(7),
  maxConsecutiveDays: z.number().int().positive().default(7),
});

schedulesRouter.post(
  "/",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = createScheduleSchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO schedules (org_id, name, rotation_length_days, max_consecutive_days)
       VALUES ($1, $2, $3, $4)
       RETURNING id, org_id, name, rotation_length_days, max_consecutive_days, blackout_dates, created_at`,
      [req.user!.orgId, body.name, body.rotationLengthDays, body.maxConsecutiveDays]
    );
    res.status(201).json(result.rows[0]);
  })
);

// Returns whoever is currently on-call for a schedule, i.e. the shift covering "now".
// This is the lookup the incident-assignment logic below depends on.
schedulesRouter.get(
  "/:id/current-oncall",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.starts_at, s.ends_at, u.name, u.email, u.phone
       FROM schedule_shifts s
       JOIN users u ON u.id = s.user_id
       JOIN schedules sch ON sch.id = s.schedule_id
       WHERE s.schedule_id = $1 AND sch.org_id = $2
         AND now() BETWEEN s.starts_at AND s.ends_at
       ORDER BY s.starts_at DESC
       LIMIT 1`,
      [req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No one is currently on-call for this schedule" });
    }
    res.json(result.rows[0]);
  })
);

// All shifts for a schedule, for rendering the calendar view.
schedulesRouter.get(
  "/:id/shifts",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT s.id, s.schedule_id, s.user_id, s.starts_at, s.ends_at, s.generated_by_algorithm, u.name
       FROM schedule_shifts s
       JOIN users u ON u.id = s.user_id
       JOIN schedules sch ON sch.id = s.schedule_id
       WHERE s.schedule_id = $1 AND sch.org_id = $2
       ORDER BY s.starts_at`,
      [req.params.id, req.user!.orgId]
    );
    res.json(result.rows);
  })
);

const createShiftSchema = z.object({
  userId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

// Phase 1: shifts are assigned manually by an admin, one at a time.
// Phase 3 replaces this with the constraint-based scheduling algorithm, which
// will bulk-generate ScheduleShift rows instead of taking them one by one here.
schedulesRouter.post(
  "/:id/shifts",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = createShiftSchema.parse(req.body);

    const scheduleCheck = await pool.query(
      `SELECT id FROM schedules WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user!.orgId]
    );
    if (scheduleCheck.rows.length === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const result = await pool.query(
      `INSERT INTO schedule_shifts (schedule_id, user_id, starts_at, ends_at, generated_by_algorithm)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, schedule_id, user_id, starts_at, ends_at, generated_by_algorithm`,
      [req.params.id, body.userId, body.startsAt, body.endsAt]
    );
    res.status(201).json(result.rows[0]);
  })
);
