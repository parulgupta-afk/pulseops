import pino from "pino";

// Structured (JSON) logs in production so they're parseable by a real log
// aggregator; pretty-printed in dev so they're readable in a terminal.
// pino-http (wired in index.ts) uses this same instance for per-request logs,
// so request logs and application logs share one format and one place to
// change log level/transport.
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});
