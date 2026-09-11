-- 006_message_tombstones: deletion events must win over later REST payloads.

CREATE TABLE IF NOT EXISTS message_tombstones (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT,
  guild_id TEXT,
  deleted_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO message_tombstones (message_id, channel_id, guild_id, deleted_at_ms, created_at_ms)
SELECT id, channel_id, guild_id, deleted_at_ms, deleted_at_ms
  FROM messages
 WHERE deleted_at_ms IS NOT NULL;
