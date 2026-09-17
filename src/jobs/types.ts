/**
 * Durable job types and their payload schemas (Section 10).
 *
 * The job `type` discriminates the payload. `uniqueKey` is optional and, when
 * set, collapses duplicate *active* (queued or running) jobs of the same type
 * via the partial unique index `jobs_active_unique_idx`.
 */

export type JobType =
  | 'backfill_channel'
  | 'build_historical_episodes'
  | 'archive_attachment'
  | 'purge_attachment_file'
  | 'reconcile_channel'
  | 'recover_message'
  | 'discover_threads'
  | 'close_episode'
  | 'direct_answer'
  | 'deep_recap'
  | 'forget_user'
  | 'execute_deletion'
  | 'review_episode'
  | 'review_due_memories'
  | 'review_due_memory_cohort'
  | 'send_outbox'
  | 'sync_proposal_review'
  | 'deliver_channel_policy_review'
  | 'backup_database'
  | 'rescope_memories'
  | 'maintenance';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Lower priority numbers run first (default 100); 0 is the most urgent. */
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_MAX_ATTEMPTS = 10;

export interface JobTypePayloadMap {
  backfill_channel: { channelId: string };
  build_historical_episodes: Record<string, never>;
  archive_attachment: { attachmentId: string };
  purge_attachment_file: { purgeId: string };
  reconcile_channel: { channelId: string };
  recover_message: { recoveryId: string; generation: number };
  discover_threads: { parentId?: string };
  close_episode: { episodeId: string };
  direct_answer: { messageId: string; channelId: string };
  deep_recap: { recapId: string };
  forget_user: { userId: string };
  execute_deletion: { requestId: string };
  review_episode: { episodeId: string };
  review_due_memories: { sinceMs?: number };
  review_due_memory_cohort: {
    routeKind: 'working' | 'secure_maintenance';
    targetChannelId: string;
    /** Attention cohort mode (Section 12.7). Legacy payloads without a mode are invalidated at cutover. */
    mode?: 'attention_review' | 'attention_registration';
    subjects: Array<{
      memoryId: string;
      memoryFingerprint: string;
      /** Pinned revision for attention_review cohorts. */
      attentionRevisionId?: string;
      attentionWindowFromMs?: number;
      attentionWindowUntilMs?: number;
    }>;
  };
  send_outbox: { outboxId: string };
  sync_proposal_review: { proposalId: string };
  deliver_channel_policy_review: { reviewId: string };
  backup_database: { requesterUserId?: string };
  rescope_memories: Record<string, never>;
  maintenance: Record<string, never>;
}

/** Required string fields per type, used for lightweight payload validation. */
const REQUIRED_STRING_FIELDS: Partial<Record<JobType, string[]>> = {
  backfill_channel: ['channelId'],
  archive_attachment: ['attachmentId'],
  purge_attachment_file: ['purgeId'],
  reconcile_channel: ['channelId'],
  recover_message: ['recoveryId'],
  close_episode: ['episodeId'],
  direct_answer: ['messageId', 'channelId'],
  deep_recap: ['recapId'],
  forget_user: ['userId'],
  execute_deletion: ['requestId'],
  review_episode: ['episodeId'],
  send_outbox: ['outboxId'],
  sync_proposal_review: ['proposalId'],
  deliver_channel_policy_review: ['reviewId'],
};

export interface JobRow {
  id: string;
  type: JobType;
  unique_key: string | null;
  payload_json: string;
  status: JobStatus;
  priority: number;
  run_after_ms: number;
  lease_owner: string | null;
  lease_until_ms: number | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

export interface EnqueueInput<T extends JobType> {
  type: T;
  payload: JobTypePayloadMap[T];
  /** When set, at most one active job of this type+key may exist. */
  uniqueKey?: string | null;
  /** Lower runs first. Defaults to 100. */
  priority?: number;
  /** Earliest run time (ms). Defaults to "now". */
  runAfterMs?: number;
  /** Defaults to 10. */
  maxAttempts?: number;
  now: number;
}

export interface EnqueueResult {
  id: string;
  /** False when a duplicate active unique job caused this enqueue to collapse. */
  enqueued: boolean;
}

/**
 * Validate a payload against its type's required fields. Throws on a missing or
 * non-string required field. Unknown extra fields are tolerated (forwards
 * compatibility).
 */
export function validateJobPayload<T extends JobType>(
  type: T,
  payload: JobTypePayloadMap[T],
): void {
  if (type === 'review_due_memory_cohort') {
    const value = payload as JobTypePayloadMap['review_due_memory_cohort'];
    if (value.routeKind !== 'working' && value.routeKind !== 'secure_maintenance') {
      throw new Error('job payload for review_due_memory_cohort has invalid route kind');
    }
    if (typeof value.targetChannelId !== 'string' || value.targetChannelId.trim().length === 0) {
      throw new Error('job payload for review_due_memory_cohort missing targetChannelId');
    }
    if (
      value.mode !== undefined
      && value.mode !== 'attention_review'
      && value.mode !== 'attention_registration'
    ) {
      throw new Error('job payload for review_due_memory_cohort has invalid mode');
    }
    if (!Array.isArray(value.subjects) || value.subjects.length === 0 || value.subjects.length > 20) {
      throw new Error('job payload for review_due_memory_cohort requires 1 to 20 subjects');
    }
    const ids = new Set<string>();
    for (const subject of value.subjects) {
      if (!subject || typeof subject.memoryId !== 'string' || subject.memoryId.trim().length === 0
        || typeof subject.memoryFingerprint !== 'string' || subject.memoryFingerprint.trim().length === 0) {
        throw new Error('job payload for review_due_memory_cohort has malformed subject');
      }
      // An attention_review cohort requires a pinned revision on every
      // subject; a registration cohort never carries one. A missing mode is
      // not permission for either shape.
      if (value.mode === 'attention_review') {
        if (typeof subject.attentionRevisionId !== 'string' || subject.attentionRevisionId.length === 0) {
          throw new Error('job payload for attention_review cohort missing attentionRevisionId');
        }
      } else if (value.mode === 'attention_registration') {
        if (subject.attentionRevisionId !== undefined) {
          throw new Error('job payload for attention_registration cohort must not pin a revision');
        }
      }
      if (ids.has(subject.memoryId)) {
        throw new Error('job payload for review_due_memory_cohort has duplicate subjects');
      }
      ids.add(subject.memoryId);
    }
    return;
  }
  const required = REQUIRED_STRING_FIELDS[type];
  if (!required) return;
  for (const field of required) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`job payload for ${type} missing required string field: ${field}`);
    }
  }
}
