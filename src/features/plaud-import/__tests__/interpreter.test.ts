import { describe, expect, it } from 'vitest';
import { REVIEWED_PLAUD_TRANSCRIPT_FIXTURE } from '../fixture';
import { interpretPlaudTranscript } from '../interpreter';

describe('interpretPlaudTranscript', () => {
  it('returns the reviewed tasks, product idea, and non-actionable observation', () => {
    const proposals = interpretPlaudTranscript(REVIEWED_PLAUD_TRANSCRIPT_FIXTURE);
    const tasks = proposals.filter((proposal) => proposal.kind === 'task');

    expect(tasks.map((proposal) => proposal.title)).toEqual([
      'Finish the thumbnail and intro concept',
      'Upload onboarding',
      'Continue content cutting',
    ]);
    expect(proposals.filter((proposal) => proposal.kind === 'product_idea')).toHaveLength(1);
    expect(proposals.filter((proposal) => proposal.kind === 'observation')).toHaveLength(1);
    expect(
      tasks.some((proposal) =>
        `${proposal.title} ${proposal.detail ?? ''}`.toLowerCase().includes('operating system'),
      ),
    ).toBe(false);
  });

  it('ignores unlabelled transcript text instead of guessing', () => {
    expect(
      interpretPlaudTranscript({
        ...REVIEWED_PLAUD_TRANSCRIPT_FIXTURE,
        transcript: 'The operating system is becoming the product layer.',
      }),
    ).toEqual([]);
  });
});
