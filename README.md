# PulseOps — All 7 Phases Complete

A scoped-down on-call incident management platform (PagerDuty/Opsgenie-style),
built in phases to demonstrate real-time systems, a genuine constraint-satisfaction
algorithm, event-driven infrastructure, and applied RAG — not just CRUD.

**Phase 1:** auth + orgs, manual on-call assignment, incident create/ack/resolve via
REST, React dashboard.

**Phase 2:** real-time — every incident state change pushed to every connected
browser instantly via Socket.io + Redis pub/sub, no polling.

**Phase 3:** the constraint-based on-call rotation generator — build a roster with
per-person blackout dates, generate a fair rotation, get a violation report if the
constraints couldn't be fully satisfied.

**Phase 4:** event-driven reliability — incident notifications run through a BullMQ
queue in a separate worker process, with retry-with-backoff and automatic escalation
through a policy chain if a page goes unacknowledged.

**Phase 5:** RAG-based incident triage — new incidents get embedded via Gemini
(or a mock, if no API key is set) and matched against similar past resolved
incidents via pgvector, with an AI summary grounded explicitly in what was retrieved.

**Phase 6 (this update):** observability. Structured logging via pino, OpenTelemetry
tracing (HTTP/Express/pg instrumentation), and a `/metrics` endpoint exposing
Prometheus-format metrics — including one tied directly to the spec's non-functional
requirement (`incident_ingestion_duration_seconds`, p95 target < 200ms). A k6 load
test script targets the incident ingestion endpoint specifically.

**Phase 7 (this update):** all four stretch features, in the spec's priority order:
1. **AI-generated postmortems** — drafted automatically when an incident is resolved,
   grounded in its full event timeline, reusing the same Gemini/mock generation
   provider from Phase 5.
2. **On-call fatigue analytics** — flags responders paged excessively or
   disproportionately on weekends/off-hours.
3. **Public status page** — an unauthenticated, no-login page at `/status/:orgId`
   showing current + recently-resolved incidents, the kind of page a customer would
   actually see.
4. **SLA / error-budget tracking** — uptime percentage and error-budget burn-rate
   over a configurable window, computed from actual incident open/close times.

Verified in this scaffold: `server` and `client` typecheck clean, the client builds
with Vite, both the API server and worker boot cleanly with the full Phase 1–7 stack
wired together (including with Redis unavailable). `/metrics` and `/health` were
fetched from a genuinely running server instance and confirmed to return real,
correctly-shaped responses. The SLA computation (`server/src/analytics/sla.ts`) was
tested directly with 4 assertions, including the trickiest edge case — correctly
merging overlapping incident windows so simultaneous incidents don't double-count as
downtime. The k6 script and the real Gemini API calls could not be executed from this
sandbox environment (no k6 binary, no network access to Gemini's API, no live
Postgres) — see the relevant sections below for what that means for you before
relying on either.

## Project layout

```
pulseops/
├── packages/shared-types/   # Types shared by server and client — the wire format
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── ai/                # embedding + generation providers (Gemini + mock)
│       ├── analytics/         # pure SLA/error-budget computation (unit-tested)
│       ├── db/                # pg pool, SQL migrations, migration runner, vector helper
│       ├── middleware/        # requireAuth, requireRole, error handling, metrics
│       ├── notifications/     # NotificationProvider interface + mock implementation
│       ├── observability/     # prom-client metrics registry
│       ├── queue/             # BullMQ queue definition + the worker process
│       ├── realtime/          # Socket.io server + Redis pub/sub fan-out
│       ├── routes/            # auth, orgs, users, schedules, incidents, escalation
│       │                        policies, analytics, public status
│       ├── scheduling/        # the constraint-based rotation generator
│       ├── tracing.ts         # OpenTelemetry bootstrap — imported first in every entrypoint
│       └── utils/             # password hashing, JWT signing, snake_case→camelCase, logger
├── client/                  # React + TypeScript + Vite
│   └── src/
│       ├── api/                # axios client with JWT interceptor, socket.io connection
│       ├── context/            # AuthContext
│       ├── pages/               # Login, Register, Dashboard, Schedule, EscalationPolicies,
│       │                          IncidentDetail, Analytics, PublicStatus
│       └── components/          # Layout, IncidentCard
├── k6/                       # load test script targeting incident ingestion
└── docker-compose.yml         # Postgres (with pgvector) + Redis for local dev
```

