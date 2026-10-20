import { describe, expect, it } from 'vitest';
import {
  normalizeLivePlaudInterpretation,
  serializeLivePlaudSegmentsForPrompt,
} from '../live-interpreter-core';
import { hashPlaudTranscript } from '../interpreter';
import type { PlaudTranscriptSource } from '../types';

const SOURCE: PlaudTranscriptSource = {
  id: 'reviewed-live-recording',
  provider: 'plaud',
  title: 'Reviewed live recording',
  recordedAt: '2026-08-14T00:00:00.000Z',
  transcript: [
    '[0|0] We need to finish the thumbnail and intro concept.',
    '[1|1000] Upload onboarding.',
    '[2|2000] Continue content cutting.',
    '[3|3000] Make the reviewed PLAUD import flow part of Nexus.',
    '[4|4000] The operating system is becoming the product layer.',
  ].join('\n'),
  segments: [
    { index: 0, startMs: 0, content: 'We need to finish the thumbnail and intro concept.' },
    { index: 1, startMs: 1000, content: 'Upload onboarding.' },
    { index: 2, startMs: 2000, content: 'Continue content cutting.' },
    { index: 3, startMs: 3000, content: 'Make the reviewed PLAUD import flow part of Nexus.' },
    { index: 4, startMs: 4000, content: 'The operating system is becoming the product layer.' },
  ],
};

const MODEL_OUTPUT = {
  proposals: [
    { kind: 'task', title: 'Finish the thumbnail and intro concept', detail: null, evidence_segment: 0, evidence_quote: 'finish the thumbnail and intro concept' },
    { kind: 'task', title: 'Upload onboarding', detail: null, evidence_segment: 1, evidence_quote: 'Upload onboarding.' },
    { kind: 'task', title: 'Continue content cutting', detail: null, evidence_segment: 2, evidence_quote: 'Continue content cutting.' },
    { kind: 'product_idea', title: 'Reviewed PLAUD import flow', detail: 'Bring reviewed imports into Nexus.', evidence_segment: 3, evidence_quote: 'reviewed PLAUD import flow' },
    { kind: 'observation', title: 'Operating system as product layer', detail: null, evidence_segment: 4, evidence_quote: 'The operating system is becoming the product layer.' },
  ],
};

describe('live PLAUD interpretation contract', () => {
  it('keeps the reviewed three tasks, product idea, and non-task observation', () => {
    const { proposals, omittedProposalCount } = normalizeLivePlaudInterpretation(
      SOURCE,
      MODEL_OUTPUT,
    );
    const tasks = proposals.filter((proposal) => proposal.kind === 'task');
    expect(tasks.map((proposal) => proposal.title)).toEqual([
      'Finish the thumbnail and intro concept',
      'Upload onboarding',
      'Continue content cutting',
    ]);
    expect(proposals.filter((proposal) => proposal.kind === 'product_idea')).toHaveLength(1);
    expect(proposals.filter((proposal) => proposal.kind === 'observation')).toHaveLength(1);
    expect(tasks.some((proposal) => proposal.evidence?.segmentIndex === 4)).toBe(false);
    expect(omittedProposalCount).toBe(0);
  });

  it('derives identity from evidence instead of generated title or order', () => {
    const first = normalizeLivePlaudInterpretation(SOURCE, MODEL_OUTPUT).proposals;
    const revised = normalizeLivePlaudInterpretation(SOURCE, {
      proposals: [
        { ...MODEL_OUTPUT.proposals[1], title: 'Put onboarding online' },
        MODEL_OUTPUT.proposals[0],
      ],
    }).proposals;
    expect(revised[0].id).toBe(first[1].id);
    expect(revised[1].id).toBe(first[0].id);
  });

  it('rejects output when no proposal has grounded evidence', () => {
    expect(() =>
      normalizeLivePlaudInterpretation(SOURCE, {
        proposals: [{ ...MODEL_OUTPUT.proposals[0], evidence_quote: 'not in transcript' }],
      }),
    ).toThrow(/No reviewable/);
    expect(() =>
      normalizeLivePlaudInterpretation(SOURCE, {
        proposals: [{ ...MODEL_OUTPUT.proposals[0], evidence_quote: '...' }],
      }),
    ).toThrow(/No reviewable/);
    expect(() => normalizeLivePlaudInterpretation(SOURCE, { proposals: [{ kind: 'task' }] })).toThrow(/malformed/);
  });

  it('grounds punctuation and smart-apostrophe differences to exact source text', () => {
    const source: PlaudTranscriptSource = {
      ...SOURCE,
      segments: [{ index: 9, content: 'We’re shipping “PLAUD”, today.' }],
    };
    const result = normalizeLivePlaudInterpretation(source, {
      proposals: [{
        kind: 'task',
        title: 'Ship PLAUD',
        detail: null,
        evidence_segment: 9,
        evidence_quote: "We're shipping PLAUD today",
      }],
    });
    expect(result.proposals[0].evidence).toEqual({
      segmentIndex: 9,
      quote: 'We’re shipping “PLAUD”, today',
    });
  });

  it('recovers a wrong segment index only for a unique multi-word quote', () => {
    const result = normalizeLivePlaudInterpretation(SOURCE, {
      proposals: [{ ...MODEL_OUTPUT.proposals[2], evidence_segment: 2000 }],
    });
    expect(result.proposals[0].evidence?.segmentIndex).toBe(2);

    expect(() => normalizeLivePlaudInterpretation(SOURCE, {
      proposals: [{
        ...MODEL_OUTPUT.proposals[1],
        evidence_segment: 2000,
        evidence_quote: 'onboarding',
      }],
    })).toThrow(/No reviewable/);
  });

  it('prefers a valid declared segment and rejects ambiguous recovery', () => {
    const source: PlaudTranscriptSource = {
      ...SOURCE,
      segments: [
        ...(SOURCE.segments ?? []),
        { index: 5, startMs: 5000, content: 'Upload onboarding after review.' },
      ],
    };
    const declared = normalizeLivePlaudInterpretation(source, {
      proposals: [MODEL_OUTPUT.proposals[1]],
    });
    expect(declared.proposals[0].evidence?.segmentIndex).toBe(1);

    expect(() => normalizeLivePlaudInterpretation(source, {
      proposals: [{ ...MODEL_OUTPUT.proposals[1], evidence_segment: 99 }],
    })).toThrow(/No reviewable/);
  });

  it('keeps grounded proposals and reports individually omitted evidence', () => {
    const result = normalizeLivePlaudInterpretation(SOURCE, {
      proposals: [
        MODEL_OUTPUT.proposals[0],
        { ...MODEL_OUTPUT.proposals[1], evidence_quote: 'invented onboarding evidence' },
      ],
    });
    expect(result.proposals.map((proposal) => proposal.title)).toEqual([
      'Finish the thumbnail and intro concept',
    ]);
    expect(result.omittedProposalCount).toBe(1);
  });

  it('serializes unambiguous segment ids without changing persisted transcript identity', () => {
    const hash = hashPlaudTranscript(SOURCE.transcript);
    const serialized = serializeLivePlaudSegmentsForPrompt(SOURCE);
    expect(JSON.parse(serialized)[0]).toEqual({
      segment_id: 0,
      text: 'We need to finish the thumbnail and intro concept.',
    });
    expect(hashPlaudTranscript(SOURCE.transcript)).toBe(hash);
  });
});
