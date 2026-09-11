import { describe, it, expect } from 'vitest';
import {
  evaluateCooldowns,
  orgDayStartMs,
  nextOrgDayStartMs,
  DEFAULT_COOLDOWN_CONFIG,
  type CooldownConfig,
  type SentEvent,
} from '../../src/agent/cooldowns.js';

const NY = 'America/New_York';
const ms = (iso: string) => Date.parse(iso);

function cfg(over: Partial<CooldownConfig> = {}): CooldownConfig {
  return { ...DEFAULT_COOLDOWN_CONFIG, timeZone: NY, ...over };
}

function sent(
  channelId: string,
  sentAtIso: string,
  opts: { topic?: string; kind?: 'autonomous' | 'direct_answer' } = {},
): SentEvent {
  return {
    channelId,
    topicKey: opts.topic ?? null,
    kind: opts.kind ?? 'autonomous',
    sentAtMs: ms(sentAtIso),
  };
}

describe('organization-day boundaries across DST', () => {
  it('computes local midnight correctly on the US spring-forward day', () => {
    // 2024-03-10 in NY: 02:00 EST -> 03:00 EDT. Local midnight is 00:00 EST = 05:00Z.
    expect(orgDayStartMs(ms('2024-03-10T12:00:00-04:00'), NY)).toBe(ms('2024-03-10T05:00:00Z'));
  });

  it('computes local midnight on a normal summer day (EDT)', () => {
    expect(orgDayStartMs(ms('2024-06-10T12:00:00-04:00'), NY)).toBe(ms('2024-06-10T04:00:00Z'));
  });

  it('computes local midnight in a CET winter timezone', () => {
    expect(orgDayStartMs(ms('2024-01-10T12:00:00+01:00'), 'Europe/Berlin')).toBe(
      ms('2024-01-09T23:00:00Z'),
    );
  });

  it('buckets two sends into the same org-day and splits across midnight', () => {
    const a = ms('2024-06-10T03:30:00-04:00');
    const b = ms('2024-06-10T23:30:00-04:00');
    const c = ms('2024-06-11T00:30:00-04:00');
    expect(orgDayStartMs(a, NY)).toBe(orgDayStartMs(b, NY));
    expect(orgDayStartMs(b, NY)).not.toBe(orgDayStartMs(c, NY));
  });

  it('counts all hours of a 23-hour spring-forward day as one org-day', () => {
    // Both early-morning and late-night sends on the transition day share a boundary.
    const morning = ms('2024-03-10T00:30:00-05:00'); // 00:30 EST, before transition
    const night = ms('2024-03-10T23:30:00-04:00'); // 23:30 EDT, after transition
    expect(orgDayStartMs(morning, NY)).toBe(orgDayStartMs(night, NY));
  });

  it('finds the next organization-day boundary', () => {
    const now = ms('2024-06-10T12:00:00-04:00');
    expect(nextOrgDayStartMs(now, NY)).toBe(ms('2024-06-11T04:00:00Z'));
  });
});

