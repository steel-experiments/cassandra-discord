-- 003_operations: agent runs, proposals, outbox, durable jobs, MCP tokens,
-- admin events (Section 29).

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  episode_id TEXT REFERENCES episodes(id),
  run_type TEXT NOT NULL
    CHECK (run_type IN ('episode', 'direct_answer', 'scheduled_review')),
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'completed', 'failed', 'rejected')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  retrieval_provenance_json TEXT NOT NULL DEFAULT '[]',
  final_proposal_json TEXT,
  error TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS agent_runs_episode_idx
  ON agent_runs(episode_id, started_at_ms);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  episode_id TEXT REFERENCES episodes(id),
  target_channel_id TEXT NOT NULL REFERENCES channels(id),
  status TEXT NOT NULL
    CHECK (status IN ('observed', 'pending_review', 'approved', 'dismissed', 'expired', 'sent', 'failed')),
  computed_score REAL NOT NULL,
  reason TEXT NOT NULL,
  message TEXT,
  evidence_message_ids_json TEXT NOT NULL,
  review_message_id TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at_ms INTEGER,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS proposals_status_idx
  ON proposals(status, created_at_ms);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES proposals(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  reply_to_message_id TEXT,
  content TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  discord_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON outbox(status, next_attempt_at_ms);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  unique_key TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  run_after_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs(status, run_after_ms, priority, created_at_ms);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_unique_idx
  ON jobs(type, unique_key)
  WHERE unique_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL DEFAULT 'org'
    CHECK (scope_type IN ('org', 'org_plus_channels')),
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  last_used_at_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS admin_events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
) STRICT;
