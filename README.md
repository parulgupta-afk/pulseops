# PulseOps — Phase 1

On-call operations platform: auth + orgs, manual on-call assignment, incident
create / acknowledge / resolve via REST, and a React dashboard that polls the
API every 5 s. This is the foundation the rest of the phased build plan
(real-time push, the scheduling algorithm, event-driven reliability, RAG) gets
layered onto — nothing here needs to be torn out later.

**Verified in this scaffold:** both `server` and `client` typecheck clean
(`tsc --noEmit`), the client builds with Vite, and the Express app boots.

---

## Project layout

```
pulseops/
├── packages/shared-types/    # Wire-format types shared by server ↔ client
├── server/                   # Express + TypeScript API  (port 4000)
│   └── src/
│       ├── db/               # pg pool, SQL migrations, migration runner
│       ├── middleware/       # requireAuth, requireRole, errorHandler
│       ├── routes/           # auth · orgs · users · schedules · incidents
│       └── utils/            # bcrypt password helpers, JWT sign/verify
├── client/                   # React + TypeScript + Vite  (port 5173)
│   └── src/
│       ├── api/              # axios client with JWT interceptor
│       ├── context/          # AuthContext (localStorage persistence)
│       ├── pages/            # Login · Register · Dashboard · Schedule
│       └── components/       # Layout · IncidentCard
└── docker-compose.yml        # Postgres (pgvector/pg16) + Redis 7
```

---

## Setup

### 1 — Start Postgres + Redis

```bash
docker compose up -d
```

Redis isn't used until Phase 4 (BullMQ), but it's in the compose file now so
the file doesn't change shape later.

### 2 — Install dependencies

```bash
npm install          # npm workspaces — one install for the whole monorepo
```

### 3 — Configure environment variables

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

The defaults match the docker-compose Postgres/Redis credentials, so nothing
needs editing to run locally. Change `JWT_SECRET` before this ever goes
anywhere real.

<details>
<summary>server/.env.example</summary>

```env
PORT=4000
DATABASE_URL=postgres://pulseops:pulseops@localhost:5432/pulseops
JWT_SECRET=change-me-to-a-long-random-string
CORS_ORIGIN=http://localhost:5173

# Stubs — unused until the phases that need them
REDIS_URL=redis://localhost:6379
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
SENDGRID_API_KEY=
SENDGRID_FROM_EMAIL=
GEMINI_API_KEY=
```

</details>

<details>
<summary>client/.env.example</summary>

```env
VITE_API_URL=http://localhost:4000
```

</details>

### 4 — Run migrations

```bash
npm run migrate
```

Executes `server/src/db/migrations/001_init.sql` against `DATABASE_URL`.
Creates every table in the data model — including `embedding_vector` on
`incidents` and the `vector` extension — so this migration won't need to
change shape in later phases.

**Tables created:** `orgs`, `users`, `schedules`, `schedule_shifts`,
`escalation_policies`, `incidents`, `incident_events`, `postmortems`.

### 5 — Run the app

Open two terminals:

```bash
# Terminal 1
npm run dev:server   # tsx watch — hot-reloads on save → http://localhost:4000

# Terminal 2
npm run dev:client   # Vite dev server → http://localhost:5173
```

---

## Full end-to-end walkthrough

### Step 1 — Register your org

Go to **http://localhost:5173/register**. Fill in org name, your name, email,
and password. This creates the org and makes you its first `admin`.

The JWT is stored in `localStorage` under `pulseops_token` and is attached as a
`Bearer` token on every API request by the axios interceptor.

### Step 2 — Add a teammate (optional — needed for on-call assignment)

```bash
# Grab the token from DevTools → Application → Local Storage → pulseops_token
TOKEN="<your-token>"

curl -X POST http://localhost:4000/api/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Responder",
    "email": "alice@example.com",
    "password": "supersecret123",
    "role": "responder"
  }'
```

### Step 3 — Create a schedule and add a shift

Go to **http://localhost:5173/schedule** and:

1. Click **Create schedule** (give it any name, e.g. "Primary").
2. Pick yourself (or Alice) as the responder, set **Starts** to a time in the
   past and **Ends** to a time in the future, then click **Add shift**.
3. The "Currently on-call" banner updates immediately.

Or via curl:

```bash
# List schedules to get the id
curl http://localhost:4000/api/schedules \
  -H "Authorization: Bearer $TOKEN"

SCHEDULE_ID="<schedule-uuid>"
YOUR_USER_ID="<user-uuid from register response or GET /api/users>"

# Add a shift covering right now (adjust ISO strings for your timezone)
curl -X POST http://localhost:4000/api/schedules/$SCHEDULE_ID/shifts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"userId\": \"$YOUR_USER_ID\",
    \"startsAt\": \"2026-08-08T10:00:00Z\",
    \"endsAt\":   \"2026-08-09T10:00:00Z\"
  }"
```

### Step 4 — Fire a test incident 🔥

