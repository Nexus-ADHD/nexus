import { hashPlaudTranscript, interpretPlaudTranscript } from './interpreter';
import type {
  PlaudImportEnvelope,
  PlaudImportProposal,
  PlaudImportSession,
  PlaudKeyValueStorage,
  PlaudTranscriptSource,
} from './types';

export const PLAUD_IMPORT_STORAGE_VERSION = 1 as const;
const STORAGE_PREFIX = 'nexus.plaudImport.v1';

function emptyEnvelope(): PlaudImportEnvelope {
  return { version: PLAUD_IMPORT_STORAGE_VERSION, sessions: [] };
}

export function plaudImportStorageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function isProposal(value: unknown): value is PlaudImportProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<PlaudImportProposal>;
  const evidence = proposal.evidence;
  const validEvidence =
    evidence === undefined ||
    (typeof evidence === 'object' &&
      evidence !== null &&
      Number.isInteger(evidence.segmentIndex) &&
      typeof evidence.quote === 'string' &&
      (evidence.startMs === undefined || typeof evidence.startMs === 'number'));
  return (
    typeof proposal.id === 'string' &&
    typeof proposal.proposalKey === 'string' &&
    (proposal.kind === 'task' || proposal.kind === 'product_idea' || proposal.kind === 'observation') &&
    typeof proposal.title === 'string' &&
    (proposal.status === 'pending' ||
      proposal.status === 'approved' ||
      proposal.status === 'captured' ||
      proposal.status === 'noted') &&
    validEvidence
  );
}

function isSession(value: unknown): value is PlaudImportSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<PlaudImportSession>;
  return (
    typeof session.id === 'string' &&
    typeof session.sourceId === 'string' &&
    typeof session.sourceTitle === 'string' &&
    typeof session.recordedAt === 'string' &&
    typeof session.transcriptHash === 'string' &&
    typeof session.importedAt === 'number' &&
    typeof session.updatedAt === 'number' &&
    Array.isArray(session.proposals) &&
    session.proposals.every(isProposal)
  );
}

function parseEnvelope(raw: string | null): PlaudImportEnvelope {
  if (!raw) return emptyEnvelope();
  try {
    const parsed = JSON.parse(raw) as Partial<PlaudImportEnvelope>;
    if (parsed.version !== PLAUD_IMPORT_STORAGE_VERSION || !Array.isArray(parsed.sessions)) {
      return emptyEnvelope();
    }
    return {
      version: PLAUD_IMPORT_STORAGE_VERSION,
      sessions: parsed.sessions.filter(isSession),
    };
  } catch {
    return emptyEnvelope();
  }
}

export async function loadPlaudImportEnvelope(
  storage: PlaudKeyValueStorage,
  ownerId: string,
): Promise<PlaudImportEnvelope> {
  return parseEnvelope(await storage.getItem(plaudImportStorageKey(ownerId)));
}

async function saveEnvelope(
  storage: PlaudKeyValueStorage,
  ownerId: string,
  envelope: PlaudImportEnvelope,
): Promise<void> {
  await storage.setItem(plaudImportStorageKey(ownerId), JSON.stringify(envelope));
}

export async function importPlaudTranscript(
  storage: PlaudKeyValueStorage,
  ownerId: string,
  source: PlaudTranscriptSource,
  now = Date.now(),
): Promise<PlaudImportSession> {
  return upsertPlaudImportSession(
    storage,
    ownerId,
    source,
    interpretPlaudTranscript(source),
    now,
  );
}

export async function upsertPlaudImportSession(
  storage: PlaudKeyValueStorage,
  ownerId: string,
  source: PlaudTranscriptSource,
  interpretedProposals: PlaudImportProposal[],
  now = Date.now(),
): Promise<PlaudImportSession> {
  const envelope = await loadPlaudImportEnvelope(storage, ownerId);
  const existing = envelope.sessions.find((session) => session.sourceId === source.id);
  // Approval is derived from the Inbox at read time (see withDerivedApproval),
  // so a re-import has nothing to carry forward: an approved proposal is still
  // approved because its Inbox task still exists, not because a status was
  // copied across. Persisting a status here would recreate the second copy this
  // feature deliberately does not keep.
  const proposals = interpretedProposals;

  const session: PlaudImportSession = {
    id: source.id,
    sourceId: source.id,
    sourceTitle: source.title,
    recordedAt: source.recordedAt,
    transcriptHash: hashPlaudTranscript(source.transcript),
    importedAt: existing?.importedAt ?? now,
    updatedAt: now,
    proposals,
  };

  await saveEnvelope(storage, ownerId, {
    version: PLAUD_IMPORT_STORAGE_VERSION,
    sessions: [session, ...envelope.sessions.filter((item) => item.sourceId !== source.id)],
  });
  return session;
}

export async function findCachedPlaudImportSession(
  storage: PlaudKeyValueStorage,
  ownerId: string,
  source: PlaudTranscriptSource,
): Promise<PlaudImportSession | null> {
  const transcriptHash = hashPlaudTranscript(source.transcript);
  const envelope = await loadPlaudImportEnvelope(storage, ownerId);
  return (
    envelope.sessions.find(
      (session) => session.sourceId === source.id && session.transcriptHash === transcriptHash,
    ) ?? null
  );
}

export async function clearPlaudImportData(
  storage: PlaudKeyValueStorage,
  ownerId: string,
): Promise<void> {
  await storage.removeItem(plaudImportStorageKey(ownerId));
}
