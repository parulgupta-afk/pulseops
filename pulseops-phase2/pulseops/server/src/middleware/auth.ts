import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import type { Role } from "@pulseops/shared-types";

// Verifies the JWT and attaches the decoded user (including orgId) to req.user.
// Every route below this in the chain is automatically org-scoped: handlers
// filter their queries by req.user.orgId rather than trusting anything in the URL/body.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = header.slice("Bearer ".length);
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Role gate, use after requireAuth. e.g. requireRole("admin")
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
