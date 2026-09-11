import type { DatabaseSync } from '../../db/database.js';
import { getChannel } from '../../db/repositories/channels.js';
import { fingerprintExposedMemory } from '../../agent/run-context.js';
import type { DueMemoryCandidate } from '../../memory/due.js';
import { getMemory } from '../../memory/repository.js';
import { recomputeMemoryScopes } from '../../memory/search.js';
import {
  resolveScheduledMemoryRoute,
  resolveScheduledSubjectRoute,
  type ScheduledRouteOptions,
} from '../../memory/scheduled-routing.js';
import type { ScheduledSubjectSnapshot } from '../../memory/scheduled-notifications.js';
import type { JobHandler } from '../worker.js';
import type { JobRow, JobTypePayloadMap } from '../types.js';
import {
  createReviewDueMemoriesHandler,
  type ReviewDueMemoriesHandlerDeps,
  type ReviewScope,
  type ScheduledReviewOutcome,
} from './review-due-memories.js';

export interface ReviewDueMemoryCohortDeps extends ScheduledRouteOptions {
  db: DatabaseSync;
  base: Omit<ReviewDueMemoriesHandlerDeps, 'db' | 'guildId' | 'resolveReviewScope'
    | 'selectDue' | 'validateSnapshot' | 'validateNotificationSubjects' | 'sessionId'>;
  resolveWorkingScope: (targetChannelId: string) => ReviewScope;
  resolveSecureScope: () => ReviewScope;
  currentRouteOptions?: () => ScheduledRouteOptions;
  onPendingProposal?: (outcome: Extract<ScheduledReviewOutcome, { kind: 'reviewed' }>) => Promise<void>;
}

function currentCandidates(
  db: DatabaseSync,
  subjects: readonly ScheduledSubjectSnapshot[],
  now: number,
): DueMemoryCandidate[] {
  const scopes = recomputeMemoryScopes(db, subjects.map((subject) => subject.memoryId));
  const countEvidence = db.prepare('SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id = ?');
  const out: DueMemoryCandidate[] = [];
  for (const subject of subjects) {
    const memory = getMemory(db, subject.memoryId);
    if (!memory || memory.status !== 'active' || memory.review_after_ms === null || memory.review_after_ms > now) continue;
    const scope = scopes.get(memory.id);
    const count = countEvidence.get(memory.id) as { count: number } | undefined;
    out.push({
      memoryId: memory.id,
      type: memory.type,
      statement: memory.statement,
      status: memory.status,
      confidence: memory.confidence,
      importance: memory.importance,
      reviewAfterMs: memory.review_after_ms,
      lastConfirmedAtMs: memory.last_confirmed_at_ms,
      evidenceCount: Number(count?.count ?? 0),
      scopeType: scope?.scopeType ?? 'review_only',
      scopeKey: scope?.scopeKey ?? null,
    });
  }
  return out;
}

/** Run exactly one target-scoped scheduled cohort and release its durable ownership on success. */
export function createReviewDueMemoryCohortHandler(
  deps: ReviewDueMemoryCohortDeps,
): JobHandler<'review_due_memory_cohort'> {
  return async (payload: JobTypePayloadMap['review_due_memory_cohort'], job: JobRow) => {
    const routeOptions = (): ScheduledRouteOptions => deps.currentRouteOptions?.() ?? deps;
    const subjectIsCurrent = (subject: ScheduledSubjectSnapshot): boolean => {
      const memory = getMemory(deps.db, subject.memoryId);
      if (!memory || memory.status !== 'active' || memory.review_after_ms === null) return false;
      if (fingerprintExposedMemory(deps.db, subject.memoryId) !== subject.memoryFingerprint) return false;
      const route = resolveScheduledMemoryRoute(deps.db, subject.memoryId, routeOptions());
      return route.kind === payload.routeKind && route.targetChannelId === payload.targetChannelId;
    };
    // A stale member has not influenced the model yet, so it may be dropped at
    // this boundary. After exposure the guard below is deliberately all-or-none.
    const snapshots = payload.subjects.filter(subjectIsCurrent);
    const snapshotValid = (): boolean => snapshots.every(subjectIsCurrent);
    if (snapshots.length === 0) {
      deps.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?').run(job.id);
      return;
    }
    if (!snapshotValid()) {
      deps.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?').run(job.id);
      return;
    }

    const resolvedScope = payload.routeKind === 'working'
      ? deps.resolveWorkingScope(payload.targetChannelId)
      : deps.resolveSecureScope();
    const target = getChannel(deps.db, payload.targetChannelId);
    if (!target || resolvedScope.targetChannelId !== payload.targetChannelId) {
      deps.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?').run(job.id);
      return;
    }

    const runner = createReviewDueMemoriesHandler({
      ...deps.base,
      db: deps.db,
      guildId: deps.guildId,
      resolveReviewScope: () => resolvedScope,
      selectDue: (now) => currentCandidates(deps.db, snapshots, now),
      validateSnapshot: snapshotValid,
      validateNotificationSubjects: (subjects) => {
        if (payload.routeKind !== 'working' || subjects.length === 0) return false;
        const route = resolveScheduledSubjectRoute(
          deps.db,
          subjects.map((subject) => subject.memoryId),
          routeOptions(),
        );
        return route?.kind === 'working' && route.targetChannelId === payload.targetChannelId;
      },
      sessionId: `cassandra:scheduled-review:${job.id}`,
    });
    const outcome = await runner.runScheduledReview();
    if (outcome.kind === 'reviewed' && outcome.notification.routing.state === 'pending_review') {
      await deps.onPendingProposal?.(outcome);
    }
    deps.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?').run(job.id);
  };
}
