-- 011_historical_episodes: resumable reconstruction of backfilled history.

ALTER TABLE episodes ADD COLUMN origin TEXT NOT NULL DEFAULT 'live'
  CHECK (origin IN ('live', 'historical'));

CREATE INDEX IF NOT EXISTS episodes_origin_status_idx
  ON episodes(origin, status, created_at_ms);

CREATE TABLE IF NOT EXISTS historical_episode_cursors (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  cutoff_at_ms INTEGER NOT NULL,
  last_created_at_ms INTEGER,
  last_message_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'complete')),
  messages_scanned INTEGER NOT NULL DEFAULT 0,
  episodes_created INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS historical_episode_cursors_state_idx
  ON historical_episode_cursors(state, updated_at_ms, channel_id);
