import { Router } from "express";
import { pool } from "../db/pool";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";

export const publicRouter = Router();

// Deliberately NOT behind requireAuth — this is what a customer/stakeholder
// visits without logging in, same as status.github.com or similar. No
// internal detail beyond title/status/timestamps is exposed: no assigned
// responder, no escalation policy, nothing that reveals internal process.
publicRouter.get(
  "/status/:orgId",
  wrapAsync(async (req, res) => {
    const orgResult = await pool.query(`SELECT id, name FROM orgs WHERE id = $1`, [req.params.orgId]);
    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const activeResult = await pool.query(
      `SELECT id, title, description, status, fired_at
       FROM incidents
       WHERE org_id = $1 AND status IN ('firing', 'acknowledged')
       ORDER BY fired_at DESC`,
      [req.params.orgId]
    );

    const recentlyResolvedResult = await pool.query(
      `SELECT id, title, status, fired_at, resolved_at
       FROM incidents
       WHERE org_id = $1 AND status = 'resolved' AND resolved_at > now() - interval '24 hours'
       ORDER BY resolved_at DESC
       LIMIT 10`,
      [req.params.orgId]
    );

    res.json(
      toCamelCase({
        org_name: orgResult.rows[0].name,
        operational: activeResult.rows.length === 0,
        active_incidents: activeResult.rows,
        recently_resolved: recentlyResolvedResult.rows,
      })
    );
  })
);
