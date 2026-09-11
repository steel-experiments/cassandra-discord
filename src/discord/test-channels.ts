import type { DatabaseSync } from '../db/database.js';
import { getChannel } from '../db/repositories/channels.js';

/** Channels whose names contain "cassandra" are isolated test surfaces. */
export function isCassandraTestChannelName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.toLowerCase().includes('cassandra');
}

/**
 * Resolve the complete test surface: a Cassandra-named channel and every
 * normally named thread directly below it. Discord threads are one level deep.
 */
export function isCassandraTestSurface(db: DatabaseSync, channelId: string): boolean {
  const channel = getChannel(db, channelId);
  if (!channel) return false;
  if (isCassandraTestChannelName(channel.name)) return true;
  if (channel.is_thread !== 1 || channel.parent_id === null) return false;
  return isCassandraTestChannelName(getChannel(db, channel.parent_id)?.name);
}
