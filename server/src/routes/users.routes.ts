import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";
import { hashPassword } from "../utils/password";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// List teammates within the caller's org — used to populate "assign to" dropdowns
// for manual on-call assignment and escalation policy steps.
usersRouter.get(
  "/",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT id, org_id, name, email, phone, role, created_at
       FROM users WHERE org_id = $1 ORDER BY name`,
      [req.user!.orgId]
    );
    res.json(toCamelCase(result.rows));
  })
);

const inviteSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
  role: z.enum(["admin", "responder", "viewer"]),
});

// Admin-only: add a teammate directly to the org (stand-in for a real invite
// flow with email verification, which is out of scope for Phase 1).
usersRouter.post(
  "/",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = inviteSchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    try {
      const result = await pool.query(
        `INSERT INTO users (org_id, name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, org_id, name, email, phone, role, created_at`,
        [req.user!.orgId, body.name, body.email, body.phone ?? null, passwordHash, body.role]
      );
      res.status(201).json(toCamelCase(result.rows[0]));
    } catch (err: any) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Email already registered" });
      }
      throw err;
    }
  })
);
