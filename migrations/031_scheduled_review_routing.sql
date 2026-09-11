-- 031_scheduled_review_routing: durable fair dispatch, cohort ownership, and
-- exact reverse lookup for replies to sent scheduled notifications.

CREATE TABLE scheduled_review_dispatch_state (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  memory_fingerprint TEXT NOT NULL CHECK (length(memory_fingerprint) > 0),
  last_target_channel_id TEXT REFERENCES channels(id),
  last_route_kind TEXT NOT NULL
    CHECK (last_route_kind IN ('working', 'secure_maintenance', 'suppress')),
  last_considered_at_ms INTEGER NOT NULL,
  last_dispatched_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (last_route_kind = 'suppress' AND last_target_channel_id IS NULL)
    OR (last_route_kind <> 'suppress' AND last_target_channel_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX scheduled_review_dispatch_state_considered_idx
  ON scheduled_review_dispatch_state(last_considered_at_ms, memory_id);

CREATE TABLE scheduled_review_cohort_subject_leases (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  memory_fingerprint TEXT NOT NULL CHECK (length(memory_fingerprint) > 0),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX scheduled_review_cohort_subject_leases_job_idx
  ON scheduled_review_cohort_subject_leases(job_id);

CREATE INDEX outbox_discord_message_idx
  ON outbox(discord_message_id)
  WHERE discord_message_id IS NOT NULL;
