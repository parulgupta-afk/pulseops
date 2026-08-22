# PulseOps Phase 8 — SDE Hardening

Copy these files into your main PulseOps repo, preserving paths.

## Apply

```bash
# from your main pulseops root
unzip pulseops-phase8.zip -d /tmp/p8
# merge (overwrites matching paths)
cp -R /tmp/p8/.github . 2>/dev/null || true
cp /tmp/p8/package.json .
cp /tmp/p8/README.md .
cp -R /tmp/p8/server/* server/

npm install
npm run migrate   # runs 006_indexes_and_hardening.sql
npm test          # 16 unit tests
```

## What's included

### New
- `.github/workflows/ci.yml`
- `server/src/middleware/rateLimit.ts`
- `server/src/db/migrations/006_indexes_and_hardening.sql`
- `server/src/__tests__/sla.test.ts`
- `server/src/__tests__/generateRotation.test.ts`
- `server/src/__tests__/incidentState.test.ts`

### Modified
- `package.json`, `README.md`
- `server/package.json`, `server/tsconfig.json`
- `server/src/index.ts` (graceful shutdown)
- `server/src/observability/metrics.ts` (queue failure counters)
- `server/src/queue/incidentQueue.ts` (DLQ)
- `server/src/queue/worker.ts` (escalation recovery + DLQ persist)
- `server/src/routes/auth.routes.ts` (rate limit)
- `server/src/routes/incidents.routes.ts` (rate limit)
- `server/src/routes/public.routes.ts` (rate limit)
