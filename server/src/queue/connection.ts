import type { ConnectionOptions } from "bullmq";

// BullMQ needs its own Redis connection config (separate from the ioredis
// clients in realtime/redisPubSub.ts) — it requires maxRetriesPerRequest: null
// so it can manage retries itself via blocking commands, rather than ioredis's
// own retry logic interfering with BullMQ's internal polling.
const url = new URL(process.env.REDIS_URL || "redis://localhost:6379");

export const bullConnection: ConnectionOptions = {
  host: url.hostname,
  port: Number(url.port || 6379),
  maxRetriesPerRequest: null,
};
