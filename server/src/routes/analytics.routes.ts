import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";
import { computeSlaReport } from "../analytics/sla";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

// On-call fatigue: who's being paged the most, and how much of that is
// happening on weekends or outside typical working hours. "Off-hours" is
// defined here as before 8am or after 8pm UTC — a real implementation would
// need each user's own timezone to mean this properly; flagged as a known
// simplification rather than pretending this is timezone-aware.
analyticsRouter.get(
  "/fatigue",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT
         u.id AS user_id,
         u.name,
         COUNT(*) AS total_pages,
         COUNT(*) FILTER (WHERE EXTRACT(DOW FROM e.timestamp) IN (0, 6)) AS weekend_pages,
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM e.timestamp) < 8 OR EXTRACT(HOUR FROM e.timestamp) >= 20) AS off_hours_pages
       FROM incident_events e
       JOIN incidents i ON i.id = e.incident_id
       JOIN users u ON u.id = e.target_user_id
       WHERE i.org_id = $1 AND e.type IN ('paged', 'escalated') AND e.target_user_id IS NOT NULL
       GROUP BY u.id, u.name
       ORDER BY total_pages DESC`,
      [req.user!.orgId]
    );

    const rows = result.rows.map((r) => {
      const totalPages = Number(r.total_pages);
      const disruptivePages = Number(r.weekend_pages) + Number(r.off_hours_pages);
      // Simple heuristic, not a rigorous fatigue model: flag anyone paged at
      // least 5 times where over half of those pages landed on a weekend or
      // outside working hours.
      const flagged = totalPages >= 5 && disruptivePages / totalPages > 0.5;
      return {
        userId: r.user_id,
        name: r.name,
        totalPages,
        weekendPages: Number(r.weekend_pages),
        offHoursPages: Number(r.off_hours_pages),
        flagged,
      };
    });

    res.json(rows);
  })
);

// SLA / error-budget tracking, computed on the fly from incident open/close
// times rather than a stored uptime log — simpler and always consistent with
// the incident data, at the cost of being slower on a very large history
// (fine at this project's scale).
analyticsRouter.get(
  "/sla",
  wrapAsync(async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : 30;
    const target = req.query.target ? Number(req.query.target) : 99.9;

    if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(target) || target <= 0 || target > 100) {
      return res.status(400).json({ error: "Invalid days or target query parameter" });
    }

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT fired_at, resolved_at FROM incidents
       WHERE org_id = $1 AND fired_at < $2 AND (resolved_at IS NULL OR resolved_at > $3)`,
      [req.user!.orgId, windowEnd, windowStart]
    );

    const incidents = result.rows.map((r) => ({
      firedAt: r.fired_at as Date,
      resolvedAt: r.resolved_at as Date | null,
    }));

    const report = computeSlaReport(incidents, windowStart, windowEnd, target);
    res.json(toCamelCase(report));
  })
);
