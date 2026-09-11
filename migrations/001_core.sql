-- 001_core: core Discord storage (Section 29).
-- STRICT tables, checks, foreign keys, and indexes for settings, guilds,
-- channels, users, guild_members, messages, versions, attachments, reactions,
-- reaction counts, sync cursors, and access audits.
-- schema_migrations is owned by the migration runner (src/db/migrations.ts).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT,
  joined_at_ms INTEGER,
  discovered_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  raw_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  parent_id TEXT,
  type INTEGER NOT NULL,
  name TEXT,
  topic TEXT,
  position INTEGER,
  is_thread INTEGER NOT NULL DEFAULT 0 CHECK (is_thread IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  ingest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ingest_enabled IN (0, 1)),
  visibility_class TEXT NOT NULL DEFAULT 'restricted'
    CHECK (visibility_class IN ('org', 'restricted', 'review_only', 'excluded')),
  allow_interventions INTEGER NOT NULL DEFAULT 0
    CHECK (allow_interventions IN (0, 1)),
  permission_fingerprint TEXT,
  last_message_id TEXT,
  discovered_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  raw_json TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS channels_guild_idx
  ON channels(guild_id, deleted_at_ms);

CREATE INDEX IF NOT EXISTS channels_parent_idx
  ON channels(parent_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  global_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  raw_json TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  display_name TEXT,
  role_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id TEXT REFERENCES users(id),
  author_display_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  edited_at_ms INTEGER,
  deleted_at_ms INTEGER,
  reply_to_message_id TEXT,
  message_type INTEGER,
  flags INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  mention_everyone INTEGER NOT NULL DEFAULT 0 CHECK (mention_everyone IN (0, 1)),
  mentions_json TEXT NOT NULL DEFAULT '[]',
  embeds_json TEXT NOT NULL DEFAULT '[]',
  components_json TEXT NOT NULL DEFAULT '[]',
  poll_json TEXT,
  raw_json TEXT,
  ingested_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS messages_channel_time_idx
  ON messages(channel_id, created_at_ms);

CREATE INDEX IF NOT EXISTS messages_author_time_idx
  ON messages(author_id, created_at_ms);

CREATE INDEX IF NOT EXISTS messages_reply_idx
  ON messages(reply_to_message_id);

CREATE TABLE IF NOT EXISTS message_versions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  edited_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (message_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  source_url TEXT,
  proxy_url TEXT,
  archive_status TEXT NOT NULL DEFAULT 'metadata'
    CHECK (archive_status IN ('none', 'metadata', 'queued', 'stored', 'failed', 'deleted')),
  local_path TEXT,
  sha256 TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji_key)
) STRICT;

CREATE INDEX IF NOT EXISTS reactions_message_idx
  ON reactions(message_id, emoji_key);

CREATE TABLE IF NOT EXISTS reaction_counts (
  message_id TEXT NOT NULL REFERENCES messages(id),
  emoji_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  source TEXT NOT NULL DEFAULT 'backfill' CHECK (source IN ('backfill', 'live')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji_key)
) STRICT;

CREATE TABLE IF NOT EXISTS sync_cursors (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'backfilling', 'live', 'error', 'excluded')),
  history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1)),
  oldest_message_id TEXT,
  newest_message_id TEXT,
  oldest_created_at_ms INTEGER,
  newest_created_at_ms INTEGER,
  next_before_message_id TEXT,
  last_reconciled_at_ms INTEGER,
  last_success_at_ms INTEGER,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS channel_access_audits (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  checked_at_ms INTEGER NOT NULL,
  can_view INTEGER NOT NULL CHECK (can_view IN (0, 1)),
  can_read_history INTEGER NOT NULL CHECK (can_read_history IN (0, 1)),
  can_send INTEGER NOT NULL CHECK (can_send IN (0, 1)),
  can_send_in_threads INTEGER NOT NULL CHECK (can_send_in_threads IN (0, 1)),
  can_manage_threads INTEGER NOT NULL CHECK (can_manage_threads IN (0, 1)),
  warning TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS channel_access_latest_idx
  ON channel_access_audits(channel_id, checked_at_ms DESC);
