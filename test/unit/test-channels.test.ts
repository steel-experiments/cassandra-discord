import { describe, expect, it } from 'vitest';
import { isCassandraTestChannelName } from '../../src/discord/test-channels.js';

describe('Cassandra test channels', () => {
  it('matches cassandra anywhere in a channel name, case-insensitively', () => {
    expect(isCassandraTestChannelName('cassandra-test')).toBe(true);
    expect(isCassandraTestChannelName('qa-CASSANDRA-sandbox')).toBe(true);
    expect(isCassandraTestChannelName('product')).toBe(false);
    expect(isCassandraTestChannelName(null)).toBe(false);
  });
});
