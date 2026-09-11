-- 025_inspector_sort_indexes: newest-first indexes for the inspector (Section 32.6).
--
-- The speech, jobs, audit, and overview pages each read the newest rows of one
-- table ordered by created_at_ms. Without these indexes every page load scans
-- the table and sorts it through a temp B-tree. proposals, outbox, and
-- admin_events stay small, but jobs is never pruned, so its scan grows with the
-- life of the deployment. Section 32.6 requires inspector reads to ride
-- indexed columns.

CREATE INDEX IF NOT EXISTS proposals_created_idx
  ON proposals(created_at_ms);

CREATE INDEX IF NOT EXISTS outbox_created_idx
  ON outbox(created_at_ms);

CREATE INDEX IF NOT EXISTS jobs_created_idx
  ON jobs(created_at_ms);

CREATE INDEX IF NOT EXISTS admin_events_created_idx
  ON admin_events(created_at_ms);
