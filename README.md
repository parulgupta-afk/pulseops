# PulseOps — Phase 1 + Phase 2 + Phase 3 + Phase 4

**Phase 1:** auth + orgs, manual on-call assignment, incident create/ack/resolve via
REST, React dashboard.

**Phase 2:** the dashboard no longer polls — every incident state change is pushed to
every connected browser instantly via Socket.io + Redis pub/sub.

**Phase 3:** the constraint-based on-call rotation generator — build a roster with
per-person blackout dates, generate a fair rotation, get a violation report if the
constraints couldn't be fully satisfied.

**Phase 4 (this update):** event-driven reliability. Incident creation no longer sends
notifications inline — it enqueues a BullMQ job, so the API responds immediately (fast
201 for whatever monitoring tool is calling the webhook) while the actual paging work
happens asynchronously in a separate worker process. If a page fails (simulated via a
mock notification provider — see below), BullMQ retries it with exponential backoff.
If it's not acknowledged within the escalation policy's timeout, the worker
automatically pages the next person in the chain and logs every step on the
incident's timeline.

**Why a mock notification provider instead of real Twilio/SendGrid:** Twilio's trial
signup has gotten inconsistent about issuing free numbers depending on account/region,
and burning time fighting that isn't worth it for a portfolio project — the thing that
actually matters for the "hard problem" story is the retry/escalation *architecture*,
not whether a real SMS hits a phone. `server/src/notifications/` defines a
`NotificationProvider` interface; `MockNotificationProvider` logs to stdout instead of
calling a real API, and can be configured to fail on purpose
(`NOTIFICATION_SIMULATE_FAILURES=true`) so you can actually watch the retry/backoff
happen instead of just trusting it works. Swapping in a real provider later is a
one-line change in `notifications/index.ts` — nothing about the queue or escalation
logic needs to change.

Verified in this scaffold: `server` and `client` typecheck clean, the client builds
with Vite, both the API server and the worker process boot cleanly (including with
Redis unavailable), and the mock provider's simulated-failure rate was tested directly
(30 calls with `NOTIFICATION_SIMULATE_FAILURES=true` produced a realistic mix of
successes/failures). Not yet run end-to-end through the actual UI with Docker up —
do that first before building on top of it.

## Project layout

```
pulseops/
├── packages/shared-types/   # Types shared by server and client — the wire format
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── db/               # pg pool, SQL migrations, migration runner
│       ├── middleware/       # requireAuth, requireRole, error handling
│       ├── notifications/    # NotificationProvider interface + mock implementation
│       ├── queue/            # BullMQ queue definition + the worker process
│       ├── realtime/         # Socket.io server + Redis pub/sub fan-out
│       ├── routes/           # auth, orgs, users, schedules, incidents, escalation policies
│       ├── scheduling/       # the constraint-based rotation generator
│       └── utils/            # password hashing, JWT signing, snake_case→camelCase
├── client/                  # React + TypeScript + Vite
│   └── src/
│       ├── api/               # axios client with JWT interceptor
│       ├── context/           # AuthContext
│       ├── pages/             # Login, Register, Dashboard, Schedule
│       └── components/        # Layout, IncidentCard
└── docker-compose.yml        # Postgres (with pgvector) + Redis for local dev
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

This runs `001_init.sql` (core schema), `002_schedule_members.sql` (Phase 3's
roster table), and `003_escalation.sql` (Phase 4's `escalation_policy_id` +
`current_escalation_step` columns on `incidents`) against `DATABASE_URL`.

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

## What's deliberately not here yet

- **AI layer** (Phase 5): `embedding_vector` column exists and is unused; no
  embeddings, no similarity search, no triage suggestions.
- **Observability + load test** (Phase 6) and all Phase 7 stretch features.

## Known gaps to fix before Phase 5

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
  of send success (e.g. right when the step starts, not after it's confirmed sent),
  so a dead notification channel doesn't block the whole chain — worth doing before
  relying on this for anything beyond a demo.
- Notifications are entirely mocked (see the Phase 4 section above) — no real
  Twilio/SendGrid wiring exists yet, by deliberate choice.
