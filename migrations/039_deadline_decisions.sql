-- Preserve the latest human deadline decision independently of proposal claims.
-- A cancellation is an ordering barrier, even before any revision was surfaced.
-- Forgetting keeps only its observation time as a conservative historical floor.
ALTER TABLE attention_subjects ADD COLUMN deadline_forget_cutoff_at_ms INTEGER;

CREATE TABLE attention_deadline_decisions (
  subject_id TEXT PRIMARY KEY REFERENCES attention_subjects(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_created_at_ms INTEGER NOT NULL,
  source_content_digest TEXT NOT NULL CHECK (length(source_content_digest) > 0),
  quote_start INTEGER NOT NULL CHECK (quote_start >= 0),
  quote_end INTEGER NOT NULL CHECK (quote_end > quote_start),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  revision_id TEXT REFERENCES attention_revisions(id) ON DELETE CASCADE,
  deadline_at_ms INTEGER,
  deadline_timezone TEXT,
  deadline_parser_version TEXT,
  deadline_basis TEXT,
  date_expression_digest TEXT,
  recorded_at_ms INTEGER NOT NULL,
  CHECK (
    (action = 'clear' AND revision_id IS NULL AND deadline_at_ms IS NULL
      AND deadline_timezone IS NULL AND deadline_parser_version IS NULL
      AND deadline_basis IS NULL AND date_expression_digest IS NULL)
    OR
    (action = 'set' AND revision_id IS NOT NULL AND deadline_at_ms IS NOT NULL
      AND deadline_timezone IS NOT NULL AND deadline_parser_version IS NOT NULL AND deadline_basis IS NOT NULL
      AND deadline_basis IN ('iso_date', 'iso_timestamp', 'day_month_year', 'relative_word', 'weekday', 'legacy'))
  )
) STRICT;

CREATE INDEX attention_deadline_decisions_source_idx
  ON attention_deadline_decisions(source_message_id);

-- An old clear did not retain the cancellation source. Retire its old revision
-- rather than allowing the original set to restore an authority we cannot prove.
UPDATE attention_revisions SET state = 'invalidated'
 WHERE explicit_deadline_at_ms IS NULL
   AND EXISTS (SELECT 1 FROM attention_revision_evidence e
                WHERE e.revision_id = attention_revisions.id AND e.role = 'explicit_deadline');
DELETE FROM attention_revision_evidence
 WHERE role = 'explicit_deadline'
   AND revision_id IN (SELECT id FROM attention_revisions WHERE explicit_deadline_at_ms IS NULL);

-- Keep existing accepted instants and timezone/parser snapshots. The old schema
-- did not save the parser basis or selected date expression; replay stays exact.
INSERT INTO attention_deadline_decisions (
  subject_id, source_message_id, source_created_at_ms, source_content_digest,
  quote_start, quote_end, action, revision_id, deadline_at_ms, deadline_timezone,
  deadline_parser_version, deadline_basis, date_expression_digest, recorded_at_ms
)
SELECT subject_id, message_id, created_at_ms, source_content_digest,
       quote_start, quote_end, 'set', revision_id, deadline_at_ms, deadline_timezone,
       deadline_parser_version, 'legacy', NULL, recorded_at_ms
  FROM (
    SELECT r.subject_id, e.message_id, m.created_at_ms, e.source_content_digest,
           e.quote_start, e.quote_end, r.id AS revision_id,
           r.explicit_deadline_at_ms AS deadline_at_ms, r.deadline_timezone,
           r.deadline_parser_version, r.created_at_ms AS recorded_at_ms,
           ROW_NUMBER() OVER (
             PARTITION BY r.subject_id ORDER BY m.created_at_ms DESC, e.message_id DESC, r.id
           ) AS position
      FROM attention_revisions r
      JOIN attention_revision_evidence e ON e.revision_id = r.id AND e.role = 'explicit_deadline'
      JOIN messages m ON m.id = e.message_id AND m.deleted_at_ms IS NULL
     WHERE r.explicit_deadline_at_ms IS NOT NULL
       AND r.deadline_timezone IS NOT NULL AND r.deadline_parser_version IS NOT NULL
       AND e.quote_end > e.quote_start
  ) WHERE position = 1;
