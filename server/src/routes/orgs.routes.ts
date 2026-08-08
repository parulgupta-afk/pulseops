import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";

export const orgsRouter = Router();

orgsRouter.use(requireAuth);

// Returns the caller's own org. Multi-tenant, so there's no "list all orgs" endpoint.
orgsRouter.get(
  "/me",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, plan, created_at FROM orgs WHERE id = $1`,
      [req.user!.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Org not found" });
    }
    res.json(result.rows[0]);
  })
);
