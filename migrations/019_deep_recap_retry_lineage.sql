ALTER TABLE deep_recap_requests
  ADD COLUMN retry_of_request_id TEXT
    REFERENCES deep_recap_requests(id) ON DELETE RESTRICT;

ALTER TABLE deep_recap_requests
  ADD COLUMN retry_root_request_id TEXT
    REFERENCES deep_recap_requests(id) ON DELETE RESTRICT;

-- Requests created before synthesis retry existed are lineage roots.
UPDATE deep_recap_requests
   SET retry_root_request_id=id
 WHERE retry_root_request_id IS NULL;

CREATE INDEX deep_recap_retry_parent_idx
  ON deep_recap_requests(retry_of_request_id);

CREATE UNIQUE INDEX deep_recap_retry_one_child_idx
  ON deep_recap_requests(retry_of_request_id)
  WHERE retry_of_request_id IS NOT NULL;

CREATE INDEX deep_recap_retry_root_idx
  ON deep_recap_requests(retry_root_request_id, created_at_ms);
