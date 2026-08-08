import jwt from "jsonwebtoken";
import type { AuthUser } from "@pulseops/shared-types";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const EXPIRES_IN = "7d";

export function signToken(user: AuthUser): string {
  return jwt.sign(user, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, SECRET) as AuthUser;
}
