-- Content-free requests and fixed message manifests. No recoverable content copies.
CREATE TABLE deletion_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'message')),
  target_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  approver_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'scheduled', 'executing', 'completed', 'cancelled')),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count BETWEEN 0 AND message_count),
  created_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER,
  execute_after_ms INTEGER,
  completed_at_ms INTEGER,
  job_id TEXT,
  CHECK (approver_user_id IS NULL OR approver_user_id <> requester_user_id),
  CHECK (status NOT IN ('scheduled', 'executing', 'completed') OR
    (approver_user_id IS NOT NULL AND approved_at_ms IS NOT NULL
      AND execute_after_ms >= approved_at_ms + 86400000))
) STRICT;

CREATE UNIQUE INDEX deletion_requests_active_target_idx
  ON deletion_requests(guild_id, target_kind, target_id)
  WHERE status IN ('pending', 'scheduled', 'executing');
CREATE INDEX deletion_requests_recent_idx ON deletion_requests(guild_id, created_at_ms DESC, id);

CREATE INDEX deletion_requests_job_idx ON deletion_requests(job_id);

CREATE TABLE deletion_request_messages (
  request_id TEXT NOT NULL REFERENCES deletion_requests(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (request_id, message_id)
) STRICT;

-- Old jobs carry neither a request nor approval. Never grandfather them in.
INSERT INTO admin_events (id, guild_id, actor_user_id, action, target, details_json, created_at_ms)
SELECT lower(hex(randomblob(16))), g.id, 'system', 'deletion_legacy_job_cancelled', j.id,
       '{"reason":"independent approval required"}', CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM jobs j CROSS JOIN guilds g
WHERE j.type = 'forget_user' AND j.status IN ('queued', 'running');
UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_until_ms = NULL,
  completed_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  last_error = 'Legacy deletion cancelled: create a deletion request with independent approval'
WHERE type = 'forget_user' AND status IN ('queued', 'running');
