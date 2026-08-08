import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { hashPassword, verifyPassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { wrapAsync } from "../middleware/errorHandler";
import type { AuthResponse } from "@pulseops/shared-types";

export const authRouter = Router();

const registerSchema = z.object({
  orgName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

// Registering creates a brand-new org with the caller as its first admin.
// Joining an existing org is deliberately out of scope for Phase 1 (would need
// an invite flow) — everyone who registers here is bootstrapping a new team.
authRouter.post(
  "/register",
  wrapAsync(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const orgResult = await client.query(
        `INSERT INTO orgs (name) VALUES ($1) RETURNING id, name, plan, created_at`,
        [body.orgName]
      );
      const org = orgResult.rows[0];

      const userResult = await client.query(
        `INSERT INTO users (org_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, org_id, email, role`,
        [org.id, body.name, body.email, passwordHash]
      );
      const user = userResult.rows[0];

      await client.query("COMMIT");

      const authUser = {
        id: user.id,
        orgId: user.org_id,
        email: user.email,
        role: user.role,
      };
      const token = signToken(authUser);
      const response: AuthResponse = { token, user: authUser };
      res.status(201).json(response);
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof Error && "code" in err && (err as any).code === "23505") {
        return res.status(409).json({ error: "Email already registered" });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  wrapAsync(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const result = await pool.query(
      `SELECT id, org_id, email, role, password_hash FROM users WHERE email = $1`,
      [body.email]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await verifyPassword(body.password, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const authUser = { id: row.id, orgId: row.org_id, email: row.email, role: row.role };
    const token = signToken(authUser);
    const response: AuthResponse = { token, user: authUser };
    res.json(response);
  })
);
