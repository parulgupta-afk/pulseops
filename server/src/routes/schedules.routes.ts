import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";
import { generateRotation } from "../scheduling/generateRotation";
import type { ScheduleMember } from "@pulseops/shared-types";

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
    res.json(toCamelCase(result.rows));
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
    res.status(201).json(toCamelCase(result.rows[0]));
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
    res.json(toCamelCase(result.rows[0]));
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
    res.json(toCamelCase(result.rows));
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
    res.status(201).json(toCamelCase(result.rows[0]));
  })
);

// ---- Phase 3: roster management (per-person blackout dates) ----

schedulesRouter.get(
  "/:id/members",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT m.id, m.schedule_id, m.user_id, m.blackout_dates, u.name
       FROM schedule_members m
       JOIN users u ON u.id = m.user_id
       JOIN schedules sch ON sch.id = m.schedule_id
       WHERE m.schedule_id = $1 AND sch.org_id = $2
       ORDER BY u.name`,
      [req.params.id, req.user!.orgId]
    );
    res.json(toCamelCase(result.rows));
  })
);

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  blackoutDates: z.array(z.string()).default([]), // ISO date strings, e.g. "2026-08-20"
});

schedulesRouter.post(
  "/:id/members",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = addMemberSchema.parse(req.body);

    const scheduleCheck = await pool.query(
      `SELECT id FROM schedules WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user!.orgId]
    );
    if (scheduleCheck.rows.length === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    try {
      const result = await pool.query(
        `INSERT INTO schedule_members (schedule_id, user_id, blackout_dates)
         VALUES ($1, $2, $3)
         RETURNING id, schedule_id, user_id, blackout_dates`,
        [req.params.id, body.userId, body.blackoutDates]
      );
      const withName = await pool.query(`SELECT name FROM users WHERE id = $1`, [body.userId]);
      res.status(201).json(toCamelCase({ ...result.rows[0], name: withName.rows[0]?.name }));
    } catch (err: any) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "This person is already on the roster for this schedule" });
      }
      throw err;
    }
  })
);

const updateMemberSchema = z.object({
  blackoutDates: z.array(z.string()),
});

// Replaces a member's full blackout-date list (simplest correct semantics —
// the client sends the whole updated list rather than incremental add/remove).
schedulesRouter.patch(
  "/:id/members/:memberId",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = updateMemberSchema.parse(req.body);
    const result = await pool.query(
      `UPDATE schedule_members m SET blackout_dates = $1
       FROM schedules sch
       WHERE m.id = $2 AND m.schedule_id = $3 AND m.schedule_id = sch.id AND sch.org_id = $4
       RETURNING m.id, m.schedule_id, m.user_id, m.blackout_dates`,
      [body.blackoutDates, req.params.memberId, req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Roster member not found" });
    }
    res.json(toCamelCase(result.rows[0]));
  })
);

schedulesRouter.delete(
  "/:id/members/:memberId",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `DELETE FROM schedule_members m
       USING schedules sch
       WHERE m.id = $1 AND m.schedule_id = $2 AND m.schedule_id = sch.id AND sch.org_id = $3
       RETURNING m.id`,
      [req.params.memberId, req.params.id, req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Roster member not found" });
    }
    res.status(204).send();
  })
);

// ---- Phase 3: the constraint-based rotation generator ----

const generateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});

schedulesRouter.post(
  "/:id/generate",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = generateSchema.parse(req.body);

    const scheduleResult = await pool.query(
      `SELECT id, max_consecutive_days FROM schedules WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user!.orgId]
    );
    if (scheduleResult.rows.length === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    const maxConsecutiveDays = scheduleResult.rows[0].max_consecutive_days;

    const membersResult = await pool.query(
      `SELECT m.id, m.schedule_id, m.user_id, m.blackout_dates, u.name
       FROM schedule_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.schedule_id = $1`,
      [req.params.id]
    );
    if (membersResult.rows.length === 0) {
      return res.status(400).json({
        error: "This schedule has no roster members yet — add at least one person before generating.",
      });
    }

    const members: ScheduleMember[] = membersResult.rows.map((r) => ({
      id: r.id,
      scheduleId: r.schedule_id,
      userId: r.user_id,
      name: r.name,
      blackoutDates: r.blackout_dates,
    }));

    const { shifts, violations, fairnessReport } = generateRotation(
      members,
      body.startDate,
      body.endDate,
      maxConsecutiveDays
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Replace only algorithm-generated shifts in this window — manual
      // shifts (Phase 1 leftovers, or deliberate admin overrides) outside
      // this run are left untouched.
      await client.query(
        `DELETE FROM schedule_shifts
         WHERE schedule_id = $1 AND generated_by_algorithm = true
           AND starts_at >= $2 AND starts_at < $3`,
        [req.params.id, body.startDate, body.endDate]
      );

      const inserted = [];
      for (const shift of shifts) {
        const result = await client.query(
          `INSERT INTO schedule_shifts (schedule_id, user_id, starts_at, ends_at, generated_by_algorithm)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, schedule_id, user_id, starts_at, ends_at, generated_by_algorithm`,
          [req.params.id, shift.userId, shift.startsAt, shift.endsAt]
        );
        inserted.push(result.rows[0]);
      }

      await client.query("COMMIT");
      res.json(toCamelCase({ shifts: inserted, violations, fairnessReport }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);
