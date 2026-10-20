import type { PlaudKeyValueStorage, PlaudImportSession } from './types';
import type { PlaudRecording } from './plaud-mcp';
import { getPlaudTranscript } from './plaud-client';
import { interpretLivePlaudTranscript } from './live-interpreter';
import { findCachedPlaudImportSession, upsertPlaudImportSession } from './store';

export async function importLivePlaudRecording(
  storage: PlaudKeyValueStorage,
  ownerId: string,
  recording: PlaudRecording,
): Promise<{ session: PlaudImportSession; cached: boolean; omittedProposalCount: number }> {
  const source = await getPlaudTranscript(ownerId, recording);
  const cached = await findCachedPlaudImportSession(storage, ownerId, source);
  if (cached) return { session: cached, cached: true, omittedProposalCount: 0 };
  const interpretation = await interpretLivePlaudTranscript(source);
  const session = await upsertPlaudImportSession(
    storage,
    ownerId,
    source,
    interpretation.proposals,
  );
  return {
    session,
    cached: false,
    omittedProposalCount: interpretation.omittedProposalCount,
  };
}
