export type ProposalKeyedInboxTask = {
  id: string;
  proposalKey?: string;
};

export type PrependInboxTaskResult<T> = {
  inbox: T[];
  id: string;
  created: boolean;
};

/**
 * Atomically resolves a proposal-backed Inbox insert against the latest list.
 * Plain tasks still prepend normally; proposal-backed tasks reuse the existing id.
 */
export function prependInboxTaskIdempotently<T extends ProposalKeyedInboxTask>(
  inbox: T[],
  candidate: T,
): PrependInboxTaskResult<T> {
  if (candidate.proposalKey) {
    const existing = inbox.find((task) => task.proposalKey === candidate.proposalKey);
    if (existing) return { inbox, id: existing.id, created: false };
  }

  return { inbox: [candidate, ...inbox], id: candidate.id, created: true };
}