```bash
curl -X POST http://localhost:4000/api/incidents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"idempotencyKey\": \"test-001\",
    \"title\": \"Checkout API returning 500s\",
    \"description\": \"Spike in 5xx on /checkout starting 14:02 UTC\",
    \"scheduleId\": \"$SCHEDULE_ID\"
  }"
```

**What happens:**

1. API checks whether `(org_id, idempotency_key)` already exists — if so,
   returns the existing incident with HTTP 200 (idempotent, no duplicate).
2. Looks up the current on-call shift for `scheduleId`; if `now()` falls inside
   a shift, `assigned_user_id` is set to that user.
3. Inserts the incident in a transaction alongside `incident_events` rows
   (`fired` + optionally `paged`).
4. Returns HTTP 201 with the full incident object.

The dashboard at **http://localhost:5173** picks it up within 5 seconds (poll
interval) and shows it in the **Firing** tab.

### Step 5 — Acknowledge and resolve

From the dashboard: click **Acknowledge**, then **Resolve** on the incident card.

Or via curl:

```bash
INCIDENT_ID="<id from the POST /api/incidents response>"

# Acknowledge — only transitions from 'firing'
curl -X POST http://localhost:4000/api/incidents/$INCIDENT_ID/acknowledge \
  -H "Authorization: Bearer $TOKEN"

# Resolve — works from 'firing' or 'acknowledged'
curl -X POST http://localhost:4000/api/incidents/$INCIDENT_ID/resolve \
  -H "Authorization: Bearer $TOKEN"
```

### Step 6 — Test idempotency

```bash
# Re-fire with the same key — returns HTTP 200 + the original incident, no duplicate
curl -X POST http://localhost:4000/api/incidents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"idempotencyKey\": \"test-001\",
    \"title\": \"This would be a duplicate\",
    \"scheduleId\": \"$SCHEDULE_ID\"
  }"
```

---

## API reference

All routes except the two auth endpoints require `Authorization: Bearer <token>`.

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | — | Create org + first admin user |
| `POST` | `/api/auth/login` | — | Sign in, receive JWT |
| `GET` | `/api/users` | any | List users in your org |
| `POST` | `/api/users` | admin | Add a user to your org |
| `GET` | `/api/schedules` | any | List schedules |
| `POST` | `/api/schedules` | admin | Create a schedule |
| `GET` | `/api/schedules/:id/current-oncall` | any | Who is on-call right now |
| `GET` | `/api/schedules/:id/shifts` | any | All shifts for a schedule |
| `POST` | `/api/schedules/:id/shifts` | admin | Add a manual shift |
| `GET` | `/api/incidents` | any | List incidents (`?status=firing\|acknowledged\|resolved`) |
| `GET` | `/api/incidents/:id` | any | Single incident |
| `GET` | `/api/incidents/:id/events` | any | Audit trail for an incident |
| `POST` | `/api/incidents` | any | Ingest / fire an incident |
| `POST` | `/api/incidents/:id/acknowledge` | any | Ack (firing → acknowledged) |
| `POST` | `/api/incidents/:id/resolve` | any | Resolve |
| `PATCH` | `/api/incidents/:id/assign` | any | Manually reassign `{ userId }` |
| `GET` | `/health` | — | Liveness probe — `{ ok: true }` |

---

## Architecture notes

| Concern | Phase 1 decision | Future phase |
|---------|-----------------|--------------|
| Real-time | Dashboard polls every 5 s | Phase 2: WebSocket push |
| Scheduling | Admin adds shifts one at a time | Phase 3: constraint-based algorithm |
| Incident ingestion | Synchronous DB write | Phase 4: BullMQ worker, retry/backoff |
| Idempotency | DB `UNIQUE (org_id, idempotency_key)` | Phase 4: 24 h window queue-based dedupe |
| Notifications | Not sent | Phase 4: Twilio SMS + SendGrid email |
| Escalation policies | Table exists, nothing reads it | Phase 4 |
| AI / RAG | `embedding_vector vector(768)` column exists, unused | Phase 5 |
| Auth | Flat 7-day JWT, no refresh token | Revisit before shipping |

---

## Known gaps to fix before Phase 2

- **Blackout dates** are stored on `schedules` (org-wide). Phase 3's algorithm
  needs them per-user — that's an intentional schema change to make deliberately.
- **No refresh-token flow** — the JWT is a flat 7-day token. Fine for a demo.
- **`errorHandler` returns raw `err.message`** to the client. Fine for a
  portfolio project; not something you'd ship with real user-facing error text.

---

## npm scripts (root)

| Script | What it does |
|--------|-------------|
| `npm install` | Install all workspaces (server, client, shared-types) |
| `npm run dev:server` | `tsx watch server/src/index.ts` — auto-reloads on save |
| `npm run dev:client` | Vite dev server |
| `npm run migrate` | Run `server/src/db/migrations/*.sql` in filename order |
| `npm run build` | Production build for all three workspaces |
