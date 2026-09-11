-- 027_scheduled_review_subjects: give scheduled notifications a durable subject.
--
-- Text similarity cannot identify two paraphrased reminders reliably. The topic
-- key supports the shared cooldown path, while the normalized subject table
-- supports overlap checks and records the exact memory state reviewed.

ALTER TABLE proposals ADD COLUMN topic_key TEXT;

CREATE INDEX IF NOT EXISTS proposals_topic_created_idx
  ON proposals(topic_key, created_at_ms DESC)
  WHERE topic_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_proposal_subjects (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  memory_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, memory_id)
) STRICT;

CREATE INDEX IF NOT EXISTS scheduled_proposal_subjects_memory_idx
  ON scheduled_proposal_subjects(memory_id, created_at_ms DESC, proposal_id);
