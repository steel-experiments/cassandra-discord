-- 008_attachment_file_purges: durable cleanup for archived attachment files.

CREATE TABLE IF NOT EXISTS attachment_file_purges (
  id TEXT PRIMARY KEY,
  attachment_id TEXT,
  local_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'purged', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  purged_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS attachment_file_purges_status_idx
  ON attachment_file_purges(status, updated_at_ms);
