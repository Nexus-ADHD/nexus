import { describe, expect, it } from 'vitest';
import { REVIEWED_PLAUD_TRANSCRIPT_FIXTURE } from '../fixture';
import {
  importPlaudTranscript,
  loadPlaudImportEnvelope,
  plaudImportStorageKey,
  findCachedPlaudImportSession,
  upsertPlaudImportSession,
} from '../store';
import { withDerivedApproval } from '../approval';
import type { PlaudKeyValueStorage } from '../types';

function memoryStorage(): PlaudKeyValueStorage {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

describe('PLAUD import persistence', () => {
  it('upserts one source session without persisting an approval mirror', async () => {
    const storage = memoryStorage();
    const first = await importPlaudTranscript(
      storage,
      'owner-a',
      REVIEWED_PLAUD_TRANSCRIPT_FIXTURE,
      100,
    );
    const second = await importPlaudTranscript(
      storage,
      'owner-a',
      REVIEWED_PLAUD_TRANSCRIPT_FIXTURE,
      300,
    );
    const envelope = await loadPlaudImportEnvelope(storage, 'owner-a');

    expect(envelope.sessions).toHaveLength(1);
    expect(second.importedAt).toBe(100);
    expect(first.id).toBe(second.id);

    // Approval lives in the Inbox, so nothing about it is written here.
    const proposal = second.proposals.find((item) => item.id === 'thumbnail-intro')!;
    expect(proposal.status).toBe('pending');
    expect(proposal).not.toHaveProperty('inboxTaskId');
    expect(proposal).not.toHaveProperty('approvedAt');

    // ...and it still reads as approved while its task exists.
    const [derived] = withDerivedApproval(
      [proposal],
      [{ id: 'inbox-1', proposalKey: proposal.proposalKey }],
    );
    expect(derived).toMatchObject({ status: 'approved', inboxTaskId: 'inbox-1' });
  });

  it('isolates local review data by account', async () => {
    const storage = memoryStorage();
    await importPlaudTranscript(storage, 'owner-a', REVIEWED_PLAUD_TRANSCRIPT_FIXTURE, 100);

    expect(plaudImportStorageKey('owner-a')).not.toBe(plaudImportStorageKey('owner-b'));
    expect((await loadPlaudImportEnvelope(storage, 'owner-b')).sessions).toEqual([]);
  });

  it('fails soft on an unknown persisted version', async () => {
    const storage = memoryStorage();
    await storage.setItem(plaudImportStorageKey('owner-a'), JSON.stringify({ version: 99, sessions: [{}] }));

    expect((await loadPlaudImportEnvelope(storage, 'owner-a')).sessions).toEqual([]);
  });

  it('rephrases an evidence-backed title without disturbing derived approval', async () => {
    const storage = memoryStorage();
    const proposal = {
      id: 'task-evidence',
      proposalKey: 'plaud:source:task-evidence',
      kind: 'task' as const,
      title: 'Original title',
      status: 'pending' as const,
      evidence: { segmentIndex: 1, quote: 'do the work', startMs: 100 },
    };
    const source = { ...REVIEWED_PLAUD_TRANSCRIPT_FIXTURE, id: 'source' };
    await upsertPlaudImportSession(storage, 'owner-a', source, [proposal], 100);
    const updated = await upsertPlaudImportSession(
      storage,
      'owner-a',
      source,
      [{ ...proposal, title: 'Rephrased title' }],
      300,
    );

    expect(updated.proposals[0]).toMatchObject({ title: 'Rephrased title' });
    // The key is what carries approval across a rephrase, not the stored status.
    const [derived] = withDerivedApproval(updated.proposals, [
      { id: 'inbox-1', proposalKey: proposal.proposalKey },
    ]);
    expect(derived).toMatchObject({
      title: 'Rephrased title',
      status: 'approved',
      inboxTaskId: 'inbox-1',
    });
    await expect(findCachedPlaudImportSession(storage, 'owner-a', source)).resolves.toMatchObject({
      sourceId: 'source',
    });
  });
});
