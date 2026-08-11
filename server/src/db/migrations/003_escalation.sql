-- Phase 4: links an incident to the escalation policy that should page it.
-- Nullable: incidents created without one just get the immediate on-call
-- assignment from Phase 1 with no automatic re-paging on timeout.
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS escalation_policy_id UUID REFERENCES escalation_policies(id);

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS current_escalation_step INT NOT NULL DEFAULT 0;
