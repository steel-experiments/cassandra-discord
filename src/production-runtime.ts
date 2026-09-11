import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { RetrievalGrant } from './db/repositories/message-search.js';
import {
  getChannel,
  resolveCurrentChannelScope,
  resolveRetrievableChannelScope,
  type VisibilityClass,
} from './db/repositories/channels.js';
import { getMessage } from './db/repositories/messages.js';
import { getMemory } from './memory/repository.js';
import { recomputeMemoryScopes } from './memory/search.js';
import {
  DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
  getScheduledProposalSubjects,
} from './memory/scheduled-notifications.js';
import {
  renderScheduledNotificationDelivery,
  validateScheduledProposalDelivery,
  type ScheduledDeliveryCheck,
} from './memory/scheduled-delivery.js';
import type { ScheduledRouteOptions } from './memory/scheduled-routing.js';
import { enqueue } from './jobs/queue.js';
import { createJobWorker } from './jobs/handlers/index.js';
import { createBackfillChannelHandler } from './jobs/handlers/backfill-channel.js';
import { createBuildHistoricalEpisodesHandler } from './jobs/handlers/build-historical-episodes.js';
import { createReconcileChannelHandler } from './jobs/handlers/reconcile-channel.js';
import { createRecoverMessageHandler } from './jobs/handlers/recover-message.js';
import { createIngestionObserver } from './observability.js';
import { createCloseEpisodeHandler } from './jobs/handlers/close-episode.js';
import { createDirectAnswerHandler } from './jobs/handlers/direct-answer.js';
import { createDeepRecapHandler } from './jobs/handlers/deep-recap.js';
import { createReviewEpisodeHandler } from './jobs/handlers/review-episode.js';
import {
  type ReviewScope,
} from './jobs/handlers/review-due-memories.js';
import { createReviewDueMemoryDispatcherHandler } from './jobs/handlers/review-due-memory-dispatcher.js';
import { createReviewDueMemoryCohortHandler } from './jobs/handlers/review-due-memory-cohort.js';
import { createSendOutboxHandler } from './outbox/worker.js';
import {
  createProposalDeliverySyncHandler,
  type ProposalDeliveryReport,
} from './outbox/proposal-delivery.js';
import { createBackupDatabaseHandler } from './jobs/handlers/backup-database.js';
import { createDatabaseMaintenanceHandler } from './jobs/handlers/maintenance.js';
import { createExpireProposalsHandler } from './jobs/handlers/expire-proposals.js';
import { createRescopeMemoriesHandler } from './jobs/handlers/rescope-memories.js';
import { expireStaleMemories, type ExpireStaleMemoriesResult } from './memory/maintenance.js';
import { createForgetUserHandler } from './jobs/handlers/forget-user.js';
import { createArchiveAttachmentHandler } from './jobs/handlers/archive-attachment.js';
import { createPurgeAttachmentFileHandler } from './jobs/handlers/purge-attachment-file.js';
import { createDiscordSender } from './discord/sender.js';
import { createDiscordMessageFetcher, fetchDiscoveryDescriptors, createDiscordThreadArchiveSource } from './discord/production-adapters.js';
import { runStartupSync } from './discord/sync.js';
import { isCassandraTestSurface } from './discord/test-channels.js';
import { PeriodicScheduler, buildSchedules, nodeTimerDriver } from './jobs/scheduler.js';
import { isPaused } from './runtime-state.js';
import { defaultModelLookup, resolveAgentModels } from './agent/model.js';
import { evaluateCooldowns, DEFAULT_COOLDOWN_CONFIG } from './agent/cooldowns.js';
import { detectDuplicate } from './agent/duplicate-policy.js';
import { reconcileOutboxSending, createDiscordRecentSentLookup } from './outbox/recovery.js';
import { enqueueOutbox } from './outbox/repository.js';
import {
  insertProposal,
  getProposal,
  setProposalStatus,
  type ProposalRow,
} from './db/repositories/proposals.js';
import { sanitizeOutboundMessage, sourceLinkUrl, stripScheduledFooter } from './discord/message-safety.js';
import {
  evaluateForcedReview,
  evaluateProvenanceGate,
  resolveProvenanceScopes,
  routeProposal,
  validateOutboundEvidence,
  type ProvenanceGateResult,
  type ProvenanceScopeEntry,
} from './agent/policy.js';
import { createDiscordReviewChannel, deliverProposalReview, type ReviewProposalInput } from './discord/review-message.js';
import { createReviewButtonHandler, createDiscordReviewResolver } from './discord/interactions.js';
import {
  createDeliverChannelPolicyReviewHandler,
  createDiscordChannelPolicyReviewPort,
} from './discord/channel-policy-review-message.js';
import { createChannelPolicyReviewButtonHandler } from './discord/channel-policy-review-interactions.js';
import { registerCommandDispatcher } from './discord/command-dispatcher.js';
import { Events, type Interaction } from 'discord.js';
import { recheckApprovalPolicy, type ApprovalPolicyRecheck } from './review/workflow.js';
import { ModelBudgetGate, OrgDayBudget, classifyModelError } from './agent/budget.js';
import { orgDayStartMs } from './agent/cooldowns.js';
import { executeAgentRun, type AgentRunResult, type ExecuteAgentRunDeps } from './agent/runtime.js';
import { buildEpisodePolicyDecision } from './agent/policy-audit.js';
import { configuredRunLimits, deadlineBoundWallClockMs } from './agent/run-limits.js';
import {
  directAnswerAdmissionWaitMs,
  DIRECT_ANSWER_MODEL_SLOT_WAIT_MS,
  ModelAdmissionController,
  ModelAdmissionTimeoutError,
} from './agent/model-admission.js';
import { loadDocsIndex } from './agent/docs-index.js';
import { DeferJobError, PermanentJobError, TransientJobError } from './jobs/errors.js';
import type { BootstrapContext, DiscordWiring, JobRuntimeWiring } from './bootstrap.js';
import { transaction, type DatabaseSync } from './db/database.js';
import {
  repairDeepRecapOwnership,
  repairDurableWork,
  type DeepRecapOwnershipRepairReport,
} from './jobs/startup-repair.js';
import {
  ensureHistoricalCampaign,
  getHistoricalCampaign,
  historicalCampaignSpend,
  setHistoricalCampaignStatus,
  wakeHistoricalCampaignReviews,
} from './historical/campaign.js';

export { DIRECT_ANSWER_MODEL_SLOT_WAIT_MS } from './agent/model-admission.js';

/** Short allowance for prompt setup and durable outcome bookkeeping around a model call. */
export const JOB_LEASE_COMPLETION_MARGIN_MS = 5_000;

/**
 * Size production job leases for the longest interactive path while preserving
 * the established two-times-model-timeout recovery cushion for every job type.
 */
export function productionJobLeaseMs(agentTimeoutSeconds: number): number {
  const modelWallClockMs = agentTimeoutSeconds * 1_000;
  return Math.max(
    60_000,
    modelWallClockMs * 2,
    DIRECT_ANSWER_MODEL_SLOT_WAIT_MS
      + modelWallClockMs
      + JOB_LEASE_COMPLETION_MARGIN_MS,
  );
}

