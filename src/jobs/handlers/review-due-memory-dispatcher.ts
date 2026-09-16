// ABOUTME: Host-only daily dispatcher for proactive attention cohorts: eligible
// ABOUTME: unconsumed revisions for review, uncovered work for scoped registration.
import { createHash } from 'node:crypto';
import { transactionImmediate, type DatabaseSync } from '../../db/database.js';
import { fingerprintExposedMemory } from '../../agent/run-context.js';
import {
  ensureSubjectForMember,
  selectEligibleRevisions,
  selectRegistrationCandidates,
} from '../../memory/attention-repository.js';
import { DEFAULT_ATTENTION_WINDOW_MS } from '../../memory/attention.js';
import {
  resolveScheduledMemoryRoute,
  type ScheduledMemoryRoute,
  type ScheduledRouteOptions,
} from '../../memory/scheduled-routing.js';
import { enqueue } from '../queue.js';
import type { JobHandler } from '../worker.js';
import type { JobTypePayloadMap } from '../types.js';
import type { Logger } from '../../logger.js';

export const SCHEDULED_DISPATCH_SCAN_LIMIT = 50;
// One subject per cohort: every proposal covers exactly one memory, so the
// approval card and the delivered message stay single-topic (Section 12.4).
export const SCHEDULED_COHORT_SUBJECT_LIMIT = 1;
export const SCHEDULED_DISPATCH_JOB_LIMIT = 8;

export interface ScheduledDispatchReport {
  considered: number;
  enqueued: number;
  suppressed: number;
  registrationCandidates: number;
  registrationEnqueued: number;
}

export interface ReviewDueMemoryDispatcherDeps extends ScheduledRouteOptions {
  db: DatabaseSync;
  now?: () => number;
  logger?: Pick<Logger, 'info' | 'warn'>;
  /** Proactive attention window in milliseconds (Section 12.7; default seven days). */
  attentionWindowMs?: number;
}

interface RoutedSubject {
  memoryId: string;
  memoryFingerprint: string;
  route: ScheduledMemoryRoute;
  ordinal: number;
  attentionRevisionId?: string;
  attentionWindowFromMs?: number;
  attentionWindowUntilMs?: number;
}

