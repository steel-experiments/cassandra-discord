CREATE TABLE deep_recap_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  target_channel_id TEXT NOT NULL REFERENCES channels(id),
  requested_by_user_id TEXT NOT NULL,
  topic TEXT,
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  after_at_ms INTEGER NOT NULL,
  before_at_ms INTEGER NOT NULL,
  budget_usd REAL NOT NULL CHECK (budget_usd > 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  synthesis_cost_usd REAL NOT NULL DEFAULT 0 CHECK (synthesis_cost_usd >= 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','synthesizing','completed','partial','failed','cancelled')),
  total_matching_messages INTEGER NOT NULL DEFAULT 0 CHECK (total_matching_messages >= 0),
  included_messages INTEGER NOT NULL DEFAULT 0 CHECK (included_messages >= 0),
  planned_chunks INTEGER NOT NULL DEFAULT 0 CHECK (planned_chunks >= 0),
  completed_chunks INTEGER NOT NULL DEFAULT 0 CHECK (completed_chunks >= 0),
  coverage_complete INTEGER NOT NULL DEFAULT 1 CHECK (coverage_complete IN (0,1)),
  outbox_id TEXT UNIQUE REFERENCES outbox(id),
  last_error_category TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  CHECK (after_at_ms < before_at_ms),
  CHECK ((status IN ('completed','partial','failed','cancelled')) = (completed_at_ms IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX deep_recap_active_target_idx
  ON deep_recap_requests(guild_id, target_channel_id)
  WHERE status IN ('queued','running','synthesizing');

CREATE INDEX deep_recap_recent_idx
  ON deep_recap_requests(created_at_ms DESC);

CREATE TABLE deep_recap_chunks (
  request_id TEXT NOT NULL REFERENCES deep_recap_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  after_at_ms INTEGER NOT NULL,
  before_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  matching_messages INTEGER NOT NULL DEFAULT 0 CHECK (matching_messages >= 0),
  included_messages INTEGER NOT NULL DEFAULT 0 CHECK (included_messages >= 0),
  coverage_complete INTEGER NOT NULL DEFAULT 1 CHECK (coverage_complete IN (0,1)),
  summary TEXT,
  cited_message_ids_json TEXT NOT NULL DEFAULT '[]',
  source_message_ids_json TEXT NOT NULL DEFAULT '[]',
  source_fingerprints_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT REFERENCES agent_runs(id),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (request_id, ordinal),
  CHECK (after_at_ms < before_at_ms)
) STRICT;

CREATE INDEX deep_recap_chunks_pending_idx
  ON deep_recap_chunks(request_id, status, ordinal);
