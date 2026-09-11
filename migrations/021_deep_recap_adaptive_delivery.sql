ALTER TABLE deep_recap_chunks
  ADD COLUMN split_depth INTEGER NOT NULL DEFAULT 0 CHECK (split_depth >= 0);

ALTER TABLE deep_recap_chunks
  ADD COLUMN truncation_reason TEXT NOT NULL DEFAULT 'none'
  CHECK (truncation_reason IN ('none','message_cap','character_cap','message_and_character_cap'));

CREATE TABLE deep_recap_delivery_parts (
  request_id TEXT NOT NULL REFERENCES deep_recap_requests(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('report','coverage','notice')),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES outbox(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (request_id, ordinal)
) STRICT;

INSERT INTO deep_recap_delivery_parts (request_id,ordinal,kind,outbox_id,created_at_ms)
SELECT id,0,
       CASE WHEN status IN ('completed','partial') THEN 'report' ELSE 'notice' END,
       outbox_id,COALESCE(completed_at_ms,updated_at_ms)
  FROM deep_recap_requests
 WHERE outbox_id IS NOT NULL;
