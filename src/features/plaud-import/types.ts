export type PlaudProposalKind = 'task' | 'product_idea' | 'observation';

export type PlaudProposalStatus = 'pending' | 'approved' | 'captured' | 'noted';

export interface PlaudTranscriptSegment {
  index: number;
  content: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
}

export interface PlaudTranscriptSource {
  id: string;
  provider: 'plaud';
  title: string;
  recordedAt: string;
  transcript: string;
  segments?: PlaudTranscriptSegment[];
}

export interface PlaudProposalEvidence {
  segmentIndex: number;
  quote: string;
  startMs?: number;
}

export interface PlaudImportProposal {
  id: string;
  proposalKey: string;
  kind: PlaudProposalKind;
  title: string;
  detail?: string;
  evidence?: PlaudProposalEvidence;
  status: PlaudProposalStatus;
  approvedAt?: number;
  inboxTaskId?: string;
}

export interface PlaudImportSession {
  id: string;
  sourceId: string;
  sourceTitle: string;
  recordedAt: string;
  transcriptHash: string;
  importedAt: number;
  updatedAt: number;
  proposals: PlaudImportProposal[];
}

export interface PlaudImportEnvelope {
  version: 1;
  sessions: PlaudImportSession[];
}

export interface PlaudKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
