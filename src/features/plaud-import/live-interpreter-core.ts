import { hashPlaudTranscript } from './interpreter';
import type {
  PlaudImportProposal,
  PlaudProposalKind,
  PlaudTranscriptSegment,
  PlaudTranscriptSource,
} from './types';

export const PLAUD_MAX_PROPOSALS = 20;
const PLAUD_MAX_SOURCE_EVIDENCE_CHARS = 320;

export type NormalizedLivePlaudInterpretation = {
  proposals: PlaudImportProposal[];
  omittedProposalCount: number;
};

type EvidenceToken = {
  end: number;
  normalized: string;
  start: number;
};

type ResolvedEvidence = {
  quote: string;
  segment: PlaudTranscriptSegment;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text && text.length <= maxLength ? text : null;
}

function normalizeEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceTokens(value: string): EvidenceToken[] {
  return Array.from(value.matchAll(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    normalized: match[0].normalize('NFKC').toLowerCase().replace(/\u2019/g, "'"),
  }));
}

function exactEvidenceQuote(segment: PlaudTranscriptSegment, quote: string): string | null {
  const sourceTokens = evidenceTokens(segment.content);
  const quoteTokens = evidenceTokens(quote);
  if (!quoteTokens.length || quoteTokens.length > sourceTokens.length) return null;

  for (let start = 0; start <= sourceTokens.length - quoteTokens.length; start += 1) {
    const matches = quoteTokens.every(
      (token, offset) => token.normalized === sourceTokens[start + offset].normalized,
    );
    if (!matches) continue;
    const endToken = sourceTokens[start + quoteTokens.length - 1];
    const sourceQuote = segment.content.slice(sourceTokens[start].start, endToken.end);
    return sourceQuote.length <= PLAUD_MAX_SOURCE_EVIDENCE_CHARS ? sourceQuote : null;
  }
  return null;
}

function resolveEvidence(
  segments: PlaudTranscriptSegment[],
  declaredIndex: number,
  quote: string,
): ResolvedEvidence | null {
  const declared = segmentByIndex(segments, declaredIndex);
  const declaredQuote = declared ? exactEvidenceQuote(declared, quote) : null;
  if (declared && declaredQuote) return { segment: declared, quote: declaredQuote };

  // A one-word quote is too weak to recover a model-supplied segment mismatch safely.
  if (evidenceTokens(quote).length < 2) return null;
  const matches = segments.flatMap((segment) => {
    const sourceQuote = exactEvidenceQuote(segment, quote);
    return sourceQuote ? [{ segment, quote: sourceQuote }] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

function statusForKind(kind: PlaudProposalKind): PlaudImportProposal['status'] {
  if (kind === 'product_idea') return 'captured';
  if (kind === 'observation') return 'noted';
  return 'pending';
}

function segmentByIndex(
  segments: PlaudTranscriptSegment[],
  index: number,
): PlaudTranscriptSegment | null {
  return segments.find((segment) => segment.index === index) ?? null;
}

export function serializeLivePlaudSegmentsForPrompt(source: PlaudTranscriptSource): string {
  return JSON.stringify(
    (source.segments ?? []).map((segment) => ({
      segment_id: segment.index,
      text: segment.content,
    })),
  );
}

export function normalizeLivePlaudInterpretation(
  source: PlaudTranscriptSource,
  value: unknown,
): NormalizedLivePlaudInterpretation {
  const root = object(value);
  if (!root || !Array.isArray(root.proposals) || root.proposals.length > PLAUD_MAX_PROPOSALS) {
    throw new Error('PLAUD interpretation returned an invalid proposal list.');
  }
  const segments = source.segments ?? [];
  if (!segments.length) throw new Error('PLAUD interpretation requires timestamped segments.');

  const proposals: PlaudImportProposal[] = [];
  const seen = new Set<string>();
  let omittedProposalCount = 0;
  for (const raw of root.proposals) {
    const item = object(raw);
    const kind = item?.kind;
    const title = cleanText(item?.title, 120);
    const detail = item?.detail === null || item?.detail === undefined
      ? undefined
      : cleanText(item.detail, 500);
    const evidenceSegment = item?.evidence_segment;
    const evidenceQuote = cleanText(item?.evidence_quote, 240);
    if (
      (kind !== 'task' && kind !== 'product_idea' && kind !== 'observation') ||
      !title ||
      (item?.detail !== null && item?.detail !== undefined && !detail) ||
      !Number.isInteger(evidenceSegment) ||
      !evidenceQuote
    ) {
      throw new Error('PLAUD interpretation returned a malformed proposal.');
    }

    const evidence = resolveEvidence(segments, evidenceSegment as number, evidenceQuote);
    if (!evidence) {
      omittedProposalCount += 1;
      continue;
    }
    const { quote, segment } = evidence;
    const anchor = `${kind}:${segment.startMs ?? segment.index}:${normalizeEvidence(quote)}`;
    const id = `${kind}-${hashPlaudTranscript(anchor)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    proposals.push({
      id,
      proposalKey: `plaud:${source.id}:${id}`,
      kind,
      title,
      ...(detail ? { detail } : {}),
      evidence: {
        segmentIndex: segment.index,
        quote,
        ...(segment.startMs === undefined ? {} : { startMs: segment.startMs }),
      },
      status: statusForKind(kind),
    });
  }

  if (!proposals.length) {
    throw new Error('No reviewable proposals were found in this transcript.');
  }
  return { proposals, omittedProposalCount };
}
