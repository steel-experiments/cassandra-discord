-- 024_inspector_indexes: cursor-pagination indexes for the inspector (Section 32.6).
--
-- The inspector lists episodes by (last_activity_at_ms, id) and runs by
-- (started_at_ms, id), newest first, with keyset cursors. Section 32.6 requires
-- cursor pagination to ride indexed columns; before this migration both lists
-- sorted through a temp B-tree over a full table scan on every page. The
-- agent_runs index also lets the memory-detail reassessment scan bound itself
-- to the newest runs.

CREATE INDEX IF NOT EXISTS episodes_last_activity_idx
  ON episodes(last_activity_at_ms, id);

CREATE INDEX IF NOT EXISTS agent_runs_started_idx
  ON agent_runs(started_at_ms, id);
