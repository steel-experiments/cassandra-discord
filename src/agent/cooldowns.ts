/**
 * Intervention cooldown and daily-limit policy (Sections 24.2, 24.4, 26).
 *
 * Pure functions over durable "sent" history: given the recent outbound sends
 * and a candidate, decide whether the candidate is allowed and, if not, when it
 * may retry. All time windows are measured in the configured organization
 * timezone so the per-day counter rolls over at local midnight (correct across
 * daylight-saving transitions). Direct answers are excluded from the autonomous
 * daily count but carry their own per-day limit (Section 24.4: "Explicit direct
 * questions do not count as autonomous interventions, but rate limits still
 * apply").
 */

export type OutboundKind = 'autonomous' | 'direct_answer';

export interface CooldownConfig {
  /** Minimum gap between autonomous posts to the same channel (Section 24.4). */
  channelCooldownMinutes: number;
  /** Minimum gap between autonomous posts on the same topic/memory (Section 24.4). */
  topicCooldownHours: number;
  /** Max autonomous posts per organization day (Section 24.4). */
  globalDailyLimit: number;
  /** Max direct-answer posts per organization day (their own rate limit). */
  directAnswerDailyLimit: number;
  /** IANA timezone for organization-day boundaries. */
  timeZone: string;
}

export const DEFAULT_COOLDOWN_CONFIG: CooldownConfig = {
  channelCooldownMinutes: 180,
  topicCooldownHours: 24,
  globalDailyLimit: 5,
  directAnswerDailyLimit: 30,
  timeZone: 'UTC',
};

export interface SentEvent {
  channelId: string;
  /** Normalized topic/memory dedupe key, or null when none. */
  topicKey: string | null;
  kind: OutboundKind;
  sentAtMs: number;
}

export interface CooldownCandidate {
  channelId: string;
  topicKey: string | null;
  kind: OutboundKind;
}

export type CooldownRule =
  | 'channel_cooldown'
  | 'topic_cooldown'
  | 'autonomous_daily_limit'
  | 'direct_answer_daily_limit';

export interface CooldownBlock {
  rule: CooldownRule;
  /** Epoch ms when this rule stops blocking, or null if it never resets here. */
  retryAfterMs: number | null;
  detail: string;
}

export interface CooldownDecision {
  allowed: boolean;
  blocks: CooldownBlock[];
  /** Earliest retry time across all blocks, or null when allowed. */
  retryAfterMs: number | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Timezone offset (tz − UTC) in milliseconds valid at `epochMs`, parsed from
 * ICU's `longOffset` form (e.g. "GMT-05:00"). Returns 0 for UTC.
 */
function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(epochMs));
  const token = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  if (token === 'GMT') return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(token);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const v = Number(m[2]) * 3600 + Number(m[3]) * 60 + (m[4] ? Number(m[4]) : 0);
  return sign * v * 1000;
}

/**
 * Epoch ms of local midnight (00:00) beginning the organization day that
 * contains `epochMs` in `timeZone`. Correct across daylight-saving transitions:
 * it solves the fixed point `instant = wallMidnight − offset(instant)`.
 */
export function orgDayStartMs(epochMs: number, timeZone: string): number {
  const off = timeZoneOffsetMs(epochMs, timeZone);
  const wallEpoch = epochMs + off;
  const d = new Date(wallEpoch);
  const wallMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let instant = wallMidnight - off;
  for (let i = 0; i < 3; i++) {
    instant = wallMidnight - timeZoneOffsetMs(instant, timeZone);
  }
  return instant;
}

/** Epoch ms of the next organization-day boundary strictly after `epochMs`. */
export function nextOrgDayStartMs(epochMs: number, timeZone: string): number {
  const today = orgDayStartMs(epochMs, timeZone);
  // Walk forward in 6-hour steps until the day boundary changes. Any real day is
  // ≤ 25h, so this terminates within a handful of steps regardless of DST.
  let probe = epochMs + 6 * HOUR_MS;
  let guard = 0;
  while (orgDayStartMs(probe, timeZone) === today && guard < 8) {
    probe += 6 * HOUR_MS;
    guard += 1;
  }
  return orgDayStartMs(probe, timeZone);
}

