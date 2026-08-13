import client from "prom-client";

// A dedicated Registry (rather than the global default) so this module is
// the single source of truth for what gets exposed at /metrics — no risk of
// some other import silently registering metrics we didn't intend to publish.
export const registry = new client.Registry();

// CPU, memory, event loop lag, GC pauses — standard Node process health,
// essentially free to collect and the first thing any real dashboard wants.
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds, labeled by method/route/status",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const incidentsCreatedTotal = new client.Counter({
  name: "incidents_created_total",
  help: "Total number of incidents created (excluding idempotent re-fires)",
  labelNames: ["org_id"],
  registers: [registry],
});

// This is the metric the spec's non-functional requirement is actually
// about ("500 concurrent incident triggers with p95 latency under 200ms") —
// scoped to just the ingestion handler, not the whole HTTP stack, so it's
// not diluted by unrelated routes when reading the k6 results against it.
export const incidentIngestionDuration = new client.Histogram({
  name: "incident_ingestion_duration_seconds",
  help: "Duration of the POST /api/incidents handler specifically",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
