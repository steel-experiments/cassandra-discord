-- 007_outbox_repair: retain complete send identity and a recovery marker.

ALTER TABLE proposals ADD COLUMN reply_to_message_id TEXT;
ALTER TABLE outbox ADD COLUMN dedupe_marker TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_marker_idx
  ON outbox(dedupe_marker) WHERE dedupe_marker IS NOT NULL;
