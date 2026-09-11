/**
 * Small rendering helpers shared by the agent tools (Section 22). Model-facing
 * text is rendered by the host so the model never sees raw rows; timestamps are
 * formatted by the host and ISO filter strings from the model are parsed and
 * validated by the host.
 */

/** Format an epoch-millisecond timestamp as UTC ISO 8601 for the model. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Parse an optional ISO timestamp from model arguments into epoch milliseconds.
 * Throws when the string is present but not a valid date so the model gets a
 * clear, correctable error rather than a silently widened (filterless) query.
 */
export function parseOptionalIso(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`"${name}" is not a valid ISO 8601 timestamp: ${value}`);
  }
  return ms;
}
