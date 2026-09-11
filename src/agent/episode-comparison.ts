export type EpisodeOutcomeCategory = 'silent' | 'memory' | 'important';

export interface ComparableEpisodeProposal {
  consequential?: boolean;
  memoryProposals?: Array<{ type?: string }>;
  intervention?: { recommend?: boolean };
}

export interface EpisodeProposalSummary {
  category: EpisodeOutcomeCategory;
  consequential: boolean;
  memoryCount: number;
  memoryTypes: string[];
  interventionRecommended: boolean;
}

export interface EpisodeShadowComparison {
  version: 1;
  authoritative: EpisodeProposalSummary;
  shadow: EpisodeProposalSummary | null;
  categoryMatch: boolean;
}

export function categorizeEpisodeProposal(
  proposal: ComparableEpisodeProposal,
): EpisodeOutcomeCategory {
  if (proposal.consequential === true || proposal.intervention?.recommend === true) {
    return 'important';
  }
  if (Array.isArray(proposal.memoryProposals) && proposal.memoryProposals.length > 0) {
    return 'memory';
  }
  return 'silent';
}

/** Content-minimized shape for automatic baseline/candidate comparison. */
export function summarizeEpisodeProposal(
  proposal: ComparableEpisodeProposal | null,
): EpisodeProposalSummary | null {
  if (!proposal) return null;
  const memories = Array.isArray(proposal.memoryProposals) ? proposal.memoryProposals : [];
  return {
    category: categorizeEpisodeProposal(proposal),
    consequential: proposal.consequential === true,
    memoryCount: memories.length,
    memoryTypes: memories.flatMap((memory) =>
      typeof memory.type === 'string' ? [memory.type] : []),
    interventionRecommended: proposal.intervention?.recommend === true,
  };
}

export function compareEpisodeProposals(
  authoritative: ComparableEpisodeProposal,
  shadow: ComparableEpisodeProposal | null,
): EpisodeShadowComparison {
  const authoritativeSummary = summarizeEpisodeProposal(authoritative)!;
  const shadowSummary = summarizeEpisodeProposal(shadow);
  return {
    version: 1,
    authoritative: authoritativeSummary,
    shadow: shadowSummary,
    categoryMatch: shadowSummary?.category === authoritativeSummary.category,
  };
}
