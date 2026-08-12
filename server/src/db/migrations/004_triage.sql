-- Phase 5: RAG-based incident triage.

CREATE TABLE IF NOT EXISTS triage_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID UNIQUE NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  -- [{ incidentId, title, similarity, resolvedAt }] — kept denormalized as
  -- JSONB rather than a join table since this is a point-in-time snapshot of
  -- "what the AI saw when it generated this," not live-updating data.
  similar_incidents JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_triage_suggestions_incident_id ON triage_suggestions(incident_id);

-- HNSW rather than IVFFlat: IVFFlat needs a "training" pass and a tuned list
-- count to be effective, which only makes sense once a table has real volume.
-- HNSW builds incrementally as rows are inserted and performs well even on
-- a table with a handful of rows, which fits a demo/portfolio dataset better.
CREATE INDEX IF NOT EXISTS idx_incidents_embedding_hnsw
  ON incidents USING hnsw (embedding_vector vector_cosine_ops);
