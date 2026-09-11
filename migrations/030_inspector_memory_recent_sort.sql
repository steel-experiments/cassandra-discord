-- 030_inspector_memory_recent_sort: newest-first memory inspector archive.

CREATE INDEX IF NOT EXISTS memories_inspector_recent_idx
  ON memories(last_confirmed_at_ms DESC, id DESC);
