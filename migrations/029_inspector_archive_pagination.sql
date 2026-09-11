-- 029_inspector_archive_pagination: keyset indexes for remaining inspector archives.
--
-- Every unbounded inspector archive now orders by a deterministic tuple. The
-- trailing id makes equal timestamps/scores lossless across cursor pages.

CREATE INDEX IF NOT EXISTS memories_inspector_archive_idx
  ON memories(importance DESC, last_confirmed_at_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS memory_evidence_inspector_archive_idx
  ON memory_evidence(memory_id, created_at_ms, message_id, stance);

CREATE INDEX IF NOT EXISTS proposals_inspector_archive_idx
  ON proposals(created_at_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS outbox_inspector_archive_idx
  ON outbox(created_at_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS jobs_inspector_archive_idx
  ON jobs(created_at_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_events_inspector_archive_idx
  ON admin_events(created_at_ms DESC, id DESC);
