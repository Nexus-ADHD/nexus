import type { PlaudTranscriptSource } from './types';

/**
 * Reviewed fixture syntax is deliberately explicit. This slice validates the
 * import and approval flow; it is not a general transcript classifier.
 */
export const REVIEWED_PLAUD_TRANSCRIPT_FIXTURE: PlaudTranscriptSource = {
  id: 'reviewed-import-flow-v1',
  provider: 'plaud',
  title: 'Reviewed PLAUD import flow',
  recordedAt: '2026-08-14T00:00:00.000Z',
  transcript: [
    'TASK thumbnail-intro | Finish the thumbnail and intro concept',
    'TASK onboarding-upload | Upload onboarding',
    'TASK content-cutting | Continue content cutting',
    'PRODUCT_IDEA reviewed-import-flow | Reviewed PLAUD import flow | Stage transcript-derived proposals for review before anything reaches Inbox.',
    'OBSERVATION operating-system | Operating system observation | The operating system is becoming the product layer. Keep this as context, not another task.',
  ].join('\n'),
};
