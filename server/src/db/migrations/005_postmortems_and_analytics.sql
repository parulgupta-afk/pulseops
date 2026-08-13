-- Phase 7: on-call fatigue analytics needs to know WHO a page/escalation was
-- actually sent to, not just who performed a manual action (actor_id already
-- covers "who acknowledged/resolved this"). target_user_id is that missing piece.
ALTER TABLE incident_events
  ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_incident_events_target_user_id ON incident_events(target_user_id);

-- Phase 7: AI postmortems. One postmortem per incident, regenerable — using a
-- unique index (rather than a table constraint) so ON CONFLICT (incident_id)
-- DO UPDATE works cleanly for the "regenerate" case.
CREATE UNIQUE INDEX IF NOT EXISTS idx_postmortems_incident_id ON postmortems(incident_id);