function cohortKey(payload: JobTypePayloadMap['review_due_memory_cohort']): string {
  const subjects = [...payload.subjects]
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId))
    .map((subject) => `${subject.memoryId}:${subject.memoryFingerprint}:${subject.attentionRevisionId ?? ''}`);
  return `scheduled-cohort:${createHash('sha256')
    .update(JSON.stringify([payload.routeKind, payload.targetChannelId, payload.mode ?? '', subjects]))
    .digest('hex')}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Host-only daily dispatcher. It performs no model or Discord I/O. Selection is
 * driven by eligible, unconsumed attention revisions (Section 12.7),
 * independent of `review_after_ms`: a memory need not have a model review date
 * to have a new relevant human event, and no eligible revision means no
 * notification cohort. Registration cohorts carry uncovered recent work and
 * never post.
 */
export function createReviewDueMemoryDispatcherHandler(
  deps: ReviewDueMemoryDispatcherDeps,
): JobHandler<'review_due_memories'> & { dispatch(): ScheduledDispatchReport } {
  const dispatch = (): ScheduledDispatchReport => {
    const now = deps.now?.() ?? Date.now();
    const windowMs = deps.attentionWindowMs ?? DEFAULT_ATTENTION_WINDOW_MS;
    const rejectedMemoryIds = new Set<string>();
    const candidates = selectEligibleRevisions(deps.db, {
      now,
      windowMs,
      limit: SCHEDULED_DISPATCH_SCAN_LIMIT,
      onRejected: (memoryId) => { rejectedMemoryIds.add(memoryId); },
    });
    const routed: RoutedSubject[] = [];
    for (const [ordinal, candidate] of candidates.entries()) {
      const memoryFingerprint = fingerprintExposedMemory(deps.db, candidate.memoryId);
      if (!memoryFingerprint) continue;
      routed.push({
        memoryId: candidate.memoryId,
        memoryFingerprint,
        route: resolveScheduledMemoryRoute(deps.db, candidate.memoryId, deps),
        ordinal,
        attentionRevisionId: candidate.revisionId,
        attentionWindowFromMs: candidate.windowFromMs,
        attentionWindowUntilMs: candidate.windowUntilMs,
      });
    }

    const grouped = new Map<string, RoutedSubject[]>();
    for (const subject of routed) {
      if (subject.route.kind === 'suppress') continue;
      const key = `${subject.route.kind}:${subject.route.targetChannelId}`;
      const group = grouped.get(key) ?? [];
      group.push(subject);
      grouped.set(key, group);
    }
    const cohortGroups = [...grouped.values()]
      .flatMap((group) => chunks(group, SCHEDULED_COHORT_SUBJECT_LIMIT))
      .sort((a, b) => (a[0]?.ordinal ?? 0) - (b[0]?.ordinal ?? 0));

    // Registration candidates: uncovered in-window human evidence on memories
    // that have no revision yet, or whose subject still awaits its initial
    // registration pass. A candidate date in source text is detected by the
    // scoped registration run itself, never here.
    const registrationCandidates = selectRegistrationCandidates(deps.db, {
      guildId: deps.guildId,
      now,
      windowMs,
      limit: SCHEDULED_DISPATCH_SCAN_LIMIT,
    });
    const registrationRouted: RoutedSubject[] = [];
    for (const [ordinal, candidate] of registrationCandidates.entries()) {
      const memoryFingerprint = fingerprintExposedMemory(deps.db, candidate.memoryId);
      if (!memoryFingerprint) continue;
      const route = resolveScheduledMemoryRoute(deps.db, candidate.memoryId, deps);
      if (route.kind === 'suppress') continue;
      registrationRouted.push({
        memoryId: candidate.memoryId,
        memoryFingerprint,
        route,
        ordinal,
      });
    }

    let enqueuedCount = 0;
    let registrationEnqueuedCount = 0;
    const dispatchedMemoryIds = new Set<string>();
    transactionImmediate(deps.db, () => {
      deps.db.prepare(
        `DELETE FROM scheduled_review_cohort_subject_leases
          WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = scheduled_review_cohort_subject_leases.job_id)
             OR job_id IN (SELECT id FROM jobs WHERE status IN ('succeeded', 'failed', 'cancelled'))`,
      ).run();

      for (const cohort of cohortGroups) {
        if (enqueuedCount >= SCHEDULED_DISPATCH_JOB_LIMIT) break;
        const first = cohort[0];
        if (!first || first.route.kind === 'suppress') continue;
        const payload: JobTypePayloadMap['review_due_memory_cohort'] = {
          routeKind: first.route.kind,
          targetChannelId: first.route.targetChannelId,
          mode: 'attention_review',
          subjects: cohort.map(({ memoryId, memoryFingerprint, attentionRevisionId,
            attentionWindowFromMs, attentionWindowUntilMs }) => ({
            memoryId,
            memoryFingerprint,
            attentionRevisionId,
            attentionWindowFromMs,
            attentionWindowUntilMs,
          })),
        };
        const queued = enqueue(deps.db, {
          type: 'review_due_memory_cohort',
          payload,
          uniqueKey: cohortKey(payload),
          now,
        });
        if (!queued.enqueued) continue;
        const insertLease = deps.db.prepare(
          `INSERT INTO scheduled_review_cohort_subject_leases
             (memory_id, job_id, memory_fingerprint, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        );
        for (const subject of cohort) {
          insertLease.run(subject.memoryId, queued.id, subject.memoryFingerprint, now);
          dispatchedMemoryIds.add(subject.memoryId);
        }
        enqueuedCount += 1;
      }

      for (const cohort of chunks(registrationRouted, SCHEDULED_COHORT_SUBJECT_LIMIT)) {
        if (enqueuedCount + registrationEnqueuedCount >= SCHEDULED_DISPATCH_JOB_LIMIT) break;
        const first = cohort[0];
        if (!first || first.route.kind === 'suppress') continue;
        // One memory can legitimately appear in both scans — an eligible
        // revision plus other uncovered in-window evidence. The lease's
        // primary key admits one owner per memory, so the attention_review
        // cohort wins and the registration pass waits for a later tick.
        if (dispatchedMemoryIds.has(first.memoryId)) continue;
        // The subject identity is host-assigned; the registration run validates
        // the actual commitment through the typed contract and never posts.
        ensureSubjectForMember(deps.db, { guildId: deps.guildId, memoryId: first.memoryId, now });
        const payload: JobTypePayloadMap['review_due_memory_cohort'] = {
          routeKind: first.route.kind,
          targetChannelId: first.route.targetChannelId,
          mode: 'attention_registration',
          subjects: cohort.map(({ memoryId, memoryFingerprint }) => ({ memoryId, memoryFingerprint })),
        };
        const queued = enqueue(deps.db, {
          type: 'review_due_memory_cohort',
          payload,
          uniqueKey: cohortKey(payload),
          now,
        });
        if (!queued.enqueued) continue;
        const insertLease = deps.db.prepare(
          `INSERT INTO scheduled_review_cohort_subject_leases
             (memory_id, job_id, memory_fingerprint, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        );
        for (const subject of cohort) {
          insertLease.run(subject.memoryId, queued.id, subject.memoryFingerprint, now);
          dispatchedMemoryIds.add(subject.memoryId);
        }
        registrationEnqueuedCount += 1;
      }

      const upsert = deps.db.prepare(
        `INSERT INTO scheduled_review_dispatch_state
           (memory_id, memory_fingerprint, last_target_channel_id, last_route_kind,
            last_considered_at_ms, last_dispatched_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           memory_fingerprint = excluded.memory_fingerprint,
           last_target_channel_id = excluded.last_target_channel_id,
           last_route_kind = excluded.last_route_kind,
           last_considered_at_ms = excluded.last_considered_at_ms,
           last_dispatched_at_ms = COALESCE(excluded.last_dispatched_at_ms,
                                            scheduled_review_dispatch_state.last_dispatched_at_ms),
           updated_at_ms = excluded.updated_at_ms`,
      );
      for (const subject of routed) {
        upsert.run(
          subject.memoryId,
          subject.memoryFingerprint,
          subject.route.targetChannelId,
          subject.route.kind,
          now,
          dispatchedMemoryIds.has(subject.memoryId) ? now : null,
          now,
        );
      }
      // Invalid source versions and events consumed by another subject still
      // used a scan slot. Advance them so they cannot fill the first page on
      // every tick and starve later current work.
      for (const memoryId of rejectedMemoryIds) {
        if (routed.some((subject) => subject.memoryId === memoryId)) continue;
        const fingerprint = fingerprintExposedMemory(deps.db, memoryId);
        if (!fingerprint) continue;
        upsert.run(memoryId, fingerprint, null, 'suppress', now, null, now);
      }
    });

    const report = {
      considered: routed.length + rejectedMemoryIds.size,
      enqueued: enqueuedCount,
      suppressed: routed.filter((subject) => subject.route.kind === 'suppress').length + rejectedMemoryIds.size,
      registrationCandidates: registrationRouted.length,
      registrationEnqueued: registrationEnqueuedCount,
    };
    deps.logger?.info({ event: 'scheduled_review.dispatched', ...report }, 'scheduled review dispatch completed');
    return report;
  };
  const handler: JobHandler<'review_due_memories'> = async () => { dispatch(); };
  return Object.assign(handler, { dispatch });
}
