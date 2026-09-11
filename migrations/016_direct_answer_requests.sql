-- 016_direct_answer_requests: durable, content-free lifecycle for addressed
-- questions plus the global time index used by recent-activity snapshots.

CREATE TABLE IF NOT EXISTS direct_answer_requests (
  source_message_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  -- Terminal primary/partial outcomes require their run, and every delivered
  -- outcome requires its outbox intent. Retain those audit rows rather than
  -- nulling a reference into a state that violates the table invariants.
  run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT,
  outbox_id TEXT UNIQUE REFERENCES outbox(id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  target_channel_id TEXT NOT NULL,
  question_created_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms >= question_created_at_ms),
  response_intent_key TEXT NOT NULL UNIQUE,
  outcome_kind TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome_kind IN ('pending', 'primary', 'partial', 'fallback', 'suppressed')),
  reason_category TEXT NOT NULL DEFAULT 'none'
    CHECK (reason_category IN (
      'none', 'timeout', 'admission_timeout', 'deadline_exceeded', 'budget',
      'no_finalization', 'malformed', 'model_error', 'validation_rejection',
      'missing_source', 'question_deleted', 'target_invalid', 'policy_disabled',
      'duplicate', 'rate_limit'
    )),
  coverage_complete INTEGER CHECK (coverage_complete IS NULL OR coverage_complete IN (0, 1)),
  coverage_omitted INTEGER CHECK (coverage_omitted IS NULL OR coverage_omitted >= 0),
  coverage_truncation_reason TEXT CHECK (coverage_truncation_reason IS NULL OR coverage_truncation_reason IN (
    'none', 'message_cap', 'character_cap', 'message_and_character_cap'
  )),
  coverage_matched_messages INTEGER CHECK (coverage_matched_messages IS NULL OR coverage_matched_messages >= 0),
  coverage_included_messages INTEGER CHECK (coverage_included_messages IS NULL OR coverage_included_messages >= 0),
  coverage_matched_channels INTEGER CHECK (coverage_matched_channels IS NULL OR coverage_matched_channels >= 0),
  coverage_included_channels INTEGER CHECK (coverage_included_channels IS NULL OR coverage_included_channels >= 0),
  coverage_from_at_ms INTEGER CHECK (coverage_from_at_ms IS NULL OR coverage_from_at_ms >= 0),
  coverage_to_at_ms INTEGER CHECK (coverage_to_at_ms IS NULL OR coverage_to_at_ms >= 0),
  coverage_oldest_matched_at_ms INTEGER CHECK (coverage_oldest_matched_at_ms IS NULL OR coverage_oldest_matched_at_ms >= 0),
  coverage_newest_matched_at_ms INTEGER CHECK (coverage_newest_matched_at_ms IS NULL OR coverage_newest_matched_at_ms >= 0),
  coverage_oldest_included_at_ms INTEGER CHECK (coverage_oldest_included_at_ms IS NULL OR coverage_oldest_included_at_ms >= 0),
  coverage_newest_included_at_ms INTEGER CHECK (coverage_newest_included_at_ms IS NULL OR coverage_newest_included_at_ms >= 0),
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (outcome_kind = 'pending' AND completed_at_ms IS NULL)
    OR (outcome_kind <> 'pending' AND completed_at_ms IS NOT NULL)
  ),
  CHECK (
    (outcome_kind IN ('primary', 'partial', 'fallback') AND outbox_id IS NOT NULL)
    OR (outcome_kind IN ('pending', 'suppressed') AND outbox_id IS NULL)
  ),
  CHECK (
    (outcome_kind IN ('pending', 'primary', 'partial') AND reason_category = 'none')
    OR (outcome_kind IN ('fallback', 'suppressed') AND reason_category <> 'none')
  ),
  CHECK (outcome_kind NOT IN ('primary', 'partial') OR run_id IS NOT NULL),
  CHECK (outcome_kind <> 'partial' OR coverage_complete IS 0)
) STRICT;

CREATE INDEX IF NOT EXISTS direct_answer_requests_completed_idx
  ON direct_answer_requests(completed_at_ms DESC, outcome_kind)
  WHERE completed_at_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS direct_answer_requests_pending_idx
  ON direct_answer_requests(deadline_at_ms)
  WHERE outcome_kind = 'pending';

-- Org-wide recent activity filters deleted rows by time and deterministically
-- orders by (created_at_ms, id). SQLite can reverse-scan this index for ASC.
CREATE INDEX IF NOT EXISTS messages_recent_live_idx
  ON messages(created_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL;
