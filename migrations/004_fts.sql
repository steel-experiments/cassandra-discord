-- 004_fts: external-content FTS5 indexes and triggers (Section 29, 29.1, 30).
-- Both FTS tables map to implicit rowids. Tombstoned messages (deleted_at_ms
-- set) are excluded from search. Rebuild both indexes after any VACUUM (28).

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  author_display_name,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);

CREATE TRIGGER IF NOT EXISTS messages_ai
AFTER INSERT ON messages
WHEN new.deleted_at_ms IS NULL
BEGIN
  INSERT INTO messages_fts(rowid, content, author_display_name)
  VALUES (new.rowid, new.content, new.author_display_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad
AFTER DELETE ON messages
WHEN old.deleted_at_ms IS NULL
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, author_display_name)
  VALUES ('delete', old.rowid, old.content, old.author_display_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_au
AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, author_display_name)
  SELECT 'delete', old.rowid, old.content, old.author_display_name
  WHERE old.deleted_at_ms IS NULL;

  INSERT INTO messages_fts(rowid, content, author_display_name)
  SELECT new.rowid, new.content, new.author_display_name
  WHERE new.deleted_at_ms IS NULL;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  statement,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);

CREATE TRIGGER IF NOT EXISTS memories_ai
AFTER INSERT ON memories
BEGIN
  INSERT INTO memories_fts(rowid, statement)
  VALUES (new.rowid, new.statement);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad
AFTER DELETE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);
END;

CREATE TRIGGER IF NOT EXISTS memories_au
AFTER UPDATE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);

  INSERT INTO memories_fts(rowid, statement)
  VALUES (new.rowid, new.statement);
END;
