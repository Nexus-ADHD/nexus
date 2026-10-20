import { describe, expect, it } from 'vitest';
import {
  buildPlaudInboxApproval,
  taskProposalsForBulkApproval,
  withDerivedApproval,
} from '../approval';
import type { PlaudImportProposal } from '../types';
import { interpretPlaudTranscript } from '../interpreter';
import { REVIEWED_PLAUD_TRANSCRIPT_FIXTURE } from '../fixture';

describe('PLAUD proposal approval', () => {
  const proposals = interpretPlaudTranscript(REVIEWED_PLAUD_TRANSCRIPT_FIXTURE);

  it('builds Inbox input only for pending task proposals', () => {
    const task = proposals.find((proposal) => proposal.kind === 'task')!;
    const productIdea = proposals.find((proposal) => proposal.kind === 'product_idea')!;
    const observation = proposals.find((proposal) => proposal.kind === 'observation')!;

    expect(buildPlaudInboxApproval(task)).toEqual({
      title: 'Finish the thumbnail and intro concept',
      options: {
        source: 'manual',
        status: 'NEW',
        proposalKey: 'plaud:reviewed-import-flow-v1:thumbnail-intro',
      },
    });
    expect(buildPlaudInboxApproval(productIdea)).toBeNull();
    expect(buildPlaudInboxApproval(observation)).toBeNull();
  });

  it('reverses bulk approval input to preserve prepend order', () => {
    expect(taskProposalsForBulkApproval(proposals).map((proposal) => proposal.id)).toEqual([
      'content-cutting',
      'onboarding-upload',
      'thumbnail-intro',
    ]);
  });
});

describe('deriving approval from the Inbox', () => {
  const KEY = 'plaud:rec-1:item-1';
  const task = (over: Partial<PlaudImportProposal> = {}): PlaudImportProposal => ({
    id: 'p1',
    proposalKey: KEY,
    kind: 'task',
    title: 'Ship it',
    status: 'pending',
    ...over,
  });

  it('reads a proposal as approved when a task carries its key', () => {
    const [result] = withDerivedApproval(
      [task({ status: 'pending' })],
      [{ id: 'task-1', proposalKey: KEY }],
    );
    expect(result.status).toBe('approved');
    expect(result.inboxTaskId).toBe('task-1');
  });

  it('reads a proposal as pending once no task carries its key', () => {
    const [result] = withDerivedApproval(
      [task({ status: 'approved', approvedAt: 123, inboxTaskId: 'gone-1' })],
      [{ id: 'unrelated', proposalKey: 'plaud:rec-1:other' }],
    );
    expect(result.status).toBe('pending');
    expect(result.inboxTaskId).toBeUndefined();
    expect(result.approvedAt).toBeUndefined();
  });

  it('repoints a stale inboxTaskId at the task actually carrying the key', () => {
    const [result] = withDerivedApproval(
      [task({ status: 'approved', inboxTaskId: 'old-1' })],
      [{ id: 'current-1', proposalKey: KEY }],
    );
    expect(result.inboxTaskId).toBe('current-1');
  });

  it('returns the same array instance when the derivation matches, so renders stay cheap', () => {
    const proposals = [task({ status: 'approved', inboxTaskId: 'task-1' })];
    expect(
      withDerivedApproval(proposals, [{ id: 'task-1', proposalKey: KEY }]),
    ).toBe(proposals);
  });

  it('leaves non-task proposals untouched', () => {
    const proposals: PlaudImportProposal[] = [
      { id: 'i1', proposalKey: 'plaud:rec-1:idea', kind: 'product_idea', title: 'A', status: 'captured' },
      { id: 'o1', proposalKey: 'plaud:rec-1:obs', kind: 'observation', title: 'B', status: 'noted' },
    ];
    expect(withDerivedApproval(proposals, [])).toBe(proposals);
  });
});
