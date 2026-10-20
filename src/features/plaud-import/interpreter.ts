import type {
  PlaudImportProposal,
  PlaudProposalKind,
  PlaudTranscriptSource,
} from './types';

const ENTRY_RE = /^(TASK|PRODUCT_IDEA|OBSERVATION)\s+([a-z0-9-]+)\s*\|\s*([^|]+?)(?:\s*\|\s*(.+))?$/i;

const KIND_BY_LABEL: Record<string, PlaudProposalKind> = {
  TASK: 'task',
  PRODUCT_IDEA: 'product_idea',
  OBSERVATION: 'observation',
};

function initialStatus(kind: PlaudProposalKind): PlaudImportProposal['status'] {
  if (kind === 'product_idea') return 'captured';
  if (kind === 'observation') return 'noted';
  return 'pending';
}

export function hashPlaudTranscript(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function interpretPlaudTranscript(source: PlaudTranscriptSource): PlaudImportProposal[] {
  if (source.provider !== 'plaud' || !source.id.trim() || !source.transcript.trim()) return [];

  const proposals: PlaudImportProposal[] = [];
  const seenIds = new Set<string>();

  for (const rawLine of source.transcript.split(/\r?\n/)) {
    const match = rawLine.trim().match(ENTRY_RE);
    if (!match) continue;

    const kind = KIND_BY_LABEL[match[1].toUpperCase()];
    const itemId = match[2].toLowerCase();
    const title = match[3].trim();
    const detail = match[4]?.trim();
    if (!kind || !title || seenIds.has(itemId)) continue;

    seenIds.add(itemId);
    proposals.push({
      id: itemId,
      proposalKey: `plaud:${source.id}:${itemId}`,
      kind,
      title,
      ...(detail ? { detail } : {}),
      status: initialStatus(kind),
    });
  }

  return proposals;
}
