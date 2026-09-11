-- 012_historical_campaigns: bounded, resumable historical-memory campaigns.

ALTER TABLE episodes ADD COLUMN historical_campaign_id TEXT;

CREATE INDEX IF NOT EXISTS episodes_historical_campaign_status_idx
  ON episodes(historical_campaign_id, status, created_at_ms);

CREATE TABLE IF NOT EXISTS historical_memory_campaigns (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'paused', 'completed', 'budget_exhausted')),
  direction TEXT NOT NULL DEFAULT 'newest_first'
    CHECK (direction IN ('newest_first')),
  from_at_ms INTEGER NOT NULL,
  to_at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  channel_ids_json TEXT NOT NULL,
  daily_budget_usd REAL NOT NULL CHECK (daily_budget_usd >= 0),
  total_budget_usd REAL NOT NULL CHECK (total_budget_usd > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  CHECK (from_at_ms < to_at_ms)
) STRICT;

CREATE TABLE IF NOT EXISTS historical_campaign_cursors (
  campaign_id TEXT NOT NULL REFERENCES historical_memory_campaigns(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  upper_created_at_ms INTEGER,
  upper_message_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'complete')),
  messages_scanned INTEGER NOT NULL DEFAULT 0,
  episodes_created INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, channel_id)
) STRICT;

CREATE INDEX IF NOT EXISTS historical_campaign_cursors_state_idx
  ON historical_campaign_cursors(campaign_id, state, updated_at_ms, channel_id);
