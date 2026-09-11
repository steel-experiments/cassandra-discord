ALTER TABLE agent_runs
  ADD COLUMN uncached_input_tokens INTEGER
  CHECK (uncached_input_tokens IS NULL OR uncached_input_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN cache_read_tokens INTEGER
  CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN cache_write_tokens INTEGER
  CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN cache_write_1h_tokens INTEGER
  CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN reasoning_tokens INTEGER
  CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN provider_total_tokens INTEGER
  CHECK (provider_total_tokens IS NULL OR provider_total_tokens >= 0);

ALTER TABLE agent_runs
  ADD COLUMN uncached_input_cost_usd REAL
  CHECK (uncached_input_cost_usd IS NULL OR uncached_input_cost_usd >= 0);

ALTER TABLE agent_runs
  ADD COLUMN output_cost_usd REAL
  CHECK (output_cost_usd IS NULL OR output_cost_usd >= 0);

ALTER TABLE agent_runs
  ADD COLUMN cache_read_cost_usd REAL
  CHECK (cache_read_cost_usd IS NULL OR cache_read_cost_usd >= 0);

ALTER TABLE agent_runs
  ADD COLUMN cache_write_cost_usd REAL
  CHECK (cache_write_cost_usd IS NULL OR cache_write_cost_usd >= 0);

ALTER TABLE agent_runs
  ADD COLUMN thinking_level TEXT
  CHECK (
    thinking_level IS NULL
    OR thinking_level IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  );
