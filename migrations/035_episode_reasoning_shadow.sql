ALTER TABLE agent_runs
  ADD COLUMN shadow_of_run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT;

ALTER TABLE agent_runs
  ADD COLUMN shadow_comparison_json TEXT
  CHECK (
    shadow_comparison_json IS NULL
    OR (json_valid(shadow_comparison_json) AND json_type(shadow_comparison_json) = 'object')
  );

CREATE UNIQUE INDEX agent_runs_shadow_of_idx
  ON agent_runs(shadow_of_run_id)
  WHERE shadow_of_run_id IS NOT NULL;
