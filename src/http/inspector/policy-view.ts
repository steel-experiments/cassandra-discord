export interface TerminalProposalView {
  message: string | null; reason: string | null; targetChannelId: string | null;
  confidence: number | null; urgency: string | null; citedMessageIds: string[];
  subjectMemoryIds: string[];
  episodeSummary: string | null;
  consequential: boolean | null;
  memoryProposals: Array<{
    action: string | null;
    type: string | null;
    statement: string | null;
    confidence: number | null;
    importance: number | null;
    durability: string | null;
    evidenceMessageIds: string[];
  }>;
}
function text(value: unknown, max = 2_000): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, 200).flatMap((item) => typeof item === 'string' ? [item.slice(0, 128)] : []) : [];
}
function episodeMemories(value: unknown): TerminalProposalView['memoryProposals'] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      action: text(row.action, 40),
      type: text(row.type, 40),
      statement: text(row.statement, 1_200),
      confidence: number(row.confidence),
      importance: number(row.importance),
      durability: text(row.durability, 40),
      evidenceMessageIds: ids(row.evidenceMessageIds).slice(0, 20),
    }];
  });
}
export function parseTerminalProposal(json: string | null | undefined, runType: string): TerminalProposalView | null {
  if (!json) return null;
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    root = parsed as Record<string, unknown>;
  } catch { return null; }
  const proposal = root.proposal && typeof root.proposal === 'object' && !Array.isArray(root.proposal)
    ? root.proposal as Record<string, unknown>
    : root;
  const nested = runType === 'episode' ? proposal.intervention
    : runType === 'scheduled_review' ? proposal.notification
      : proposal;
  if (nested !== undefined && nested !== null
    && (typeof nested !== 'object' || Array.isArray(nested))) return null;
  if ((nested === undefined || nested === null) && runType !== 'episode') return null;
  const value = (nested ?? {}) as Record<string, unknown>;
  return {
    message: text(value.message ?? value.answer), reason: text(value.reason, 500),
    targetChannelId: text(value.targetChannelId ?? value.target_channel_id, 128),
    confidence: number(value.confidence), urgency: text(value.urgency, 40),
    citedMessageIds: ids(value.evidenceMessageIds ?? value.citedMessageIds),
    subjectMemoryIds: ids(value.subjectMemoryIds),
    episodeSummary: runType === 'episode' ? text(proposal.episodeSummary, 1_600) : null,
    consequential: runType === 'episode' && typeof proposal.consequential === 'boolean'
      ? proposal.consequential
      : null,
    memoryProposals: runType === 'episode' ? episodeMemories(proposal.memoryProposals) : [],
  };
}
export function parsePolicyDecision(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 1
      ? value as Record<string, unknown>
      : null;
  } catch { return null; }
}
