-- Phase 8 (SDE hardening): composite indexes matched to real query patterns,
-- plus a failed_jobs table for dead-letter visibility after BullMQ exhausts retries.
--
-- Dashboard list: WHERE org_id = $1 AND status = $2 ORDER BY fired_at DESC
CREATE INDEX IF NOT EXISTS idx_incidents_org_status_fired
  ON incidents (org_id, status, fired_at DESC);

-- On-call lookup: JOIN schedule_shifts WHERE schedule_id = $1 AND now() BETWEEN starts_at AND ends_at
CREATE INDEX IF NOT EXISTS idx_shifts_schedule_active
  ON schedule_shifts (schedule_id, starts_at, ends_at);

-- Public status recently-resolved: WHERE org_id AND status = 'resolved' ORDER BY resolved_at
CREATE INDEX IF NOT EXISTS idx_incidents_org_resolved
  ON incidents (org_id, resolved_at DESC)
  WHERE status = 'resolved';

-- Dead-letter / permanently failed queue jobs (page, embed, postmortem, etc.).
-- BullMQ keeps failed jobs in Redis; we also persist a durable record so
-- operators can query without Redis and so metrics/timeline can reference it.
CREATE TABLE IF NOT EXISTS failed_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  queue_name TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_id TEXT,
  incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
  org_id UUID REFERENCES orgs(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL,
  attempts_made INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_failed_jobs_created_at ON failed_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_incident_id ON failed_jobs (incident_id);
CREATE INDEX IF NOT EXISTS idx_failed_jobs_org_id ON failed_jobs (org_id);
