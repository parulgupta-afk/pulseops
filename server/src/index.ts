import "./tracing"; // must be first — patches modules before they're required below

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import pinoHttp from "pino-http";

import { authRouter } from "./routes/auth.routes";
import { orgsRouter } from "./routes/orgs.routes";
import { usersRouter } from "./routes/users.routes";
import { schedulesRouter } from "./routes/schedules.routes";
import { incidentsRouter } from "./routes/incidents.routes";
import { escalationPoliciesRouter } from "./routes/escalationPolicies.routes";
import { analyticsRouter } from "./routes/analytics.routes";
import { publicRouter } from "./routes/public.routes";
import { errorHandler } from "./middleware/errorHandler";
import { metricsMiddleware } from "./middleware/metrics";
import { initSocketServer } from "./realtime/socketServer";
import { logger } from "./utils/logger";
import { registry } from "./observability/metrics";

dotenv.config();

const app = express();
// Socket.io needs the raw http.Server (not just the Express app) so it can
// hook into the HTTP upgrade handshake for WebSocket connections.
const httpServer = createServer(app);
initSocketServer(httpServer);

app.use(pinoHttp({ logger }));
app.use(metricsMiddleware);

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Deliberately unauthenticated, same as any standard Prometheus scrape
// target — a scraper hits this on an interval with no login flow involved.
// If this were exposed outside a private network in a real deployment, it'd
// need to sit behind network-level restrictions rather than app-level auth.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

app.use("/api/auth", authRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api/users", usersRouter);
app.use("/api/schedules", schedulesRouter);
// This is the incident ingestion path referenced throughout the spec as
// `POST /api/incidents` — real monitoring tools (or curl, for a demo) hit it directly.
app.use("/api/incidents", incidentsRouter);
app.use("/api/escalation-policies", escalationPoliciesRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/public", publicRouter);

// Must be registered last: Express only routes errors here if it's the final middleware.
app.use(errorHandler);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
httpServer.listen(PORT, () => {
  logger.info(`PulseOps API + WebSocket listening on http://localhost:${PORT}`);
});
