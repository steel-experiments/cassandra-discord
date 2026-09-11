ALTER TABLE agent_runs
  ADD COLUMN execution_started_at_ms INTEGER
  CHECK (execution_started_at_ms IS NULL OR execution_started_at_ms >= 0);
