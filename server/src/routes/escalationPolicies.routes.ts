import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { wrapAsync } from "../middleware/errorHandler";
import { toCamelCase } from "../utils/caseConvert";

export const escalationPoliciesRouter = Router();

escalationPoliciesRouter.use(requireAuth);

escalationPoliciesRouter.get(
  "/",
  wrapAsync(async (req, res) => {
    const result = await pool.query(
      `SELECT id, org_id, name, steps, created_at
       FROM escalation_policies WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.user!.orgId]
    );
    res.json(toCamelCase(result.rows));
  })
);

const stepSchema = z.object({
  userId: z.string().uuid(),
  timeoutMinutes: z.number().int().positive(),
  channel: z.enum(["sms", "email"]),
});

const createPolicySchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
});

// Steps are ordered: step 0 is who gets paged first, timeoutMinutes is how
// long they have to acknowledge before the worker moves to step 1, and so on.
escalationPoliciesRouter.post(
  "/",
  requireRole("admin"),
  wrapAsync(async (req, res) => {
    const body = createPolicySchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO escalation_policies (org_id, name, steps)
       VALUES ($1, $2, $3)
       RETURNING id, org_id, name, steps, created_at`,
      [req.user!.orgId, body.name, JSON.stringify(body.steps)]
    );
    res.status(201).json(toCamelCase(result.rows[0]));
  })
);
