import type { Request, Response, NextFunction } from "express";

// Catch-all so route handlers can just `next(err)` (or let an async rejection
// propagate via the wrapAsync helper) instead of hand-rolling try/catch everywhere.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error(err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}

// Wraps an async route handler so rejected promises reach errorHandler
// instead of crashing the process or hanging the request.
export function wrapAsync(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
