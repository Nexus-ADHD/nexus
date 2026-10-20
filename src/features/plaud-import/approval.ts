import type { PlaudImportProposal } from './types';
import type { ProposalKeyedInboxTask } from '../../state/prepend-inbox-task';

export type PlaudInboxApproval = {
  title: string;
  options: {
    source: 'manual';
    status: 'NEW';
    proposalKey: string;
  };
};

export function buildPlaudInboxApproval(
  proposal: PlaudImportProposal,
): PlaudInboxApproval | null {
  if (proposal.kind !== 'task' || proposal.status === 'approved') return null;
  return {
    title: proposal.title,
    options: {
      source: 'manual',
      status: 'NEW',
      proposalKey: proposal.proposalKey,
    },
  };
}

/**
 * Projects task-proposal approval state out of the Inbox.
 *
 * Approval is **derived, never stored**. A task proposal is approved if and
 * only if an Inbox task carrying its proposal key exists right now; the
 * `status` and `inboxTaskId` that arrive from persisted storage are ignored
 * for task proposals and recomputed here.
 *
 * That is the whole point: the PLAUD envelope and the Inbox are separately
 * persisted stores with no shared transaction, so anything that mirrors
 * approval into both can drift — a crash between the two writes, a
 * non-durable write, or an Inbox task deleted from another screen. Deriving
 * removes the second copy, so there is nothing left to disagree.
 *
 * `product_idea` and `observation` proposals carry no approval state and are
 * returned untouched.
 *
 * @returns the same array instance when nothing changed, so callers can render
 *   and memoise without allocating on every pass.
 */
export function withDerivedApproval<T extends ProposalKeyedInboxTask>(
  proposals: PlaudImportProposal[],
  inbox: T[],
): PlaudImportProposal[] {
  const taskIdByKey = new Map<string, string>();
  for (const task of inbox) {
    if (task.proposalKey && !taskIdByKey.has(task.proposalKey)) {
      taskIdByKey.set(task.proposalKey, task.id);
    }
  }

  let changed = false;
  const next = proposals.map((proposal) => {
    if (proposal.kind !== 'task') return proposal;
    const liveTaskId = taskIdByKey.get(proposal.proposalKey);

    if (liveTaskId) {
      if (proposal.status === 'approved' && proposal.inboxTaskId === liveTaskId) return proposal;
      changed = true;
      return { ...proposal, status: 'approved' as const, inboxTaskId: liveTaskId };
    }
    if (proposal.status === 'approved' || proposal.inboxTaskId !== undefined) {
      changed = true;
      const { approvedAt: _approvedAt, inboxTaskId: _inboxTaskId, ...rest } = proposal;
      return { ...rest, status: 'pending' as const };
    }
    return proposal;
  });

  return changed ? next : proposals;
}

/** addInboxTask prepends, so callers approve this reversed list to preserve display order. */
export function taskProposalsForBulkApproval(
  proposals: PlaudImportProposal[],
): PlaudImportProposal[] {
  return proposals
    .filter((proposal) => proposal.kind === 'task' && proposal.status !== 'approved')
    .reverse();
}
