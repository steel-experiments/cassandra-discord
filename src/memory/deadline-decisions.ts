// ABOUTME: Source-ordered deadline decisions, including durable cancellation barriers.
// ABOUTME: Stores source IDs, offsets and digests; never copies Discord text.
import type { DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import type { DeadlineParseBasis } from './deadline-evidence.js';

interface DeadlineDecisionSource {
  subjectId: string;
  sourceMessageId: string;
  sourceCreatedAtMs: number;
  sourceContentDigest: string;
  quoteStart: number;
  quoteEnd: number;
  recordedAtMs: number;
}

export type DeadlineDecision = DeadlineDecisionSource & (
  | { action: 'clear' }
  | {
      action: 'set';
      revisionId: string;
      deadlineAtMs: number;
      timezone: string;
      parserVersion: string;
      basis: DeadlineParseBasis | 'legacy';
      expressionDigest: string | null;
    }
);

interface DeadlineDecisionRow {
  subject_id: string;
  source_message_id: string;
  source_created_at_ms: number;
  source_content_digest: string;
  quote_start: number;
  quote_end: number;
  action: 'set' | 'clear';
  revision_id: string | null;
  deadline_at_ms: number | null;
  deadline_timezone: string | null;
  deadline_parser_version: string | null;
  deadline_basis: DeadlineParseBasis | 'legacy' | null;
  date_expression_digest: string | null;
  recorded_at_ms: number;
}

/** Sources observed before explicit forgetting cannot restore forgotten authority. */
export function getDeadlineForgetCutoff(db: DatabaseSync, subjectId: string): number | null {
  const row = prepareCached(db, 'deadline_decision.forget_cutoff',
    'SELECT deadline_forget_cutoff_at_ms FROM attention_subjects WHERE id=?',
  ).get(subjectId) as { deadline_forget_cutoff_at_ms: number | null } | undefined;
  return row?.deadline_forget_cutoff_at_ms ?? null;
}

export function getDeadlineDecision(db: DatabaseSync, subjectId: string): DeadlineDecision | null {
  const row = prepareCached(db, 'deadline_decision.get',
    'SELECT * FROM attention_deadline_decisions WHERE subject_id = ?',
  ).get(subjectId) as DeadlineDecisionRow | undefined;
  if (!row) return null;
  const source: DeadlineDecisionSource = {
    subjectId: row.subject_id,
    sourceMessageId: row.source_message_id,
    sourceCreatedAtMs: row.source_created_at_ms,
    sourceContentDigest: row.source_content_digest,
    quoteStart: row.quote_start,
    quoteEnd: row.quote_end,
    recordedAtMs: row.recorded_at_ms,
  };
  if (row.action === 'clear') return { ...source, action: 'clear' };
  if (row.revision_id === null || row.deadline_at_ms === null || row.deadline_timezone === null
    || row.deadline_parser_version === null || row.deadline_basis === null) {
    throw new Error('deadline decision snapshot is incomplete');
  }
  return {
    ...source, action: 'set', revisionId: row.revision_id,
    deadlineAtMs: row.deadline_at_ms, timezone: row.deadline_timezone,
    parserVersion: row.deadline_parser_version, basis: row.deadline_basis,
    expressionDigest: row.date_expression_digest,
  };
}

/** Call inside the deadline mutation transaction. Equal/older sources never replace a decision. */
export function recordDeadlineDecision(db: DatabaseSync, decision: DeadlineDecision): boolean {
  return prepareCached(db, 'deadline_decision.record',
    `INSERT INTO attention_deadline_decisions
       (subject_id, source_message_id, source_created_at_ms, source_content_digest,
        quote_start, quote_end, action, revision_id, deadline_at_ms, deadline_timezone,
        deadline_parser_version, deadline_basis, date_expression_digest, recorded_at_ms)
     VALUES (@subjectId, @messageId, @createdAt, @digest, @quoteStart, @quoteEnd, @action,
       @revisionId, @deadlineAt, @timezone, @parserVersion, @basis, @expressionDigest, @now)
     ON CONFLICT(subject_id) DO UPDATE SET
       source_message_id=excluded.source_message_id, source_created_at_ms=excluded.source_created_at_ms,
       source_content_digest=excluded.source_content_digest, quote_start=excluded.quote_start,
       quote_end=excluded.quote_end, action=excluded.action, revision_id=excluded.revision_id,
       deadline_at_ms=excluded.deadline_at_ms, deadline_timezone=excluded.deadline_timezone,
       deadline_parser_version=excluded.deadline_parser_version, deadline_basis=excluded.deadline_basis,
       date_expression_digest=excluded.date_expression_digest, recorded_at_ms=excluded.recorded_at_ms
     WHERE excluded.source_created_at_ms > attention_deadline_decisions.source_created_at_ms
        OR (excluded.source_created_at_ms = attention_deadline_decisions.source_created_at_ms
          AND excluded.source_message_id > attention_deadline_decisions.source_message_id)`,
  ).run({
    subjectId: decision.subjectId, messageId: decision.sourceMessageId,
    createdAt: decision.sourceCreatedAtMs, digest: decision.sourceContentDigest,
    quoteStart: decision.quoteStart, quoteEnd: decision.quoteEnd, action: decision.action,
    revisionId: decision.action === 'set' ? decision.revisionId : null,
    deadlineAt: decision.action === 'set' ? decision.deadlineAtMs : null,
    timezone: decision.action === 'set' ? decision.timezone : null,
    parserVersion: decision.action === 'set' ? decision.parserVersion : null,
    basis: decision.action === 'set' ? decision.basis : null,
    expressionDigest: decision.action === 'set' ? decision.expressionDigest : null,
    now: decision.recordedAtMs,
  }).changes > 0;
}

/** New human authority retires old deadlines even when an old proposal already owns a claim. */
export function retireSubjectDeadlines(db: DatabaseSync, subjectId: string, exceptRevisionId: string | null): void {
  prepareCached(db, 'deadline_decision.retire_authority',
    `UPDATE attention_revisions
        SET state=CASE WHEN state='current' THEN 'superseded' ELSE state END,
            explicit_deadline_at_ms=NULL, deadline_timezone=NULL, deadline_parser_version=NULL
      WHERE subject_id=? AND (? IS NULL OR id<>?) AND explicit_deadline_at_ms IS NOT NULL`,
  ).run(subjectId, exceptRevisionId, exceptRevisionId);
  prepareCached(db, 'deadline_decision.retire_evidence',
    `DELETE FROM attention_revision_evidence WHERE role='explicit_deadline'
       AND revision_id IN (SELECT id FROM attention_revisions
         WHERE subject_id=?)`,
  ).run(subjectId);
}

/** Forgetting a cancellation must not restore any older revision of its subject. */
export function purgeDeadlineDecisionForMessage(db: DatabaseSync, messageId: string, now: number): void {
  // This is deletion observation time, not retained source identity/content.
  // It also blocks historical sets that had never acquired a revision.
  prepareCached(db, 'deadline_decision.purge_cutoff',
    `UPDATE attention_subjects SET deadline_forget_cutoff_at_ms=MAX(COALESCE(deadline_forget_cutoff_at_ms, ?), ?)
      WHERE id IN (SELECT subject_id FROM attention_deadline_decisions WHERE source_message_id=?)`,
  ).run(now, now, messageId);
  prepareCached(db, 'deadline_decision.purge_revisions',
    `UPDATE attention_revisions SET state='invalidated', explicit_deadline_at_ms=NULL,
       deadline_timezone=NULL, deadline_parser_version=NULL
      WHERE subject_id IN (SELECT subject_id FROM attention_deadline_decisions WHERE source_message_id=?)`,
  ).run(messageId);
  prepareCached(db, 'deadline_decision.purge_deadline_evidence',
    `DELETE FROM attention_revision_evidence WHERE role='explicit_deadline' AND revision_id IN (
      SELECT r.id FROM attention_revisions r JOIN attention_deadline_decisions d ON d.subject_id=r.subject_id
      WHERE d.source_message_id=?)`,
  ).run(messageId);
  prepareCached(db, 'deadline_decision.purge_source',
    'DELETE FROM attention_deadline_decisions WHERE source_message_id=?',
  ).run(messageId);
}
