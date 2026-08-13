import type { Request, Response, NextFunction } from "express";
import { httpRequestDuration } from "../observability/metrics";

// Records every request's duration against the route *pattern* (e.g.
// "/api/incidents/:id"), not the literal URL — grouping by pattern is what
// makes the histogram useful (thousands of distinct incident IDs would
// otherwise fragment into thousands of near-useless label combinations).
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    httpRequestDuration.observe(
      { method: req.method, route, status_code: String(res.statusCode) },
      durationSeconds
    );
  });

  next();
}