/** Earliest time ALL blocks have cleared — when the candidate could next succeed. */
function nextPossibleSuccessMs(blocks: CooldownBlock[]): number | null {
  const times = blocks
    .map((b) => b.retryAfterMs)
    .filter((t): t is number => t !== null);
  if (times.length === 0) return null;
  // A candidate is allowed only when every blocking rule has cleared, so the
  // soonest it can succeed is the latest single-block clearing time.
  return Math.max(...times);
}

/**
 * Evaluate the cooldown and daily-limit rules for one candidate against the
 * recent `history`. Autonomous candidates are gated by channel cooldown, topic
 * cooldown, and the autonomous daily limit; direct answers are gated only by
 * their own daily limit and are excluded from the autonomous count.
 */
export function evaluateCooldowns(
  config: CooldownConfig,
  nowMs: number,
  history: readonly SentEvent[],
  candidate: CooldownCandidate,
): CooldownDecision {
  const blocks: CooldownBlock[] = [];

  if (candidate.kind === 'autonomous') {
    const channelCutoff = nowMs - config.channelCooldownMinutes * MINUTE_MS;
    const lastInChannel = history
      .filter(
        (e) => e.kind === 'autonomous' && e.channelId === candidate.channelId && e.sentAtMs > channelCutoff,
      )
      .map((e) => e.sentAtMs)
      .sort((a, b) => b - a)[0];
    if (lastInChannel !== undefined) {
      const retryAfter = lastInChannel + config.channelCooldownMinutes * MINUTE_MS;
      blocks.push({
        rule: 'channel_cooldown',
        retryAfterMs: retryAfter,
        detail: `channel ${candidate.channelId} is on cooldown until ${new Date(retryAfter).toISOString()}`,
      });
    }

    if (candidate.topicKey) {
      const topicCutoff = nowMs - config.topicCooldownHours * HOUR_MS;
      const lastOnTopic = history
        .filter(
          (e) =>
            e.kind === 'autonomous' &&
            e.topicKey === candidate.topicKey &&
            e.sentAtMs > topicCutoff,
        )
        .map((e) => e.sentAtMs)
        .sort((a, b) => b - a)[0];
      if (lastOnTopic !== undefined) {
        const retryAfter = lastOnTopic + config.topicCooldownHours * HOUR_MS;
        blocks.push({
          rule: 'topic_cooldown',
          retryAfterMs: retryAfter,
          detail: `topic ${candidate.topicKey} was posted within ${config.topicCooldownHours}h`,
        });
      }
    }

    const dayStart = orgDayStartMs(nowMs, config.timeZone);
    const autonomousToday = history.filter(
      (e) => e.kind === 'autonomous' && orgDayStartMs(e.sentAtMs, config.timeZone) === dayStart,
    ).length;
    if (autonomousToday >= config.globalDailyLimit) {
      blocks.push({
        rule: 'autonomous_daily_limit',
        retryAfterMs: nextOrgDayStartMs(nowMs, config.timeZone),
        detail: `autonomous daily limit (${config.globalDailyLimit}/org-day) reached`,
      });
    }
  } else {
    const dayStart = orgDayStartMs(nowMs, config.timeZone);
    const directToday = history.filter(
      (e) => e.kind === 'direct_answer' && orgDayStartMs(e.sentAtMs, config.timeZone) === dayStart,
    ).length;
    if (directToday >= config.directAnswerDailyLimit) {
      blocks.push({
        rule: 'direct_answer_daily_limit',
        retryAfterMs: nextOrgDayStartMs(nowMs, config.timeZone),
        detail: `direct-answer daily limit (${config.directAnswerDailyLimit}/org-day) reached`,
      });
    }
  }

  if (blocks.length === 0) {
    return { allowed: true, blocks: [], retryAfterMs: null };
  }
  return { allowed: false, blocks, retryAfterMs: nextPossibleSuccessMs(blocks) };
}