describe('intervention cooldowns and daily limits', () => {
  it('blocks and then allows across the channel-cooldown boundary', () => {
    const last = sent('ch1', '2024-06-10T08:00:00-04:00');
    const config = cfg({ channelCooldownMinutes: 180 });

    const blocked = evaluateCooldowns(config, ms('2024-06-10T10:59:00-04:00'), [last], {
      channelId: 'ch1',
      topicKey: null,
      kind: 'autonomous',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks.some((b) => b.rule === 'channel_cooldown')).toBe(true);
    expect(blocked.retryAfterMs).toBe(ms('2024-06-10T11:00:00-04:00'));

    const allowed = evaluateCooldowns(config, ms('2024-06-10T11:00:00-04:00'), [last], {
      channelId: 'ch1',
      topicKey: null,
      kind: 'autonomous',
    });
    expect(allowed.allowed).toBe(true);
  });

  it('enforces the same-topic cooldown independently of the channel cooldown', () => {
    const config = cfg({ channelCooldownMinutes: 0, topicCooldownHours: 24 });
    const prior = sent('ch1', '2024-06-10T08:00:00-04:00', { topic: 'onboarding' });
    // Same topic within 24h is blocked even in a different channel.
    const blocked = evaluateCooldowns(config, ms('2024-06-10T20:00:00-04:00'), [prior], {
      channelId: 'ch2',
      topicKey: 'onboarding',
      kind: 'autonomous',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks[0]!.rule).toBe('topic_cooldown');
    // A different topic is allowed.
    const ok = evaluateCooldowns(config, ms('2024-06-10T20:00:00-04:00'), [prior], {
      channelId: 'ch2',
      topicKey: 'pricing',
      kind: 'autonomous',
    });
    expect(ok.allowed).toBe(true);
  });

  it('blocks the autonomous daily limit and resets at the next org-day', () => {
    const config = cfg({ globalDailyLimit: 2, channelCooldownMinutes: 0, topicCooldownHours: 0 });
    const day = ms('2024-06-10T06:00:00-04:00');
    const history: SentEvent[] = [
      sent('ch1', '2024-06-10T06:00:00-04:00'),
      sent('ch1', '2024-06-10T07:00:00-04:00'),
    ];

    const blocked = evaluateCooldowns(config, day, history, {
      channelId: 'ch9',
      topicKey: null,
      kind: 'autonomous',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocks[0]!.rule).toBe('autonomous_daily_limit');
    expect(blocked.retryAfterMs).toBe(ms('2024-06-11T04:00:00Z')); // next local midnight

    // After rolling into the next org-day, the counter resets.
    const next = evaluateCooldowns(config, ms('2024-06-11T06:00:00-04:00'), history, {
      channelId: 'ch9',
      topicKey: null,
      kind: 'autonomous',
    });
    expect(next.allowed).toBe(true);
  });

  it('excludes direct answers from the autonomous count but caps them separately', () => {
    const config = cfg({
      globalDailyLimit: 5,
      directAnswerDailyLimit: 2,
      channelCooldownMinutes: 0,
      topicCooldownHours: 0,
    });
    const t = '2024-06-10T06:00:00-04:00';
    // Five autonomous posts already today — the autonomous limit is saturated.
    const history: SentEvent[] = Array.from({ length: 5 }, (_, i) =>
      sent('ch1', `2024-06-10T0${i}:00:00-04:00`, { kind: 'autonomous' }),
    );

    // A direct answer is NOT blocked by the autonomous daily limit…
    const direct = evaluateCooldowns(config, ms(t), history, {
      channelId: 'ch1',
      topicKey: null,
      kind: 'direct_answer',
    });
    expect(direct.allowed).toBe(true);

    // …but it has its own limit.
    const directHistory: SentEvent[] = [
      ...history,
      sent('ch1', '2024-06-10T05:30:00-04:00', { kind: 'direct_answer' }),
      sent('ch1', '2024-06-10T05:45:00-04:00', { kind: 'direct_answer' }),
    ];
    const blockedDirect = evaluateCooldowns(config, ms(t), directHistory, {
      channelId: 'ch1',
      topicKey: null,
      kind: 'direct_answer',
    });
    expect(blockedDirect.allowed).toBe(false);
    expect(blockedDirect.blocks[0]!.rule).toBe('direct_answer_daily_limit');
  });

  it('does not gate direct answers on the channel or topic cooldown', () => {
    const config = cfg({ channelCooldownMinutes: 180, topicCooldownHours: 24 });
    const prior = sent('ch1', '2024-06-10T08:00:00-04:00', { topic: 'onboarding' });
    const direct = evaluateCooldowns(config, ms('2024-06-10T08:05:00-04:00'), [prior], {
      channelId: 'ch1',
      topicKey: 'onboarding',
      kind: 'direct_answer',
    });
    expect(direct.allowed).toBe(true);
  });

  it('reports retry-after as the latest-clearing block when several apply', () => {
    const config = cfg({ channelCooldownMinutes: 30, globalDailyLimit: 1, topicCooldownHours: 0 });
    const history: SentEvent[] = [
      sent('ch1', '2024-06-10T08:00:00-04:00'), // channel cooldown + counts toward daily limit
    ];
    const blocked = evaluateCooldowns(config, ms('2024-06-10T08:10:00-04:00'), history, {
      channelId: 'ch1',
      topicKey: null,
      kind: 'autonomous',
    });
    expect(blocked.allowed).toBe(false);
    // Channel cooldown clears at 08:30; daily limit clears at next midnight.
    expect(blocked.retryAfterMs).toBe(ms('2024-06-11T04:00:00Z'));
  });
});
