import type { AuthUser } from "@pulseops/shared-types";

// Augments Express's Request so every route handler downstream of the auth
// middleware gets a typed req.user without casting.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
