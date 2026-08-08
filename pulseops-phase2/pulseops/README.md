# PulseOps — Phase 1 + Phase 2

**Phase 1:** auth + orgs, manual on-call assignment, incident create/ack/resolve via
REST, React dashboard.

**Phase 2 (this update):** the dashboard no longer polls. Every incident state change
(fired, acknowledged, resolved, reassigned) is published to Redis, and every connected
browser gets it pushed over a WebSocket instantly via Socket.io — open the dashboard in
two tabs, acknowledge an incident in one, watch it update in the other with no refresh.
This also fixed a real bug from Phase 1: API responses were returning raw
Postgres `snake_case` columns (`fired_at`) while the client expected `camelCase`
(`firedAt`) — every route now converts via `toCamelCase()` before sending JSON.

Verified in this scaffold: both `server` and `client` typecheck clean (`tsc --noEmit`),
the client builds with Vite, and the Express app boots (including with Redis
unavailable — it logs connection errors instead of crashing, so a Redis hiccup
in dev doesn't take down the whole API). Not yet run end-to-end against a live
Postgres + Redis instance — do that first before building on top of it.

## Project layout

```
pulseops/
├── packages/shared-types/   # Types shared by server and client — the wire format
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── db/               # pg pool, SQL migrations, migration runner
│       ├── middleware/       # requireAuth, requireRole, error handling
│       ├── realtime/         # Socket.io server + Redis pub/sub fan-out
│       ├── routes/           # auth, orgs, users, schedules, incidents
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

This runs `server/src/db/migrations/001_init.sql` against `DATABASE_URL`. It creates
every table in the spec's data model (including `embedding_vector` on `incidents`
and the `vector` extension), even though most of it stays unused until later phases —
so this migration shouldn't need to change shape again.

**5. Run the app**

```bash
npm run dev:server   # http://localhost:4000
npm run dev:client   # http://localhost:5173
```

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

## What's deliberately not here yet

- **The scheduling algorithm** (Phase 3): shifts are added one at a time by an admin.
- **Event-driven reliability** (Phase 4): incident ingestion writes synchronously
  instead of going through BullMQ; no notification sending, retry/backoff, or
  escalation-policy timeouts yet (the `escalation_policies` table exists but nothing
  reads from it).
- **AI layer** (Phase 5): `embedding_vector` column exists and is unused; no
  embeddings, no similarity search, no triage suggestions.
- **Observability + load test** (Phase 6) and all Phase 7 stretch features.

## Known gaps to fix before Phase 2

- Blackout dates live on `schedules` (org-wide) for now; the algorithm in Phase 3
  will need them per-user, so that's a schema change to make deliberately, not by accident.
- No refresh-token flow — the JWT is a flat 7-day token. Fine for a demo, worth
  revisiting if this goes further.
- `errorHandler` returns raw `err.message` to the client, which is fine for a
  portfolio project but not something you'd ship with real user-facing error text.