/** Current channels eligible for periodic reconciliation. */
export function scheduledIngestionChannelIds(db: DatabaseSync): string[] {
  return (db.prepare(
    'SELECT id FROM channels WHERE ingest_enabled = 1 AND deleted_at_ms IS NULL',
  ).all() as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((channelId) => !isCassandraTestSurface(db, channelId));
}

/**
 * When a periodic schedule last ran, read from durable job history: the newest
 * job created under the schedule's unique key (`exact`), or under any key with
 * the given prefix (`prefix`, for per-channel fan-out). Null when no such job
 * exists — including when retention has pruned it, in which case the schedule
 * waits one full interval like a fresh install. Read once per schedule at boot.
 */
export function lastScheduledRunMs(db: DatabaseSync, key: string, match: 'exact' | 'prefix'): number | null {
  const row = (match === 'exact'
    ? db.prepare('SELECT MAX(created_at_ms) AS m FROM jobs WHERE unique_key = ?').get(key)
    : db.prepare('SELECT MAX(created_at_ms) AS m FROM jobs WHERE unique_key >= ? AND unique_key < ?')
      .get(key, `${key}\uffff`)) as { m: number | bigint | null } | undefined;
  return row?.m === null || row?.m === undefined ? null : Number(row.m);
}

export interface PeriodicMaintenanceCycleDeps {
  expireProposals: () => Promise<unknown>;
  /** Staleness-horizon sweep for long-overdue memories (Section 12.4). */
  expireStaleMemories: () => ExpireStaleMemoriesResult;
  maintainDatabase: () => Promise<unknown>;
  repairDeepRecaps: () => DeepRecapOwnershipRepairReport;
  logger: Pick<BootstrapContext['logger'], 'info'>
    & Partial<Pick<BootstrapContext['logger'], 'warn'>>;
}

/** Run periodic maintenance and reconcile ownerless deep recaps afterward. */
export async function runPeriodicMaintenanceCycle(
  deps: PeriodicMaintenanceCycleDeps,
): Promise<DeepRecapOwnershipRepairReport> {
  await deps.expireProposals();
  const staleSweep = deps.expireStaleMemories();
  if (staleSweep.expiredIds.length > 0) {
    deps.logger.info(
      { event: 'memories.staleness_expired', count: staleSweep.expiredIds.length, ids: staleSweep.expiredIds },
      'expired memories past the staleness horizon',
    );
  }
  await deps.maintainDatabase();
  const repair = deps.repairDeepRecaps();
  deps.logger.info(
    {
      event: 'jobs.deep_recap_ownership_repair',
      jobsEnqueued: repair.jobsEnqueued,
      chunksReset: repair.chunksReset,
      duplicateJobsCancelled: repair.duplicateJobsCancelled,
      runningJobsRecovered: repair.runningJobsRecovered,
    },
    'periodic deep recap ownership reconciliation completed',
  );
  if (repair.duplicateJobsCancelled > 0) {
    deps.logger.warn?.(
      {
        event: 'jobs.deep_recap_duplicate_owners_repaired',
        duplicateJobsCancelled: repair.duplicateJobsCancelled,
      },
      'duplicate deep recap owners were reconciled',
    );
  }
  return repair;
}

function safeRead(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

export function grantForTargetChannel(channel: {
  id: string;
  parent_id: string | null;
  visibility_class: string;
  deleted_at_ms: number | null;
} | undefined): RetrievalGrant {
  if (!channel || channel.deleted_at_ms !== null) {
    return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
  }
  if (channel.visibility_class === 'org') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  if (channel.visibility_class === 'restricted') {
    return { includeOrgMessages: false, includeOrgMemories: true, includeReviewOnly: false, channelIds: [channel.parent_id ?? channel.id] };
  }
  // `review_only` is readable only through the separately verified, exact
  // configured secure-review channel path below.
  return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
}

/** Full read grant used only by the configured secure review channel. */
export function grantForSecureReview(
  db: DatabaseSync,
  acceptedScopes: readonly VisibilityClass[] = [],
): RetrievalGrant {
  const rows = db.prepare(
    "SELECT id, parent_id FROM channels WHERE visibility_class = 'restricted' AND ingest_enabled = 1 AND deleted_at_ms IS NULL",
  ).all() as Array<{ id: string; parent_id: string | null }>;
  return {
    includeOrgMessages: acceptedScopes.includes('org'),
    includeOrgMemories: acceptedScopes.includes('org'),
    includeReviewOnly: acceptedScopes.includes('review_only'),
    channelIds: acceptedScopes.includes('restricted')
      ? [...new Set(rows.map((r) => r.parent_id ?? r.id))]
      : [],
  };
}

/** Resolve the exact configured secure-review target for scheduled prompt rendering. */
export function resolveScheduledReviewScope(
  db: DatabaseSync,
  reviewChannelId: string,
  acceptedScopes: readonly VisibilityClass[] = [],
): ReviewScope {
  const targetScope = resolveCurrentChannelScope(db, reviewChannelId);
  const channel = getChannel(db, reviewChannelId);
  if (!targetScope || !channel) {
    throw new PermanentJobError(
      `scheduled review channel ${reviewChannelId} is missing or no longer available`,
    );
  }
  if (acceptedScopes.length === 0) {
    throw new PermanentJobError('scheduled review channel accepts no visibility scopes');
  }
  return {
    grant: grantForSecureReview(db, acceptedScopes),
    reviewChannelId,
    targetChannelId: reviewChannelId,
    notificationsAllowed: false,
    target: {
      label: channel.name ? `#${channel.name}` : reviewChannelId,
      // The configured secure review channel is the only audience permitted to
      // receive review_only evidence. Its ordinary persisted policy class may
      // be org/restricted, but that would understate this run's effective
      // audience and discourage the model from handling quarantined material.
      visibility: acceptedScopes.includes('review_only')
        ? 'review_only'
        : acceptedScopes.includes('restricted') ? 'restricted' : 'org',
    },
  };
}

/** Resolve an exact working target for a deliverable scheduled cohort. */
export function resolveScheduledWorkingScope(
  db: DatabaseSync,
  targetChannelId: string,
  reviewChannelId: string,
): ReviewScope {
  const current = resolveRetrievableChannelScope(db, targetChannelId);
  const channel = getChannel(db, targetChannelId);
  if (
    !current
    || !channel
    || channel.allow_interventions !== 1
    || channel.visibility_class === 'excluded'
    || isCassandraTestSurface(db, targetChannelId)
  ) {
    throw new PermanentJobError(`scheduled working target ${targetChannelId} is unavailable`);
  }
  return {
    grant: grantForTargetChannel(channel),
    reviewChannelId,
    targetChannelId,
    notificationsAllowed: true,
    target: {
      label: channel.name ? `#${channel.name}` : targetChannelId,
      visibility: current.visibility,
    },
  };
}

/** Resolve a direct-answer grant, recognizing the secure review channel by ID. */
export function grantForDirectAnswerChannel(
  db: DatabaseSync,
  channelId: string,
  reviewChannelId: string | undefined,
  reviewAcceptedScopes: readonly VisibilityClass[] = [],
): RetrievalGrant {
  const current = resolveCurrentChannelScope(db, channelId);
  if (!current) return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
  if (reviewChannelId && channelId === reviewChannelId) {
    return grantForSecureReview(db, reviewAcceptedScopes);
  }
  if (current.visibility === 'org') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  if (current.visibility === 'restricted') {
    return { includeOrgMessages: false, includeOrgMemories: true, includeReviewOnly: false, channelIds: [current.scopeChannelId] };
  }
  return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
}

function recentChecks(
  ctx: BootstrapContext,
  channelId: string,
  content: string,
  now: number,
  kind: 'autonomous' | 'direct_answer' = 'direct_answer',
  topicKey: string | null = null,
) {
  // A civil day can be 25 hours at a DST transition. Query from the earlier of
  // the current org-day boundary and the duplicate/cooldown lookback so neither
  // daily limits nor long cooldowns silently undercount around that boundary.
  const cooldownLookbackMs = Math.max(
    24 * 60 * 60 * 1000,
    ctx.config.intervention.channelCooldownMinutes * 60_000,
    DEFAULT_COOLDOWN_CONFIG.topicCooldownHours * 3_600_000,
  );
  const sinceMs = Math.min(orgDayStartMs(now, ctx.config.organization.timezone), now - cooldownLookbackMs);
  const sent = ctx.db.prepare(
    `SELECT o.channel_id, o.content, o.sent_at_ms, o.proposal_id, p.topic_key
       FROM outbox o
       LEFT JOIN proposals p ON p.id = o.proposal_id
      WHERE o.status = 'sent' AND o.sent_at_ms IS NOT NULL AND o.sent_at_ms >= ?
      ORDER BY o.sent_at_ms DESC LIMIT 100`,
  ).all(sinceMs) as Array<{
    channel_id: string;
    content: string;
    sent_at_ms: number;
    proposal_id: string | null;
    topic_key: string | null;
  }>;
  const history = sent.map((r) => ({ channelId: r.channel_id, topicKey: r.topic_key,
    kind: r.proposal_id ? 'autonomous' as const : 'direct_answer' as const, sentAtMs: r.sent_at_ms }));
  return {
    cooldown: evaluateCooldowns(
      { ...DEFAULT_COOLDOWN_CONFIG, channelCooldownMinutes: ctx.config.intervention.channelCooldownMinutes,
        globalDailyLimit: ctx.config.intervention.globalDailyLimit, timeZone: ctx.config.organization.timezone },
      now,
      history,
      { channelId, topicKey, kind },
    ),
    duplicate: detectDuplicate({
      content,
      now,
      // The host-owned scheduled footer is constant boilerplate; strip it so it
      // cannot inflate similarity between otherwise-distinct notifications.
      recentMessages: sent.filter((r) => r.channel_id === channelId).map((r) => ({ content: stripScheduledFooter(r.content), sentAtMs: r.sent_at_ms, source: 'outbox' as const })),
    }),
  };
}

type CurrentReviewProvenance =
  | { outcome: 'resolved'; entries: ProvenanceScopeEntry[] }
  | { outcome: 'reject'; gate: ProvenanceGateResult };

/**
 * Resolve human-reviewed run provenance against current durable state.
 *
 * Memory scopes stored on the run describe what was visible when retrieval
 * happened, but they are only a cache. Every exact exposed memory is resolved
 * again from its current evidence before proposal creation and approval. A
 * legacy or malformed record that claims memory-scope exposure without naming
 * the exact rows cannot be revalidated and therefore fails closed.
 */
function resolveCurrentReviewProvenance(
  db: DatabaseSync,
  provenance: AgentRunResult['provenance'],
  guildId: string,
): CurrentReviewProvenance {
  const rawStoredMemoryScopes = (provenance as { memoryScopes?: unknown }).memoryScopes;
  if (!Array.isArray(rawStoredMemoryScopes)) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance is malformed'],
      },
    };
  }
  const storedMemoryScopes = rawStoredMemoryScopes;
  const rawMemoryIds = (provenance as { memoryIds?: unknown }).memoryIds;
  const hasStoredMemoryScopes = storedMemoryScopes.length > 0;

  if (!Array.isArray(rawMemoryIds)) {
    if (hasStoredMemoryScopes || rawMemoryIds !== undefined) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['memory provenance does not contain valid exposed row identifiers'],
        },
      };
    }
  } else if (rawMemoryIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance does not contain valid exposed row identifiers'],
      },
    };
  }

  const memoryIds = Array.isArray(rawMemoryIds)
    ? [...new Set(rawMemoryIds as string[])]
    : [];
  if (hasStoredMemoryScopes && memoryIds.length === 0) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance does not identify its exposed rows'],
      },
    };
  }

  const currentScopes = recomputeMemoryScopes(db, memoryIds);
  const memoryScopes: AgentRunResult['provenance']['memoryScopes'] = [];
  for (const memoryId of memoryIds) {
    const memory = getMemory(db, memoryId);
    if (!memory || memory.guild_id !== guildId) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['an exposed memory is no longer available'],
        },
      };
    }
    const scope = currentScopes.get(memoryId);
    if (!scope) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['an exposed memory scope can no longer be resolved'],
        },
      };
    }
    memoryScopes.push({
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      source: 'memory_search',
    });
  }

  return {
    outcome: 'resolved',
    entries: resolveProvenanceScopes({
      ...provenance,
      // Never trust the retrieval-time cache when exact memory rows exist.
      memoryScopes,
      memoryIds,
    }, {
      channelVisibility: (id) => resolveRetrievableChannelScope(db, id)?.visibility,
      channelScopeId: (id) => resolveRetrievableChannelScope(db, id)?.scopeChannelId,
    }),
  };
}

