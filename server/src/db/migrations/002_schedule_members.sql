-- Phase 3: the constraint-based rotation generator needs per-person time-off,
-- not the org-wide blackout_dates on `schedules` from Phase 1 (that column is
-- left in place, unused, rather than dropped -- no data depends on it yet).
--
-- schedule_members is the roster: who participates in a given schedule's
-- rotation, and their individual blackout (time-off) dates -- the hard
-- constraint the algorithm may never violate.

CREATE TABLE IF NOT EXISTS schedule_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blackout_dates DATE[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_members_schedule_id ON schedule_members(schedule_id);
