CREATE TABLE channel_policy_reviews (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  observed_parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','org','restricted','excluded','superseded')),
  delivery_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_state IN ('queued','sending','sent','failed')),
  review_message_id TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at_ms INTEGER,
  superseded_reason TEXT
    CHECK (superseded_reason IS NULL OR superseded_reason IN (
      'static_policy','parent_changed','channel_deleted','unsupported','review_channel'
    )),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (status IN ('org','restricted','excluded') AND reviewed_by_user_id IS NOT NULL AND reviewed_at_ms IS NOT NULL)
    OR status IN ('pending','superseded')
  ),
  CHECK (status <> 'pending' OR reviewed_by_user_id IS NULL),
  CHECK (status <> 'superseded' OR superseded_reason IS NOT NULL),
  CHECK (review_message_id IS NULL OR delivery_state = 'sent')
) STRICT;

CREATE UNIQUE INDEX channel_policy_reviews_active_channel_idx
  ON channel_policy_reviews(channel_id)
  WHERE status <> 'superseded';

CREATE INDEX channel_policy_reviews_pending_delivery_idx
  ON channel_policy_reviews(status, delivery_state, created_at_ms)
  WHERE status = 'pending';

CREATE INDEX channel_policy_reviews_guild_status_idx
  ON channel_policy_reviews(guild_id, status, updated_at_ms);
