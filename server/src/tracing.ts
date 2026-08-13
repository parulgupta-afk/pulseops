// Must be imported before any other module in an entrypoint (index.ts,
// worker.ts) so OpenTelemetry can patch Node's module loader before Express/
// pg/http get required — tracing that's set up after the thing it's tracing
// has already loaded won't capture spans for it.
//
// Deliberately using individual instrumentations (HTTP, Express, pg) instead
// of the @opentelemetry/auto-instrumentations-node bundle, which pulls in
// instrumentation for dozens of libraries this project doesn't use — lighter
// install, faster startup, and every instrumentation here is one that
// actually matters for this service.
//
// Exports to the console by default so this runs with zero external
// dependencies (no Jaeger/Tempo collector required to see it work). Point
// OTEL_EXPORTER_OTLP_ENDPOINT at a real collector and swap ConsoleSpanExporter
// for the OTLP exporter to send traces somewhere real.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { Resource } from "@opentelemetry/resources";

const serviceName = process.env.OTEL_SERVICE_NAME || "pulseops-api";

const sdk = new NodeSDK({
  resource: new Resource({ "service.name": serviceName }),
  traceExporter: new ConsoleSpanExporter(),
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new PgInstrumentation()],
});

sdk.start();

process.on("SIGTERM", () => {
  sdk.shutdown().finally(() => process.exit(0));
});
