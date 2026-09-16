// ABOUTME: Pure proactive-attention eligibility — windows, revision identity, and
// ABOUTME: consumption decisions with no database access (Section 12.7).
import { createHash } from 'node:crypto';

/** Default proactive attention window: seven elapsed days. */
export const DEFAULT_ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum material-trigger evidence messages per revision. */
export const MAX_TRIGGER_EVIDENCE = 3;

/** Content-free reason codes recorded in policy audits and rejections. */
export type AttentionRejectionReason =
  | 'no_recent_human_trigger'
  | 'unrelated_trigger'
  | 'revision_consumed'
  | 'deadline_unverified'
  | 'attention_window_expired'
  | 'trigger_changed'
  | 'legacy_authority'
  | 'deadline_not_yet_due'
  | 'attention_authority_missing';

/** The relation a material human development has to its subject. */
export type AttentionRelation =
  | 'new_commitment'
  | 'changed_decision'
  | 'explicit_reopening'
  | 'specific_outcome'
  | 'contradiction';

export type AttentionRevisionState = 'current' | 'superseded' | 'invalidated' | 'legacy_consumed';

/** An immutable eligibility window computed from source time, never run time. */
export interface AttentionWindow {
  fromMs: number;
  untilMs: number;
}

/** Ordinary window of a human event: [event, event + window]. */
export function humanEventWindow(humanEventAtMs: number, windowMs: number): AttentionWindow {
  return { fromMs: humanEventAtMs, untilMs: humanEventAtMs + windowMs };
}

/** Deadline window: [deadlineAt, deadlineAt + window]. */
export function deadlineWindow(deadlineAtMs: number, windowMs: number): AttentionWindow {
  return { fromMs: deadlineAtMs, untilMs: deadlineAtMs + windowMs };
}

/** Inclusive window membership; the closing boundary is still inside. */
export function windowContains(window: AttentionWindow, now: number): boolean {
  return now >= window.fromMs && now <= window.untilMs;
}

/**
 * Stable revision key over the sorted, de-duplicated triggering message IDs.
 * Derived from validated human event identities only — never model prose,
 * confidence, reviewAt, or security fingerprints — so identical evidence can
 * not create a second revision of the same event.
 */
export function revisionKey(triggerMessageIds: readonly string[]): string {
  const ids = [...new Set(triggerMessageIds)].sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex');
}

/** SHA-256 digest of source content, stored instead of a copy of Discord text. */
export function sourceContentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Find an exact verbatim quote inside source content. Returns the half-open
 * character offsets of the first occurrence, or null when the quote is not
 * present verbatim. The host never accepts a paraphrase as trigger evidence.
 */
export function findQuoteOffset(
  content: string,
  quote: string,
): { start: number; end: number } | null {
  const trimmed = quote.trim();
  if (trimmed.length === 0) return null;
  const start = content.indexOf(trimmed);
  if (start === -1) return null;
  return { start, end: start + trimmed.length };
}

/**
 * Ordering key for human events: source creation time first, message ID as the
 * stable tie-break. Two events share an ordering only when both fields match.
 */
export interface HumanEventOrder {
  createdAtMs: number;
  messageId: string;
}

/** True when the candidate event is strictly newer than the frontier. */
export function isNewerThanFrontier(candidate: HumanEventOrder, frontier: HumanEventOrder | null): boolean {
  if (frontier === null) return true;
  if (candidate.createdAtMs !== frontier.createdAtMs) {
    return candidate.createdAtMs > frontier.createdAtMs;
  }
  return candidate.messageId > frontier.messageId;
}

export interface AttentionRevisionSnapshot {
  revisionId: string;
  subjectId: string;
  state: AttentionRevisionState;
  humanEventAtMs: number;
  explicitDeadlineAtMs: number | null;
}

export interface AttentionClaimSnapshot {
  revisionId: string;
  proposalId: string | null;
  consumedAtMs: number;
  eligibleFromMs: number;
  eligibleUntilMs: number;
}

export type AttentionAdmission =
  | {
      eligible: true;
      basis: 'new_human_evidence' | 'human_deadline';
      window: AttentionWindow;
    }
  | {
      eligible: false;
      reason: AttentionRejectionReason;
      window: AttentionWindow | null;
    };

/**
 * Pure admission decision for one revision. The revision must be current and
 * unconsumed, and either its ordinary human-event window or — when a verified
 * deadline exists — its deadline window must contain `now`. A claim exists for
 * a revision exactly when its one opportunity is already spent, so a claimed
 * revision is never eligible again regardless of window state.
 */
export function evaluateRevisionAdmission(
  revision: AttentionRevisionSnapshot,
  claim: AttentionClaimSnapshot | null,
  now: number,
  windowMs: number,
): AttentionAdmission {
  if (claim !== null) {
    return { eligible: false, reason: 'revision_consumed', window: null };
  }
  if (revision.state === 'legacy_consumed') {
    return { eligible: false, reason: 'legacy_authority', window: null };
  }
  if (revision.state !== 'current') {
    return { eligible: false, reason: 'trigger_changed', window: null };
  }

  const ordinary = humanEventWindow(revision.humanEventAtMs, windowMs);
  if (windowContains(ordinary, now)) {
    // A future-dated source timestamp produces fromMs > now, so it never
    // reaches this branch; it fails closed below.
    return { eligible: true, basis: 'new_human_evidence', window: ordinary };
  }
  if (revision.explicitDeadlineAtMs !== null) {
    const due = deadlineWindow(revision.explicitDeadlineAtMs, windowMs);
    if (windowContains(due, now)) {
      return { eligible: true, basis: 'human_deadline', window: due };
    }
    if (now < due.fromMs) {
      return { eligible: false, reason: 'deadline_not_yet_due', window: due };
    }
    return { eligible: false, reason: 'attention_window_expired', window: due };
  }
  if (now < ordinary.fromMs) {
    // Source time is in the future: fail closed rather than trusting it.
    return { eligible: false, reason: 'no_recent_human_trigger', window: ordinary };
  }
  return { eligible: false, reason: 'attention_window_expired', window: ordinary };
}

/**
 * The effective window end of a revision for proposal-deadline purposes: the
 * ordinary end, extended to the deadline window end when a verified deadline
 * runs later. Configuration may shorten a persisted claim's window, never
 * extend it, so the claim keeps what was computed at registration.
 */
export function effectiveWindowUntilMs(
  revision: Pick<AttentionRevisionSnapshot, 'humanEventAtMs' | 'explicitDeadlineAtMs'>,
  windowMs: number,
): number {
  const ordinaryUntil = humanEventWindow(revision.humanEventAtMs, windowMs).untilMs;
  if (revision.explicitDeadlineAtMs === null) return ordinaryUntil;
  return Math.max(ordinaryUntil, deadlineWindow(revision.explicitDeadlineAtMs, windowMs).untilMs);
}

/** Bounded material-change explanation length, mirroring the model contract. */
export const MAX_MATERIAL_CHANGE_LENGTH = 500;
