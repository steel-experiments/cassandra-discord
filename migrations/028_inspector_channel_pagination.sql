-- 028_inspector_channel_pagination: bounded, thread-aware channel inspector pages.
--
-- The channels inspector separates top-level channels from Discord threads and
-- keyset-paginates both lists by live state, normalized name, and id.

CREATE INDEX IF NOT EXISTS channels_inspector_kind_name_idx
  ON channels(is_thread, (deleted_at_ms IS NOT NULL), LOWER(COALESCE(name, id)), id);