## Setup

**1. Start Postgres + Redis**

```bash
docker compose up -d
```

(Redis isn't used yet — Phase 4 needs it for BullMQ — but it's here now so the
compose file doesn't change later.)

**2. Install dependencies** (npm workspaces — one install for the whole repo)

```bash
npm install
```

**3. Configure environment variables**

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Defaults match the docker-compose Postgres/Redis, so you shouldn't need to edit
anything to run locally. `JWT_SECRET` should be changed before this ever goes
anywhere real.

**4. Run migrations**

```bash
npm run migrate
```

This runs all five migrations in order: `001_init.sql` (core schema), `002` (Phase
3's roster table), `003` (Phase 4's escalation fields), `004` (Phase 5's
`triage_suggestions` table + vector index), and `005` (Phase 7's `target_user_id`
on incident events + the unique index that makes postmortems regenerable) against
`DATABASE_URL`.

**5. Run the app**

```bash
npm run dev:server   # http://localhost:4000
npm run dev:worker   # processes the incident-paging queue — run this in its own terminal
npm run dev:client   # http://localhost:5173
```

The worker is a separate process from the API server on purpose — that's the whole
point of Phase 4. If you skip starting it, incidents will still get created and
auto-assigned (Phase 1 behavior), but nothing tied to an escalation policy will ever
actually get paged or escalated, since that work only happens inside the worker.

**6. Try it**

- Go to `http://localhost:5173/register`, create an org — this makes you its first admin.
- Add a teammate: `POST /api/users` (admin-only) with `role: "responder"`.
- Create a schedule and add yourself/a teammate as a manual shift on the Schedule page.
- Fire a test incident:

```bash
curl -X POST http://localhost:4000/api/incidents \
  -H "Authorization: Bearer <your token from localStorage>" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "test-001",
    "title": "Checkout API returning 500s",
    "description": "Spike in 5xx on /checkout starting 14:02 UTC",
    "scheduleId": "<schedule id>"
  }'
```

It'll auto-assign to whoever's on-call for that schedule (if the current time
falls inside a shift) and show up on the dashboard within 5 seconds (poll interval).
Acknowledge and resolve it from the UI.

Re-POSTing the same `idempotencyKey` returns the existing incident instead of
creating a duplicate — this is the idempotency behavior the spec calls out, though
right now it's enforced synchronously via a DB unique constraint rather than the
24h-window queue-based dedupe Phase 4 adds.

**7. Try the rotation generator**

- On the Schedule page, add a couple of teammates to the roster under **Roster & time
  off** — optionally give one of them a blackout date a few days out
  (format: `2026-08-20`)
- Under **Generate rotation**, pick a date range (e.g. today through two weeks out)
  and click **Generate rotation**
- You'll get a fairness report (days assigned per person) and, if the constraints
  couldn't be fully satisfied, a list of exactly which days and why
- The shift table below updates immediately — generated shifts are tagged
  `algorithm` vs. `manual`

**8. Try the escalation flow**

- On the **Escalation policies** page, create a policy with 2+ steps — e.g. step 1
  pages you via email with a 1-minute timeout, step 2 pages a teammate. (Use a short
  timeout like 1 minute so you don't have to wait long to see it escalate.)
- Grab the policy's `id` — it's printed under each policy card
- Fire a test incident with `escalationPolicyId` instead of (or alongside) `scheduleId`:

```bash
curl -X POST http://localhost:4000/api/incidents \
  -H "Authorization: Bearer <your token>" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "test-escalation-001",
    "title": "Database connection pool exhausted",
    "description": "Postgres connections maxed out on primary",
    "escalationPolicyId": "<policy id>"
  }'
```

- Watch the terminal running `npm run dev:worker` — you'll see `[mock-notify]` log
  lines as it pages step 1
- Don't acknowledge it. After the step's timeout passes, the worker automatically
  pages step 2 and logs an `escalated` event — check the incident's event timeline
  via `GET /api/incidents/:id/events` to see the full `fired → paged → escalated`
  sequence with timestamps
- To see retry-with-backoff in action instead: set `NOTIFICATION_SIMULATE_FAILURES=true`
  in `server/.env`, restart the worker, and fire another test incident — watch it fail
  and retry a couple of times in the worker's logs before succeeding (or exhausting
  its 3 attempts, in which case BullMQ marks the job failed and the escalation timer
  for that step never got scheduled — a real gap, see "Known gaps" below)

**9. Try the RAG triage flow**

- Fire and resolve two or three incidents about the *same underlying problem*,
  described in different words each time, and add a resolution note to each via the
  incident detail page (or `POST /api/incidents/:id/notes`) before resolving —
  something like "Restarted the connection pool and raised max_connections". This is
  what gives the RAG grounding something real to cite.
- Fire a new incident describing that same problem again
- Open its detail page (click the incident title from the dashboard) — the **AI
  triage suggestion** panel will show "Generating..." briefly, then populate with a
  summary and the past incidents it drew from, each shown with a similarity score and
  linking to that incident's own detail page
- Without a `GEMINI_API_KEY` set, the summary will be clearly labeled
  `[Mock AI summary]` — that's expected, not a bug; add a real key to
  `server/.env` and restart the worker to see actual Gemini output instead

**10. Check observability**

- Open `http://localhost:4000/metrics` directly in a browser — you'll see
  Prometheus-format text output: default Node process metrics (CPU, memory, event
  loop lag) plus the custom ones defined in `server/src/observability/metrics.ts`
  (`http_request_duration_seconds`, `incidents_created_total`,
  `incident_ingestion_duration_seconds`). Fire a few test incidents first so
  there's actually data in the histograms.
- Watch the terminal running `npm run dev:server` — every request logs a structured
  line via pino (pretty-printed in dev; set `NODE_ENV=production` to see raw JSON,
  which is what you'd actually ship to a log aggregator)
- OpenTelemetry spans print to the console too (via `ConsoleSpanExporter` in
  `server/src/tracing.ts`) — look for `HTTP GET`, `express.handle`, and `pg.query`
  spans as you hit different endpoints. To send these somewhere real instead of the
  console, swap in the OTLP exporter and point `OTEL_EXPORTER_OTLP_ENDPOINT` at a
  Jaeger/Tempo/Grafana Cloud collector.
- To actually run the k6 load test, [install k6](https://k6.io/docs/get-started/installation/)
  separately (it's not an npm package), then:
  ```bash
  PULSEOPS_EMAIL=you@example.com PULSEOPS_PASSWORD=yourpassword \
    k6 run k6/incident-ingestion.js
  ```
  This ramps to 500 concurrent virtual users hitting `POST /api/incidents` and
  fails the run if p95 latency exceeds 200ms — the exact number from the spec's
  non-functional requirement. **I could not run this myself** — no k6 binary in
  the environment this was built in — so the first real run is yours; if it fails
  the threshold, `incident_ingestion_duration_seconds` in `/metrics` (or the
  OTel `pg.query` spans) is the place to look for where the time is actually going.

**11. Try the Phase 7 stretch features**

- **Postmortems**: resolve any incident with a couple of notes already recorded —
  its detail page will show a **Postmortem** section that populates automatically
  a few seconds after resolving (or shows `[Mock AI postmortem]` without a Gemini key)
- **Fatigue analytics**: after firing a handful of incidents through an escalation
  policy (so `target_user_id` gets recorded on `paged`/`escalated` events), visit
  **Analytics** in the nav — the fatigue table shows who's been paged, and flags
  anyone paged 5+ times where over half those pages landed on a weekend or outside
  8am–8pm UTC
- **SLA tracking**: same Analytics page, top section — adjust the window/target
  inputs and watch the uptime %, downtime, and error-budget bar update
- **Public status page**: click "View public status page" at the bottom of the
  sidebar (opens `/status/<your org id>` in a new tab) — no login required, this is
  what an external stakeholder would actually see. Fire an incident and refresh to
  see it appear as a degradation.



The rotation generator (`server/src/scheduling/generateRotation.ts`) was verified
against real test cases before being wired into the API:
- A 10-day, 3-person rotation with individual blackout dates — confirmed zero
  violations, blackout dates never assigned, and fairness stayed balanced (each
  person got 3–4 days)
- Everyone blacked out on the same day — confirmed it reports a `no_coverage`
  violation rather than silently assigning someone anyway
- A single-person roster with a tight `maxConsecutiveDays` cap over a longer window
  — confirmed it still covers every day (better to bend a soft rule than leave a
  day uncovered) and reports each day it had to relax the cap

These aren't wired up as an automated test suite yet (no Jest/Vitest in the repo) —
worth adding if you want CI to catch regressions here, since this is the piece most
likely to have an edge case (e.g. very large gaps between roster members' blackout
dates, or a roster of one against a long window) that's worth locking down.

## What's not production-ready (by deliberate scope, not oversight)

All 7 planned phases are built. What's still missing is the gap between "portfolio
project that demonstrates the concepts" and "thing you'd actually run in production" —
covered honestly in "Known gaps" below rather than glossed over.

## Known gaps

- No refresh-token flow — the JWT is a flat 7-day token. Fine for a demo, worth
  revisiting if this goes further.
- `errorHandler` returns raw `err.message` to the client, which is fine for a
  portfolio project but not something you'd ship with real user-facing error text.
- The rotation generator doesn't check for overlap with manually-added shifts —
  if you add a manual shift and then generate a rotation covering the same dates,
  both will exist and `current-oncall` just returns whichever one sorts first.
  Fine for a demo/single-schedule use, worth a real conflict check if this goes further.
- **Real gap, not just a "later" item:** if a `page` job exhausts all 3 of BullMQ's
  retry attempts (i.e. the notification send genuinely never succeeds), the
  escalation-check job for that step never gets scheduled — because it's only
  enqueued *after* a successful send, inside `pageStep()`. So a permanently-failing
  notification currently silently stalls the escalation chain instead of moving on
  to the next step. The honest fix is to schedule the escalation-check independently
  of send success, so a dead notification channel doesn't block the whole chain.
- Notifications are entirely mocked (see the Phase 4 section above) — no real
  Twilio/SendGrid wiring exists yet, by deliberate choice.
- The real Gemini providers (`GeminiEmbeddingProvider`, `GeminiGenerationProvider`)
  were written against the documented API request/response shapes but have not been
  exercised against the live API from this environment — verify them with a real key
  before relying on them, and double-check the default model names
  (`text-embedding-004`, `gemini-2.0-flash`) are still current.
- The incident embedding is generated once, from title + description at creation
  time, and never re-embedded even after resolution notes are added. A more complete
  RAG implementation would re-embed (or embed separately) the resolution notes too,
  since "what actually fixed it" is arguably more useful to match on than the
  original symptom description.
- Similarity search only looks at `status = 'resolved'` incidents within the same
  org — reasonable for real usage (an org's own history), but means a fresh org
  with no resolved incidents yet will always get an empty "similar incidents" list,
  which is expected, not broken.
- `/metrics` is unauthenticated by design (standard Prometheus convention), which
  means in a real deployment it needs network-level protection (private subnet,
  firewall rule), not app-level auth — worth calling out explicitly if this comes up
  in an interview, since leaving a metrics endpoint open on the public internet is a
  real (if minor) information-disclosure mistake people make.
- OpenTelemetry exports to the console (`ConsoleSpanExporter`) rather than a real
  collector — functionally complete for demonstrating the instrumentation is wired
  correctly, but you'd swap in the OTLP exporter before this traces anywhere useful
  in production.
- The k6 load test script was written carefully against the documented k6 API but
  **has not been executed** — no k6 binary in the environment this was built in.
  Run it yourself before quoting any throughput/latency numbers from it in an
  interview or on a resume; don't claim a number you haven't actually seen k6 produce.
- Fatigue analytics' "off-hours" definition (before 8am / after 8pm UTC) isn't
  timezone-aware — it treats every responder as if they're in UTC, which is wrong
  for a distributed team. A real implementation would need a timezone field on
  `users` and compute off-hours relative to each person's own local time.
- SLA/error-budget tracking treats the whole org as a single service — any incident
  counts as full downtime for the entire measurement window, with no concept of
  partial degradation or multiple independently-tracked services. Reasonable
  simplification given the data model has no "Service" entity; a fuller
  implementation would need one.
- The public status page has no rate limiting — since it's intentionally
  unauthenticated, that's a real DoS surface in a production deployment that this
  project doesn't address.
