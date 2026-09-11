-- Durable reconciliation scan state and privacy-safe recovery requests.
ALTER TABLE sync_cursors ADD COLUMN reconcile_scan_started_at_ms INTEGER;
ALTER TABLE sync_cursors ADD COLUMN reconcile_lower_bound_ms INTEGER;
ALTER TABLE sync_cursors ADD COLUMN reconcile_head_message_id TEXT;
ALTER TABLE sync_cursors ADD COLUMN last_completed_reconcile_scan_started_at_ms INTEGER;

CREATE TABLE ingestion_recovery_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL CHECK(reason IN ('missing_channel','missing_message')),
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','unavailable','skipped','expired')),
  first_observed_at_ms INTEGER NOT NULL,
  last_observed_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE(guild_id, channel_id, message_id)
) STRICT;
CREATE INDEX ingestion_recovery_pending_idx
  ON ingestion_recovery_requests(status, last_observed_at_ms);