export function buildApprovalRecheck(
  ctx: BootstrapContext,
  proposalId: string,
  now = ctx.now(),
  scheduledRouteOptions?: ScheduledRouteOptions,
): ApprovalPolicyRecheck {
  const proposal = getProposal(ctx.db, proposalId);
  if (!proposal) {
    return { provenance: { outcome: 'reject', reasons: ['proposal not found'] },
      outboundEvidence: { outcome: 'reject', reasons: ['proposal not found'] },
      cooldown: { allowed: false, blocks: [], retryAfterMs: null }, duplicate: { matched: false } };
  }
  const currentTarget = resolveCurrentChannelScope(ctx.db, proposal.targetChannelId);
  const target = { channelId: proposal.targetChannelId,
    scopeChannelId: currentTarget?.scopeChannelId ?? proposal.targetChannelId,
    visibility: currentTarget?.visibility ?? 'excluded',
    isSecureReview: proposal.targetChannelId === ctx.config.reviewChannelId };
  const evidenceMessageIds = [...new Set(proposal.evidenceMessageIds)];
  let provenance: ApprovalPolicyRecheck['provenance'];
  let runType: string | undefined;
  let runGuildId: string | undefined;
  try {
    const run = ctx.db.prepare('SELECT run_type, guild_id, retrieval_provenance_json FROM agent_runs WHERE id = ?').get(proposal.runId) as
      | { run_type: string; guild_id: string; retrieval_provenance_json: string }
      | undefined;
    if (!run) throw new Error('originating run not found');
    runType = run.run_type;
    runGuildId = run.guild_id;
    const parsed = JSON.parse(run.retrieval_provenance_json) as AgentRunResult['provenance'];
    if (!parsed || !Array.isArray(parsed.channels) || !Array.isArray(parsed.memoryScopes)) {
      throw new Error('originating run provenance is malformed');
    }
    const currentResolution = resolveCurrentReviewProvenance(ctx.db, parsed, run.guild_id);
    const currentProvenance = currentResolution.outcome === 'reject'
      ? currentResolution.gate
      : evaluateProvenanceGate({
          pinnedTargetChannelId: proposal.targetChannelId,
          proposedTargetChannelId: proposal.targetChannelId,
          target,
          provenance: currentResolution.entries,
        });
    const runMessageIds = new Set(
      Array.isArray(parsed.messageIds)
        ? parsed.messageIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const reviewRunLabel = runType === 'scheduled_review'
      ? 'scheduled'
      : runType === 'episode'
        ? 'episode'
        : undefined;
    if (reviewRunLabel && evidenceMessageIds.some((id) => !runMessageIds.has(id))) {
      provenance = {
        outcome: 'reject',
        reasons: [...currentProvenance.reasons,
          `${reviewRunLabel} proposal cites evidence not exposed by the originating run`],
      };
    } else {
      provenance = currentProvenance;
    }
  } catch (err) {
    provenance = { outcome: 'reject', reasons: [err instanceof Error ? err.message : 'run provenance unavailable'] };
  }
  const scheduledSubjects = runType === 'scheduled_review'
    ? getScheduledProposalSubjects(ctx.db, proposal.id)
    : [];
  let outboundEvidence: ApprovalPolicyRecheck['outboundEvidence'] = validateOutboundEvidence({ target, citedMessageIds: evidenceMessageIds,
    referencedMemoryIds: scheduledSubjects.map((subject) => subject.memoryId),
    requireInterventionsEnabled: true,
  }, {
    resolveMessage: (id) => { const m = getMessage(ctx.db, id); if (!m) return undefined;
      if ((runGuildId !== undefined && m.guild_id !== runGuildId) || isCassandraTestSurface(ctx.db, m.channel_id)) {
        return undefined;
      }
      const scope = resolveRetrievableChannelScope(ctx.db, m.channel_id);
      return scope ? { channelId: m.channel_id, scopeChannelId: scope.scopeChannelId,
        visibility: scope.visibility, deletedAtMs: m.deleted_at_ms } : undefined; },
    resolveMemoryScope: (id) => { const m = getMemory(ctx.db, id); return m ? { scopeType: m.scope_type, scopeKey: m.scope_key } : undefined; },
    resolveChannel: (id) => { const c = getChannel(ctx.db, id); if (!c) return undefined;
      const scope = resolveCurrentChannelScope(ctx.db, id); return { visibility: scope?.visibility ?? 'excluded',
      allowInterventions: c.allow_interventions === 1, deletedAtMs: c.deleted_at_ms }; },
  });
  if (runType === 'scheduled_review') {
    const durableMessage = proposal.message;
    const textSafetyReasons: string[] = [];
    if (typeof durableMessage !== 'string' || durableMessage.trim().length === 0) {
      textSafetyReasons.push('proposal has no sendable message text');
    } else {
      // Episode proposals may already contain host-built source links in their
      // assembled durable text. Scheduled notifications store marker text —
      // links are substituted at delivery — so re-run the full
      // model-authored-text sanitizer here without changing episode logic.
      const sanitized = sanitizeOutboundMessage({ content: durableMessage, guildId: null });
      if (sanitized.outcome === 'reject') {
        textSafetyReasons.push(...sanitized.reasons);
      }
    }
    if (textSafetyReasons.length > 0) {
      outboundEvidence = {
        outcome: 'reject',
        reasons: [...outboundEvidence.reasons, ...textSafetyReasons],
      };
    }
  }
  const rate = recentChecks(
    ctx,
    proposal.targetChannelId,
    proposal.message ?? '',
    now,
    'autonomous',
    proposal.topicKey,
  );
  // Route validation plus delivery rendering: approval must ship the exact
  // assembled text the card showed, and a render failure (evidence no longer
  // resolvable to links) blocks delivery the same way route drift does.
  const checkScheduledDelivery = (): ScheduledDeliveryCheck | undefined => {
    // `runGuildId` is always set here: runType comes from the same run row.
    if (runType !== 'scheduled_review' || !scheduledRouteOptions || runGuildId === undefined) return undefined;
    const check = validateScheduledProposalDelivery(ctx.db, proposal.id, scheduledRouteOptions, now);
    if (!check.allow) return check;
    const rendered = renderScheduledNotificationDelivery(ctx.db, runGuildId, proposal);
    if (rendered.outcome === 'reject') {
      return { ...check, allow: false, reasons: rendered.reasons };
    }
    return { ...check, deliveryContent: rendered.content };
  };
  const scheduledDelivery = checkScheduledDelivery();
  return {
    provenance,
    outboundEvidence,
    cooldown: rate.cooldown,
    duplicate: rate.duplicate,
    scheduledReminderIntervalMs: ctx.config.memory?.scheduledReviewReminderDays
      ? ctx.config.memory.scheduledReviewReminderDays * 86_400_000
      : DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    scheduledDelivery,
    revalidateScheduledDelivery: scheduledDelivery
      ? () => checkScheduledDelivery() ?? { allow: true, reasons: [] }
      : undefined,
  };
}

/** Build the reviewer-facing scheduled proposal from durable, current host data. */
export function buildScheduledReviewPresentation(
  db: DatabaseSync,
  guildId: string,
  proposal: ProposalRow,
): ReviewProposalInput {
  const targetChannel = getChannel(db, proposal.targetChannelId);
  // The card quotes the exact assembled delivery text — inline links and
  // footer included — so approval queues precisely what the reviewer read.
  // A failed render (evidence gone since composition) falls back to the
  // durable marker text; approval re-renders and blocks in that case.
  const rendered = renderScheduledNotificationDelivery(db, guildId, proposal);

  return {
    proposalId: proposal.id,
    targetLabel: targetChannel?.name ? `#${targetChannel.name}` : `<#${proposal.targetChannelId}>`,
    score: proposal.computedScore,
    assessment: 'Recommended scheduled review',
    reason: proposal.reason,
    recommendationReason: proposal.reviewReason ?? undefined,
    proposedMessage: rendered.outcome === 'allow' ? rendered.content : (proposal.message ?? ''),
    sources: [],
    expiresAtMs: proposal.expiresAtMs,
  };
}

export async function routeEpisodeIntervention(
  ctx: BootstrapContext,
  client: NonNullable<DiscordWiring['client']>,
  secret: string,
  input: Parameters<NonNullable<Parameters<typeof createReviewEpisodeHandler>[0]['routeIntervention']>>[0],
): Promise<string | undefined> {
  // Historical reconstruction exists to build memory, never to interrupt an
  // old conversation or create a review-channel posting proposal.
  if (input.episode.origin === 'historical') return undefined;
  const intervention = input.proposal.intervention;
  if (!intervention?.dimensions || !intervention.targetChannelId) return undefined;
  const targetRow = getChannel(ctx.db, input.episode.conversation_channel_id);
  const currentTarget = resolveCurrentChannelScope(ctx.db, input.episode.conversation_channel_id);
  const target = {
    channelId: input.episode.conversation_channel_id,
    scopeChannelId: currentTarget?.scopeChannelId ?? input.episode.conversation_channel_id,
    visibility: currentTarget?.visibility ?? 'excluded',
    isSecureReview: input.episode.conversation_channel_id === ctx.config.reviewChannelId,
  };
  const message = intervention.message ?? '';
  const evidenceIds = [...new Set(intervention.evidenceMessageIds ?? [])];
  const resolveCurrentEvidenceMessage = (id: string) => {
    const stored = getMessage(ctx.db, id);
    if (
      !stored
      || stored.guild_id !== ctx.config.discord.guildId
      || isCassandraTestSurface(ctx.db, stored.channel_id)
    ) return undefined;
    const scope = resolveRetrievableChannelScope(ctx.db, stored.channel_id);
    return scope ? { stored, scope } : undefined;
  };
  const sanitized = sanitizeOutboundMessage({ content: message, sourceLinkMessageIds: evidenceIds,
    guildId: ctx.config.discord.guildId }, {
    resolveChannelId: (id) => resolveCurrentEvidenceMessage(id)?.stored.channel_id,
  });
  const currentResolution = resolveCurrentReviewProvenance(
    ctx.db,
    input.result.provenance,
    ctx.config.discord.guildId,
  );
  const provenanceEntries = currentResolution.outcome === 'resolved'
    ? currentResolution.entries
    : [];
  const currentProvenanceGate = currentResolution.outcome === 'reject'
    ? currentResolution.gate
    : evaluateProvenanceGate({ pinnedTargetChannelId: input.episode.conversation_channel_id,
        proposedTargetChannelId: intervention.targetChannelId, target, provenance: provenanceEntries });
  const exposedMessageIds = new Set(
    Array.isArray(input.result.provenance.messageIds)
      ? input.result.provenance.messageIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const provenanceGate = evidenceIds.some((id) => !exposedMessageIds.has(id))
    ? {
        outcome: 'reject' as const,
        reasons: ['episode proposal cites evidence not exposed by the originating run'],
      }
    : currentProvenanceGate;
  const outboundEvidence = validateOutboundEvidence({ target, citedMessageIds: evidenceIds, referencedMemoryIds: [],
    replyToMessageId: intervention.replyToMessageId }, {
    resolveMessage: (id) => {
      const current = resolveCurrentEvidenceMessage(id); if (!current) return undefined;
      return { channelId: current.stored.channel_id, scopeChannelId: current.scope.scopeChannelId,
        visibility: current.scope.visibility, deletedAtMs: current.stored.deleted_at_ms };
    },
    resolveMemoryScope: (id) => { const m = getMemory(ctx.db, id); return m ? { scopeType: m.scope_type, scopeKey: m.scope_key } : undefined; },
    resolveChannel: (id) => { const c = getChannel(ctx.db, id); if (!c) return undefined;
      const scope = resolveCurrentChannelScope(ctx.db, id); return { visibility: scope?.visibility ?? 'excluded',
      allowInterventions: c.allow_interventions === 1, deletedAtMs: c.deleted_at_ms }; },
  });
  const restrictedChannels = new Set(provenanceEntries.filter((p) => p.visibility === 'restricted').map((p) => p.channelId).filter(Boolean));
  const forcedReview = evaluateForcedReview({ message, reason: intervention.reason, urgency: intervention.urgency ?? 'normal',
    evidenceStrength: intervention.dimensions.evidenceStrength, distinctRestrictedChannelCount: restrictedChannels.size,
    uncertain: provenanceGate.outcome === 'force_review' || outboundEvidence.outcome === 'force_review' });
  const rate = recentChecks(ctx, target.channelId, message, input.now, 'autonomous');
  const routingInput = { mode: ctx.config.mode,
    thresholds: { score: ctx.config.intervention.threshold, confidence: ctx.config.intervention.minConfidence,
      evidenceStrength: ctx.config.intervention.minEvidenceStrength, maxContentLength: ctx.config.intervention.maxMessageCharacters },
    eligibility: { recommend: intervention.recommend === true, dimensions: intervention.dimensions,
      confidence: intervention.confidence ?? 0, evidenceStrength: intervention.dimensions.evidenceStrength,
      evidenceCount: evidenceIds.length, contentLength: message.length, hasDisallowedMention: sanitized.outcome === 'reject' },
    provenanceGate, outboundEvidence, forcedReview, cooldown: rate.cooldown, duplicate: rate.duplicate };
  const routing = routeProposal(routingInput);
  const policyDecision = buildEpisodePolicyDecision(
    routingInput,
    routing,
    sanitized.outcome === 'reject'
      ? { outcome: 'reject', reasons: sanitized.reasons }
      : { outcome: 'allow', reasons: [] },
  );
  const assembled = sanitized.outcome === 'allow'
    ? [sanitized.content, sanitized.sourceLinks.length ? sanitized.sourceLinks.map((l) => l.masked).join('\n') : ''].filter(Boolean).join('\n\n')
    : null;
  const expiresAtMs = routing.state === 'pending_review' ? input.now + 72 * 60 * 60 * 1000 : null;
  let proposalId = '';
  if (routing.state === 'approved' && assembled) {
    transaction(ctx.db, () => {
      proposalId = insertProposal(ctx.db, { runId: input.result.runId, episodeId: input.episode.id,
        targetChannelId: target.channelId, status: routing.state, computedScore: routing.score, reason: routing.reasons,
        policyDecision,
        message: assembled, evidenceMessageIds: evidenceIds, replyToMessageId: intervention.replyToMessageId,
        expiresAtMs, now: input.now });
      enqueueOutbox(ctx.db, { proposalId, runId: input.result.runId, channelId: target.channelId,
        content: assembled, replyToMessageId: intervention.replyToMessageId, now: input.now });
    });
  } else {
    proposalId = insertProposal(ctx.db, { runId: input.result.runId, episodeId: input.episode.id,
      targetChannelId: target.channelId, status: routing.state, computedScore: routing.score, reason: routing.reasons,
      policyDecision,
      message: assembled, evidenceMessageIds: evidenceIds, replyToMessageId: intervention.replyToMessageId,
      expiresAtMs, now: input.now });
  }
  if (routing.state === 'approved' && assembled) {
    // The proposal and outbox are already durable in one transaction.
  } else if (routing.state === 'pending_review' && assembled && ctx.config.reviewChannelId) {
    try {
      await deliverProposalReview({ proposalId, targetLabel: targetRow?.name ? `#${targetRow.name}` : target.channelId,
        score: routing.score, reason: routing.reasons.join('; '), proposedMessage: sanitized.outcome === 'allow' ? sanitized.content : assembled,
        sources: sanitized.outcome === 'allow' ? sanitized.sourceLinks.map((l) => l.masked) : [], expiresAtMs },
      { db: ctx.db, reviewChannelId: ctx.config.reviewChannelId, channel: createDiscordReviewChannel(client), secret, now: input.now });
    } catch (err) {
      ctx.logger.warn({ event: 'proposal.review_delivery_failed', proposalId,
        err: err instanceof Error ? err.message : String(err) }, 'proposal remains pending and visible to admin commands');
    }
  }
  return proposalId;
}

/** Compose and start every durable production job handler and periodic schedule. */
export async function createProductionJobRuntime(
  ctx: BootstrapContext,
  discord: DiscordWiring,
): Promise<JobRuntimeWiring> {
  const client = discord.client;
  if (!client) throw new Error('production job runtime requires a Discord client');
  const snapshot = () => ctx.configStore?.get() ?? ctx.snapshot!;
  const fetcher = createDiscordMessageFetcher(client);
  const ingestOptions = (now: number) => ({
    guildId: ctx.config.discord.guildId,
    storeRawJson: ctx.config.ingestion.storeRawJson,
    retainEditHistory: ctx.config.ingestion.retainEditHistory,
    retainDeletedContent: ctx.config.ingestion.retainDeletedContent,
    attachmentMode: ctx.config.ingestion.attachmentMode,
    attachmentArchive: ctx.config.ingestion.attachmentMode === 'archive' || ctx.config.ingestion.attachmentMode === 'selective' ? {
      mode: ctx.config.ingestion.attachmentMode,
      maxBytes: ctx.config.ingestion.attachmentMaxBytes,
      mimeAllowlist: ctx.config.ingestion.attachmentMimeAllowlist,
      dataDir: ctx.config.dataDir,
    } : undefined,
    now,
  });
  const repair = repairDurableWork(ctx.db, {
    now: ctx.now(),
    quietSeconds: ctx.config.episodes.quietSeconds,
    fullHistory: ctx.config.ingestion.fullHistory,
    scheduledRouteOptions: ctx.config.reviewChannelId ? {
      guildId: ctx.config.discord.guildId,
      reviewChannelId: ctx.config.reviewChannelId,
      reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
    } : undefined,
  });
  ctx.logger.info({ event: 'jobs.startup_repair', ...repair }, 'durable work repaired before worker startup');

  const models = builtinModels();
  const resolved = resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: ctx.config.llm.model,
    triageModelId: ctx.config.llm.triageModel ?? null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    thinkingLevel: ctx.config.agentRuntime.thinkingLevel,
  }, defaultModelLookup(models));
  const agent = {
    model: resolved.primary.model,
    thinkingLevel: ctx.config.agentRuntime.thinkingLevel,
    streamFn: models.streamSimple.bind(models),
    providerId: resolved.providerId,
    modelId: resolved.primary.model.id,
  };
  const shadowResolved = ctx.config.episodeShadow.enabled ? resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: ctx.config.episodeShadow.model ?? ctx.config.llm.model,
    triageModelId: null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    thinkingLevel: ctx.config.episodeShadow.thinkingLevel,
  }, defaultModelLookup(models)) : undefined;
  const episodeShadow = {
    ...ctx.config.episodeShadow,
    agent: shadowResolved ? {
      model: shadowResolved.primary.model,
      thinkingLevel: ctx.config.episodeShadow.thinkingLevel,
      streamFn: models.streamSimple.bind(models),
      providerId: shadowResolved.providerId,
      modelId: shadowResolved.primary.model.id,
    } : undefined,
  };
  const campaignConfig = ctx.config.historicalMemory.campaignId ? {
    id: ctx.config.historicalMemory.campaignId,
    guildId: ctx.config.discord.guildId,
    direction: ctx.config.historicalMemory.direction,
    fromAtMs: ctx.config.historicalMemory.fromAtMs!,
    toAtMs: ctx.config.historicalMemory.toAtMs!,
    provider: ctx.config.llm.provider,
    model: ctx.config.historicalMemory.model!,
    thinkingLevel: ctx.config.historicalMemory.thinkingLevel,
    channelIds: ctx.config.historicalMemory.channelIds,
    dailyBudgetUsd: ctx.config.historicalMemory.dailyBudgetUsd,
    totalBudgetUsd: ctx.config.historicalMemory.totalBudgetUsd,
  } as const : undefined;
  const campaign = campaignConfig
    ? ensureHistoricalCampaign(ctx.db, campaignConfig, ctx.now())
    : undefined;
  const historicalResolved = campaignConfig ? resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: campaignConfig.model,
    triageModelId: null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: campaignConfig.dailyBudgetUsd,
    thinkingLevel: campaignConfig.thinkingLevel,
  }, defaultModelLookup(models)) : undefined;
  const historicalAgent = historicalResolved ? {
    model: historicalResolved.primary.model,
    thinkingLevel: campaignConfig!.thinkingLevel,
    streamFn: models.streamSimple.bind(models),
    providerId: historicalResolved.providerId,
    modelId: historicalResolved.primary.model.id,
  } : undefined;
  if (campaign) {
    ctx.logger.info({
      event: 'historical_campaign.ready',
      campaignId: campaign.id,
      status: campaign.status,
      direction: campaign.direction,
      fromAtMs: campaign.from_at_ms,
      toAtMs: campaign.to_at_ms,
      channelCount: campaignConfig!.channelIds.length,
      provider: campaign.provider,
      model: campaign.model,
      thinkingLevel: campaign.thinking_level,
      dailyBudgetUsd: campaign.daily_budget_usd,
      totalBudgetUsd: campaign.total_budget_usd,
    }, 'bounded historical campaign configured');
  }
  const modelGate = new ModelBudgetGate({ dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    timeZone: ctx.config.organization.timezone }, ctx.now());
  // The cap is operational policy, not process-local state. Hydrate today's
  // persisted spend so restarting Cassandra cannot reset or bypass the budget.
  const persistedSpend = ctx.db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_runs WHERE started_at_ms >= ? AND cost_usd IS NOT NULL',
  ).get(orgDayStartMs(ctx.now(), ctx.config.organization.timezone)) as { total: number };
  modelGate.recordSpend(Number(persistedSpend.total), ctx.now());
  const historicalBudget = new OrgDayBudget({
    dailyBudgetUsd: ctx.config.historicalMemory.dailyBudgetUsd,
    timeZone: ctx.config.organization.timezone,
  }, ctx.now());
  const historicalDayStart = orgDayStartMs(ctx.now(), ctx.config.organization.timezone);
  const persistedHistoricalSpend = campaign
    ? historicalCampaignSpend(ctx.db, campaign.id, historicalDayStart)
    : Number((ctx.db.prepare(`
        SELECT COALESCE(SUM(ar.cost_usd), 0) AS total
          FROM agent_runs ar JOIN episodes e ON e.id = ar.episode_id
         WHERE e.origin = 'historical' AND ar.started_at_ms >= ? AND ar.cost_usd IS NOT NULL
      `).get(historicalDayStart) as { total: number }).total);
  historicalBudget.recordSpend(persistedHistoricalSpend, ctx.now());
  if (campaign?.status === 'running') {
    const reviewsWoken = wakeHistoricalCampaignReviews(ctx.db, campaign.id, ctx.now());
    if (reviewsWoken > 0) {
      ctx.logger.info({ event: 'historical_campaign.reviews_woken', campaignId: campaign.id, reviewsWoken },
        'deferred historical reviews made eligible after campaign startup');
    }
  }
  ctx.runtime.markModelHealthy();
  // Provider concurrency remains exactly AGENT_MAX_CONCURRENCY: interactive
  // priority is a non-preemptive queue order, not a fully reserved extra slot.
  // After three contested direct-answer handoffs, one background waiter runs so
  // a sustained mention stream cannot starve durable review work indefinitely.
  const modelAdmission = new ModelAdmissionController({
    capacity: ctx.config.agentRuntime.maxConcurrency,
    directBurstLimit: 3,
  });
  const gatedExecute = async (run: ExecuteAgentRunDeps) => {
    if (ctx.runtime.isShuttingDown()) {
      throw new DeferJobError('model work deferred: process is shutting down', 60_000);
    }
    const episode = run.episodeId
      ? ctx.db.prepare('SELECT origin,historical_campaign_id FROM episodes WHERE id=?').get(run.episodeId) as
        | { origin: string; historical_campaign_id: string | null }
        | undefined
      : undefined;
    const historical = episode?.origin === 'historical';
    const campaignRun = Boolean(campaign && episode?.historical_campaign_id === campaign.id);
    if (campaignRun) {
      const current = getHistoricalCampaign(ctx.db, campaign!.id);
      if (current?.status !== 'running') {
        throw new DeferJobError(`historical campaign is ${current?.status ?? 'missing'}`, 5 * 60_000);
      }
      if (historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
        setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
        throw new DeferJobError('historical campaign total budget exhausted', 5 * 60_000);
      }
    }
    if (historical && historicalBudget.isExhausted(ctx.now())) {
      throw new DeferJobError('historical model work deferred: daily budget exhausted', historicalBudget.msUntilNextDay(ctx.now()));
    }
    const decision = modelGate.evaluate(ctx.now());
    if (!decision.allow) {
      ctx.runtime.markModelDegraded();
      throw new DeferJobError(`model work deferred: ${decision.reason ?? 'gate'}`, decision.retryAfterMs ?? 60_000);
    }
    const interactiveAdmission = (run.admissionClass ?? run.runType) === 'direct_answer';
    const directAdmissionWaitMs = interactiveAdmission
      ? directAnswerAdmissionWaitMs(run.requestDeadlineAtMs, ctx.now())
      : undefined;
    if (directAdmissionWaitMs === 0) {
      throw new ModelAdmissionTimeoutError(0);
    }
    const releaseModelSlot = await modelAdmission.acquire(
      interactiveAdmission ? 'direct_answer' : 'background',
      directAdmissionWaitMs === undefined ? {} : { timeoutMs: directAdmissionWaitMs },
    );
    try {
      if (ctx.runtime.isShuttingDown()) {
        throw new DeferJobError('model work deferred: process is shutting down', 60_000);
      }
      const currentDecision = modelGate.evaluate(ctx.now());
      if (!currentDecision.allow) {
        ctx.runtime.markModelDegraded();
        throw new DeferJobError(
          `model work deferred: ${currentDecision.reason ?? 'gate'}`,
          currentDecision.retryAfterMs ?? 60_000,
        );
      }
      if (historical && historicalBudget.isExhausted(ctx.now())) {
        throw new DeferJobError('historical model work deferred: daily budget exhausted', historicalBudget.msUntilNextDay(ctx.now()));
      }
      if (campaignRun) {
        const current = getHistoricalCampaign(ctx.db, campaign!.id);
        if (!current || historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
          setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
          throw new DeferJobError('historical campaign total budget exhausted', 5 * 60_000);
        }
      }
      let execution = campaignRun && historicalAgent ? {
        ...run,
        model: historicalAgent.model,
        thinkingLevel: historicalAgent.thinkingLevel,
        streamFn: historicalAgent.streamFn,
        providerId: historicalAgent.providerId,
        modelId: historicalAgent.modelId,
      } : run;
      if (run.runType === 'direct_answer' && run.requestDeadlineAtMs !== undefined) {
        const wallClockMs = deadlineBoundWallClockMs(
          execution.limits?.wallClockMs
            ?? ctx.config.agentRuntime.timeoutSeconds * 1_000,
          run.requestDeadlineAtMs,
          ctx.now(),
        );
        if (wallClockMs === 0) throw new ModelAdmissionTimeoutError(0);
        execution = {
          ...execution,
          limits: { ...execution.limits, wallClockMs },
        };
      }
      execution = {
        ...execution,
        requireKnownPricing: historical
          ? ctx.config.historicalMemory.dailyBudgetUsd > 0
          : ctx.config.llm.dailyBudgetUsd !== null,
      };
      const result = await executeAgentRun(execution);
      modelGate.recordSpend(result.usage.costUsd, ctx.now());
      if (historical) historicalBudget.recordSpend(result.usage.costUsd, ctx.now());
      if (campaignRun) {
        const current = getHistoricalCampaign(ctx.db, campaign!.id);
        if (current && historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
          setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
        }
      }
      if (result.outcome === 'error' || result.outcome === 'aborted') {
        const failure = classifyModelError({ message: result.failureReason ?? result.outcome });
        modelGate.recordModelFailure(failure, ctx.now());
        ctx.runtime.markModelDegraded();
        throw new TransientJobError(result.failureReason ?? `model run ${result.outcome}`, {
          billableAgentRun: {
            runId: result.runId,
            costUsd: result.usage.costUsd,
            startedAtMs: result.startedAtMs,
          },
        });
      }
      modelGate.recordModelSuccess(ctx.now());
      if (modelGate.health.status(ctx.now()) === 'healthy') ctx.runtime.markModelHealthy();
      else ctx.runtime.markModelDegraded();
      return result;
    } finally {
      releaseModelSlot();
    }
  };
  const systemPrompt = (runContext: Record<string, unknown>) => snapshot().promptCompiler.render('system', {
    ...runContext,
    agent: ctx.config.agent,
    organization: ctx.config.organization,
    personality: ctx.config.personality,
  });
  const reviewSecret = createHash('sha256').update(ctx.config.discord.token).update(':review-components').digest('hex');
  const limits = configuredRunLimits(ctx.config.agentRuntime);
  // Cassandra's own documentation, scanned one time: a direct-answer run reads it
  // through `list_docs` / `read_doc` (Section 22.7).
  const docsIndex = loadDocsIndex(ctx.config.docsDir, ctx.config.docsPublicUrl);
  if (docsIndex.size === 0) {
    ctx.logger.warn(
      { docsDir: ctx.config.docsDir },
      'documentation index is empty; Cassandra cannot answer questions about herself',
    );
  }
  const scope = (channelId: string) => {
    const current = resolveCurrentChannelScope(ctx.db, channelId);
    const visibility = current?.visibility ?? 'excluded';
    return {
      grant: grantForDirectAnswerChannel(
        ctx.db,
        channelId,
        ctx.config.reviewChannelId,
        snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      ),
      target: { channelId, scopeChannelId: current?.scopeChannelId ?? channelId,
        visibility, isSecureReview: channelId === ctx.config.reviewChannelId },
    };
  };

  const worker = createJobWorker({
    db: ctx.db,
    owner: `cassandra:${process.pid}`,
    leaseMs: productionJobLeaseMs(ctx.config.agentRuntime.timeoutSeconds),
    pollIntervalMs: 1_000,
    shutdownTimeoutMs: ctx.config.maintenance.shutdownTimeoutSeconds * 1000,
    isPaused: () => isPaused(ctx.db),
    clock: ctx.now,
  });
  worker.register('backfill_channel', ctx.config.ingestion.backfillConcurrency,
    createBackfillChannelHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now, logger: ctx.logger }));
  worker.register('build_historical_episodes', 1, createBuildHistoricalEpisodesHandler({
    db: ctx.db,
    guildId: ctx.config.discord.guildId,
    config: {
      channelIds: ctx.config.historicalMemory.channelIds,
      batchMessages: ctx.config.historicalMemory.batchMessages,
      maxPendingReviews: ctx.config.historicalMemory.maxPendingReviews,
      quietSeconds: ctx.config.episodes.quietSeconds,
      maxMessages: ctx.config.episodes.maxMessages,
      maxMinutes: ctx.config.episodes.maxMinutes,
      campaign: campaign ? { id: campaign.id, fromAtMs: campaign.from_at_ms, toAtMs: campaign.to_at_ms } : undefined,
    },
    now: ctx.now,
    logger: ctx.logger,
  }));
  worker.register('archive_attachment', 1, createArchiveAttachmentHandler({ db: ctx.db, config: {
    mode: ctx.config.ingestion.attachmentMode,
    maxBytes: ctx.config.ingestion.attachmentMaxBytes,
    mimeAllowlist: ctx.config.ingestion.attachmentMimeAllowlist,
    dataDir: ctx.config.dataDir,
  }, now: ctx.now }));
  worker.register('purge_attachment_file', 1, createPurgeAttachmentFileHandler({ db: ctx.db, now: ctx.now }));
  worker.register('reconcile_channel', ctx.config.ingestion.backfillConcurrency,
    createReconcileChannelHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now,
      overlapHours: ctx.config.ingestion.reconcileOverlapHours,
      maxPages: ctx.config.ingestion.reconcileMaxPagesPerRun, logger: ctx.logger }));
  worker.register('recover_message', ctx.config.ingestion.backfillConcurrency,
    createRecoverMessageHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now,
      observer: createIngestionObserver(ctx.counters) }));
  worker.register('close_episode', 1, createCloseEpisodeHandler({ db: ctx.db, timing: ctx.config.episodes, now: ctx.now, logger: ctx.logger }));
  worker.register('direct_answer', ctx.config.agentRuntime.maxConcurrency, createDirectAnswerHandler({
    db: ctx.db, guildId: ctx.config.discord.guildId, promptCompiler: () => snapshot().promptCompiler,
    channelPolicyYml: () => snapshot().channelPolicyYml, cassandraYml: safeRead(ctx.config.cassandraConfigPath),
    systemPrompt, resolveChannelScope: scope, rateChecks: (channelId, content, now) => recentChecks(ctx, channelId, content, now),
    mode: () => ctx.config.mode, agent, docs: docsIndex, executeRun: gatedExecute, now: ctx.now, limits, logger: ctx.logger,
  }));
  worker.register('deep_recap', 1, createDeepRecapHandler({
    db: ctx.db,
    guildId: ctx.config.discord.guildId,
    promptCompiler: () => snapshot().promptCompiler,
    systemPrompt,
    resolveChannelScope: scope,
    rateChecks: (channelId, content, now) => recentChecks(ctx, channelId, content, now),
    executeRun: gatedExecute,
    agent,
    mode: () => ctx.config.mode,
    enabled: ctx.config.deepRecap.enabled,
    dailyBudgetUsd: ctx.config.deepRecap.dailyBudgetUsd,
    dayStartMs: (now) => orgDayStartMs(now, ctx.config.organization.timezone),
    now: ctx.now,
    limits,
    logger: ctx.logger,
  }));
  const reviewEpisode = createReviewEpisodeHandler({
    db: ctx.db, guildId: ctx.config.discord.guildId, cassandraId: ctx.config.discord.applicationId,
    promptCompiler: () => snapshot().promptCompiler, channelPolicyYml: () => snapshot().channelPolicyYml,
    cassandraYml: safeRead(ctx.config.cassandraConfigPath), systemPrompt,
    resolveChannelScope: (channelId) => {
      const s = scope(channelId);
      const channel = getChannel(ctx.db, channelId);
      return { grant: s.grant, target: { label: channel?.name ? `#${channel.name}` : channelId, visibility: s.target.visibility } };
    },
    runtimeCounters: (channelId, now) => {
      const channelPosts = Number((ctx.db.prepare("SELECT count(*) AS n FROM outbox WHERE channel_id = ? AND status = 'sent' AND sent_at_ms >= ?").get(channelId, now - 86_400_000) as { n: number }).n);
      const globalPosts = Number((ctx.db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'sent' AND sent_at_ms >= ?").get(now - 86_400_000) as { n: number }).n);
      return { recentChannelPosts: channelPosts, globalPostsToday: globalPosts };
    },
    mode: () => ctx.config.mode, interventionThreshold: ctx.config.intervention.threshold,
    agent, executeRun: gatedExecute, now: ctx.now, limits, logger: ctx.logger,
    episodeShadow,
    memoryMinimumConfidence: ctx.config.memory.minimumConfidence,
    memoryMinimumImportance: ctx.config.memory.minimumImportance,
    memoryFollowupHorizonDays: ctx.config.memory.followupHorizonDays,
    memoryFollowupMaxMessages: ctx.config.memory.followupMaxMessages,
    routeIntervention: (input) => routeEpisodeIntervention(ctx, client, reviewSecret, input),
  });
  worker.register('review_episode', ctx.config.agentRuntime.maxConcurrency, async (payload, job) => {
    const episode = ctx.db.prepare('SELECT origin, conversation_channel_id, historical_campaign_id FROM episodes WHERE id = ?').get(payload.episodeId) as
      | { origin: string; conversation_channel_id: string; historical_campaign_id: string | null }
      | undefined;
    const allowed = ctx.config.historicalMemory.channelIds;
    if (episode?.origin === 'historical' && campaign && episode.historical_campaign_id !== campaign.id) {
      throw new DeferJobError('legacy historical review held outside the active campaign', 5 * 60_000);
    }
    if (episode?.origin === 'historical' && campaign) {
      const current = getHistoricalCampaign(ctx.db, campaign.id);
      if (current?.status !== 'running') {
        throw new DeferJobError(`historical campaign is ${current?.status ?? 'missing'}`, 5 * 60_000);
      }
    }
    if (episode?.origin === 'historical' && allowed.length > 0 && !allowed.includes(episode.conversation_channel_id)) {
      throw new DeferJobError('historical review held outside configured channel allowlist', 5 * 60_000);
    }
    await reviewEpisode(payload, job);
  });
  if (ctx.config.reviewChannelId) {
    const routeOptions = () => ({
      guildId: ctx.config.discord.guildId,
      reviewChannelId: ctx.config.reviewChannelId!,
      reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
    });
    worker.register('review_due_memories', 1, async () => {
      createReviewDueMemoryDispatcherHandler({
        db: ctx.db,
        ...routeOptions(),
        now: ctx.now,
        logger: ctx.logger,
        stalenessHorizonMs: ctx.config.memory.stalenessHorizonDays * 86_400_000,
      }).dispatch();
    });
    const scheduledCohort = createReviewDueMemoryCohortHandler({
      db: ctx.db,
      ...routeOptions(),
      currentRouteOptions: routeOptions,
      base: {
        promptCompiler: () => snapshot().promptCompiler,
        channelPolicyYml: () => snapshot().channelPolicyYml,
        cassandraYml: safeRead(ctx.config.cassandraConfigPath),
        systemPrompt,
        mode: () => ctx.config.mode,
        agent,
        executeRun: gatedExecute,
        now: ctx.now,
        limits,
        logger: ctx.logger,
        memoryMinimumConfidence: ctx.config.memory.minimumConfidence,
        memoryMinimumImportance: ctx.config.memory.minimumImportance,
        scheduledReminderIntervalMs: ctx.config.memory.scheduledReviewReminderDays * 86_400_000,
      },
      resolveWorkingScope: (targetChannelId) => resolveScheduledWorkingScope(
        ctx.db,
        targetChannelId,
        ctx.config.reviewChannelId!,
      ),
      resolveSecureScope: () => resolveScheduledReviewScope(
        ctx.db,
        ctx.config.reviewChannelId!,
        snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      ),
      onPendingProposal: async (outcome) => {
        const proposal = getProposal(ctx.db, outcome.notification.proposalId);
        if (!proposal?.message) return;
        try {
          await deliverProposalReview(
            buildScheduledReviewPresentation(ctx.db, ctx.config.discord.guildId, proposal),
            { db: ctx.db, reviewChannelId: ctx.config.reviewChannelId!,
              channel: createDiscordReviewChannel(client), secret: reviewSecret, now: ctx.now() },
          );
        } catch (err) {
          setProposalStatus(ctx.db, proposal.id, 'failed', ctx.now());
          ctx.logger.warn({ event: 'scheduled_review.delivery_failed', proposalId: proposal.id,
            err: err instanceof Error ? err.message : String(err) }, 'scheduled proposal card delivery failed');
        }
      },
    });
    worker.register('review_due_memory_cohort', ctx.config.agentRuntime.maxConcurrency, scheduledCohort);
  } else {
    worker.register('review_due_memories', 1, async () => {
      ctx.logger.warn({ event: 'scheduled_review.no_secure_channel' }, 'scheduled memory review skipped: no secure review channel');
    });
    worker.register('review_due_memory_cohort', 1, async () => {
      ctx.logger.warn({ event: 'scheduled_review.no_secure_channel' }, 'scheduled memory cohort skipped: no secure review channel');
    });
  }
  const deliveryReviewResolver = ctx.config.reviewChannelId
    ? createDiscordReviewResolver(client, ctx.config.reviewChannelId)
    : undefined;
  const reportProposalDelivery = deliveryReviewResolver
    ? async (report: ProposalDeliveryReport) => {
        const proposal = getProposal(ctx.db, report.proposalId);
        if (!proposal?.reviewMessageId) return;
        const label = report.status === 'sent'
          ? `✅ Sent — [open notification](${sourceLinkUrl(
              ctx.config.discord.guildId,
              proposal.targetChannelId,
              report.discordMessageId,
            )})`
          : report.status === 'cancelled'
            ? '⏰ Expired — delivery cancelled before send'
            : '❌ Delivery failed';
        await deliveryReviewResolver({
          reviewMessageId: proposal.reviewMessageId,
          label,
          removeControls: true,
        });
      }
    : undefined;
  const sendOutbox = createSendOutboxHandler({
    db: ctx.db,
    sender: createDiscordSender(client),
    now: ctx.now,
    logger: ctx.logger,
    reportProposalDelivery,
    validateProposalSend: (proposalId, now) => {
      const recheck = buildApprovalRecheck(ctx, proposalId, now, {
        guildId: ctx.config.discord.guildId,
        reviewChannelId: ctx.config.reviewChannelId ?? '',
        reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      });
      const policy = recheckApprovalPolicy(recheck);
      const scheduled = recheck.scheduledDelivery;
      return scheduled && !scheduled.allow
        ? { allow: false, reasons: [...policy.reasons, ...scheduled.reasons] }
        : policy;
    },
  });
  worker.register('send_outbox', 1, async (payload, job) => {
    // A downgrade to observe is an immediate kill switch for unsolicited or
    // approved proposal sends. Explicit direct answers have no proposal_id and
    // remain available, as required by Section 26.
    if (ctx.config.mode === 'observe') {
      const row = ctx.db.prepare('SELECT proposal_id FROM outbox WHERE id = ?').get(payload.outboxId) as
        | { proposal_id: string | null }
        | undefined;
      if (row?.proposal_id) throw new DeferJobError('proposal send held while mode is observe', 60_000);
    }
    await sendOutbox(payload, job);
  });
  worker.register(
    'sync_proposal_review',
    1,
    reportProposalDelivery
      ? createProposalDeliverySyncHandler({ db: ctx.db, reporter: reportProposalDelivery })
      : async () => undefined,
  );
  const channelPolicyReviewPort = createDiscordChannelPolicyReviewPort(client);
  if (ctx.config.reviewChannelId) {
    worker.register('deliver_channel_policy_review', 1, createDeliverChannelPolicyReviewHandler({
      db: ctx.db,
      reviewChannelId: ctx.config.reviewChannelId,
      port: channelPolicyReviewPort,
      secret: reviewSecret,
      now: ctx.now,
    }));
  } else {
    worker.register('deliver_channel_policy_review', 1, async () => {
      throw new DeferJobError('channel policy review held without a secure review channel', 6 * 60 * 60_000);
    });
  }
  worker.register('backup_database', 1, createBackupDatabaseHandler({
    db: ctx.db,
    backupsDir: ctx.config.backupDir,
    sourceDatabasePath: ctx.config.databasePath,
    retentionDays: ctx.config.maintenance.backupRetentionDays,
    now: ctx.now,
    logger: ctx.logger,
    notifyCompleted: async ({ requesterUserId, file, bytes }) => {
      const user = await client.users.fetch(requesterUserId);
      await user.send({
        content: `Cassandra backup completed: ${file} (${bytes} bytes), integrity_check: ok.\n\nCassandra doesn't answer questions in DMs. Ask me in the Discord server by mentioning @Cassandra in a channel I can access.`,
        allowedMentions: { parse: [] },
      });
    },
  }));
  const maintenance = createDatabaseMaintenanceHandler({
    db: ctx.db,
    now: ctx.now,
    jobsRetentionDays: ctx.config.maintenance.jobsRetentionDays,
    onOutcome: (outcome) => {
      if (outcome.jobsPruned && outcome.jobsPruned.deleted > 0) {
        ctx.logger.info(
          { event: 'jobs.pruned', ...outcome.jobsPruned },
          'terminal job rows past retention were deleted',
        );
      }
    },
  });
  const expiry = createExpireProposalsHandler({ db: ctx.db, now: ctx.now, logger: ctx.logger });
  worker.register('maintenance', 1, async () => {
    await runPeriodicMaintenanceCycle({
      expireProposals: () => expiry.runExpiry(),
      expireStaleMemories: () => expireStaleMemories(ctx.db, {
        horizonMs: ctx.config.memory.stalenessHorizonDays * 86_400_000,
        actorUserId: ctx.config.discord.applicationId,
        guildId: ctx.config.discord.guildId,
        now: ctx.now(),
      }),
      maintainDatabase: () => maintenance.runDatabaseMaintenance(),
      repairDeepRecaps: () => repairDeepRecapOwnership(ctx.db, { now: ctx.now() }),
      logger: ctx.logger,
    });
  });
  worker.register('rescope_memories', 1, createRescopeMemoriesHandler({ db: ctx.db, guildId: ctx.config.discord.guildId,
    actorUserId: ctx.config.discord.applicationId, now: ctx.now }));
  worker.register('forget_user', 1, createForgetUserHandler({ db: ctx.db, guildId: ctx.config.discord.guildId,
    actorUserId: ctx.config.discord.applicationId, now: ctx.now, enqueue: (input) => enqueue(ctx.db, input) }));
  worker.register('discover_threads', ctx.config.ingestion.backfillConcurrency, async () => {
    const descriptors = await fetchDiscoveryDescriptors(client, ctx.config.discord.guildId);
    await runStartupSync({ db: ctx.db, guildId: ctx.config.discord.guildId, policy: snapshot().channelPolicy, now: ctx.now(),
      channelPolicySource: ctx.config.channelPolicySource,
      channels: descriptors, archiveSource: createDiscordThreadArchiveSource(client),
      canManageThreads: descriptors.some((d) => d.capabilities?.canManageThreads === true),
      enqueueHistoricalBackfill: ctx.config.ingestion.fullHistory, logger: ctx.logger });
  });

  const currentScheduledRouteOptions = () => ({
    guildId: ctx.config.discord.guildId,
    reviewChannelId: ctx.config.reviewChannelId ?? '',
    reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
  });
  registerCommandDispatcher({ ctx, discord, buildApprovalRecheck: (proposalId) =>
    buildApprovalRecheck(ctx, proposalId, ctx.now(), currentScheduledRouteOptions()) });
  const reviewButtons = createReviewButtonHandler({ db: ctx.db, secret: reviewSecret,
    adminRoleIds: ctx.config.adminRoleIds, buildRecheck: (proposalId) =>
      buildApprovalRecheck(ctx, proposalId, ctx.now(), currentScheduledRouteOptions()),
    resolveReview: ctx.config.reviewChannelId ? createDiscordReviewResolver(client, ctx.config.reviewChannelId) : undefined,
    now: ctx.now });
  const channelPolicyReviewButtons = ctx.config.reviewChannelId
      ? createChannelPolicyReviewButtonHandler({
        db: ctx.db,
        guildId: ctx.config.discord.guildId,
        secret: reviewSecret,
        adminRoleIds: ctx.config.adminRoleIds,
        policy: () => snapshot().channelPolicy,
        reviewChannelId: ctx.config.reviewChannelId,
        port: channelPolicyReviewPort,
        channelPolicySource: ctx.config.channelPolicySource,
        now: ctx.now,
      })
    : undefined;
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (interaction.isButton()) {
      void reviewButtons(interaction);
      if (channelPolicyReviewButtons) void channelPolicyReviewButtons(interaction);
    }
  });

  await reconcileOutboxSending(ctx.db, createDiscordRecentSentLookup(client, ctx.config.discord.applicationId), {
    now: ctx.now(),
    reportProposalDelivery,
    validateProposalSend: (proposalId, now) => {
      const recheck = buildApprovalRecheck(ctx, proposalId, now, currentScheduledRouteOptions());
      const policy = recheckApprovalPolicy(recheck);
      return recheck.scheduledDelivery && !recheck.scheduledDelivery.allow
        ? { allow: false, reasons: [...policy.reasons, ...recheck.scheduledDelivery.reasons] }
        : policy;
    },
    logger: ctx.logger,
  });
  const scheduler = new PeriodicScheduler(nodeTimerDriver, ctx.logger);
  // Schedules resume from durable job history, so a restart never resets the
  // 24-hour timers (Section 10); a due-memory review that is overdue fires
  // shortly after boot under its stable unique key.
  scheduler.start(buildSchedules(ctx.config, {
    enqueue: (input) => enqueue(ctx.db, input),
    channelIds: () => scheduledIngestionChannelIds(ctx.db),
    lastRunMs: (key, match) => lastScheduledRunMs(ctx.db, key, match),
  }));
  if (ctx.config.historicalMemory.enabled) {
    enqueue(ctx.db, {
      type: 'build_historical_episodes', payload: {}, uniqueKey: 'schedule:historical-memory',
      priority: 200, now: ctx.now(),
    });
  }
  worker.start();
  return { worker, scheduler, stop: async () => { scheduler.stop(); worker.stop(); await worker.waitForShutdown(); } };
}
