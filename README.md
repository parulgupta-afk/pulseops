# PulseOps — Phase 1 through Phase 5

**Phase 1:** auth + orgs, manual on-call assignment, incident create/ack/resolve via
REST, React dashboard.

**Phase 2:** the dashboard no longer polls — every incident state change is pushed to
every connected browser instantly via Socket.io + Redis pub/sub.

**Phase 3:** the constraint-based on-call rotation generator — build a roster with
per-person blackout dates, generate a fair rotation, get a violation report if the
constraints couldn't be fully satisfied.

**Phase 4:** event-driven reliability — incident notifications run through a BullMQ
queue in a separate worker process, with retry-with-backoff and automatic escalation
through a policy chain if a page goes unacknowledged. Notifications are mocked (see
Phase 4 notes below) so the retry/escalation logic is real and demoable without
fighting Twilio.

**Phase 5 (this update):** RAG-based incident triage. When a new incident fires, its
title + description get embedded and stored in `pgvector`; a cosine-similarity search
finds the most similar past *resolved* incidents (and pulls in whatever resolution
notes were recorded on them); an LLM generates a short, explicitly-grounded summary —
instructed to use only the retrieved incidents, not invent anything — with the exact
incidents it drew from shown as clickable citations in the UI. This runs as a
background queue job so it never blocks incident creation, and updates live over the
same WebSocket connection used everywhere else.

**Why Gemini (and not a mock, unlike Phase 4's Twilio situation):** a Gemini API key
is genuinely free with no phone verification or billing setup — just a Google account
via [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — so there's no
reason to avoid the real thing here. That said, the same swappable-provider pattern
from Phase 4 still applies: `server/src/ai/` defines `EmbeddingProvider` and
`GenerationProvider` interfaces, with real Gemini implementations *and* mock
implementations (deterministic bag-of-words embeddings, template-based summaries)
that require no API key at all. If `GEMINI_API_KEY` isn't set, the app automatically
falls back to the mocks and logs that it's doing so — the whole pipeline (embed →
store → similarity search → generate → cite) is demoable and testable without ever
touching Gemini.

Verified in this scaffold: `server` and `client` typecheck clean, the client builds
with Vite, both the API server and worker boot cleanly (including with Redis
unavailable), and — since I can't reach the real Gemini API from this sandbox
environment — the **mock** embedding and generation providers were tested directly:
confirmed the mock embedder scores two incidents about the same underlying problem
(described in different words) as meaningfully more similar to each other than to an
unrelated incident, and confirmed the mock generator produces a properly grounded,
clearly-labeled summary citing the resolution notes it was given. The real Gemini
providers were written carefully against the documented API shapes but **have not
been run against the live API** — verify them once you add a real key, and check
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
if the default model names have changed since this was written.

## Project layout

```
pulseops/
├── packages/shared-types/   # Types shared by server and client — the wire format
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── ai/                # Phase 5: embedding + generation providers (Gemini + mock)
│       ├── db/                # pg pool, SQL migrations, migration runner, vector helper
│       ├── middleware/        # requireAuth, requireRole, error handling
│       ├── notifications/     # NotificationProvider interface + mock implementation
│       ├── queue/             # BullMQ queue definition + the worker process
│       ├── realtime/          # Socket.io server + Redis pub/sub fan-out
│       ├── routes/            # auth, orgs, users, schedules, incidents, escalation policies
│       ├── scheduling/        # the constraint-based rotation generator
│       └── utils/             # password hashing, JWT signing, snake_case→camelCase
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
roster table), `003_escalation.sql` (Phase 4's escalation fields), and
`004_triage.sql` (Phase 5's `triage_suggestions` table and the HNSW vector index)
against `DATABASE_URL`.

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

- **Observability + load test** (Phase 6): no structured logging beyond console.log,
  no OpenTelemetry tracing, no `/metrics` endpoint, no k6 script.
- **Phase 7 stretch features**: AI-generated postmortems (this would reuse the same
  `generationProvider` from Phase 5, prompted with the full incident timeline instead
  of similar-incident context), on-call fatigue analytics, a public status page,
  SLA/error-budget tracking.

## Known gaps to fix before Phase 6

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
- The real Gemini providers (`GeminiEmbeddingProvider`, `GeminiGenerationProvider`)
  were written against the documented API request/response shapes but have not been
  exercised against the live API from this environment — verify them with a real key
  before relying on them, and double-check the default model names
  (`text-embedding-004`, `gemini-2.0-flash`) are still current.
- The incident embedding is generated once, from title + description at creation
  time, and never re-embedded even after resolution notes are added. A more complete
  RAG implementation would re-embed (or embed separately) the resolution notes too,
  since "what actually fixed it" is arguably more useful to match on than the
  original symptom description — worth revisiting if triage quality feels shallow.
- Similarity search only looks at `status = 'resolved'` incidents within the same
  org — reasonable for real usage (an org's own history), but means a fresh org
  with no resolved incidents yet will always get an empty "similar incidents" list,
  which is expected, not broken.
