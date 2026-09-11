-- 002_memory: episodes and organizational memory (Section 29).
-- STRICT tables and indexes for episodes, episode messages, memories, memory
-- evidence, and memory links with lifecycle enums and constraints.

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  conversation_channel_id TEXT NOT NULL REFERENCES channels(id),
  status TEXT NOT NULL
    CHECK (status IN ('open', 'queued', 'reviewing', 'reviewed', 'skipped', 'error')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  last_activity_at_ms INTEGER NOT NULL,
  human_message_count INTEGER NOT NULL DEFAULT 0,
  total_message_count INTEGER NOT NULL DEFAULT 0,
  trigger_reason TEXT,
  summary TEXT,
  consequential INTEGER CHECK (consequential IN (0, 1)),
  intervention_score REAL,
  created_at_ms INTEGER NOT NULL,
  reviewed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS episodes_conversation_status_idx
  ON episodes(conversation_channel_id, status, last_activity_at_ms);

CREATE TABLE IF NOT EXISTS episode_messages (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (episode_id, message_id),
  UNIQUE (episode_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('org', 'channel', 'review_only')),
  scope_key TEXT,
  type TEXT NOT NULL
    CHECK (type IN (
      'decision', 'assumption', 'prediction', 'fact', 'risk',
      'commitment', 'experiment', 'disagreement', 'constraint', 'open_question'
    )),
  statement TEXT NOT NULL,
  normalized_key TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'resolved', 'invalidated', 'expired')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  owner_user_id TEXT REFERENCES users(id),
  valid_from_ms INTEGER,
  review_after_ms INTEGER,
  resolved_at_ms INTEGER,
  first_seen_at_ms INTEGER NOT NULL,
  last_confirmed_at_ms INTEGER NOT NULL,
  created_by_run_id TEXT,
  supersedes_memory_id TEXT REFERENCES memories(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memories_scope_status_idx
  ON memories(guild_id, scope_type, scope_key, status);

CREATE INDEX IF NOT EXISTS memories_review_idx
  ON memories(review_after_ms, status);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  stance TEXT NOT NULL
    CHECK (stance IN ('origin', 'supports', 'contradicts', 'updates', 'resolves')),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  note TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (memory_id, message_id, stance)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_links (
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL
    CHECK (relation IN ('supports', 'contradicts', 'supersedes', 'related')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source_memory_id, target_memory_id, relation)
) STRICT;
