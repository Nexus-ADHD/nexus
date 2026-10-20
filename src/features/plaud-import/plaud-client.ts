import { disconnectPlaud, getPlaudAccessToken } from './plaud-auth';
import {
  callPlaudToolWithToken,
  fetchPlaudTranscriptSource,
  PlaudMcpHttpError,
  PLAUD_RECORDING_PAGE_SIZE,
  projectPlaudRecordings,
  type PlaudRecording,
} from './plaud-mcp';
import type { PlaudTranscriptSource } from './types';

/**
 * `budgetMs` is a DEADLINE for the whole call including the 401 refresh, not a
 * per-request timeout. Callers that render a bounded loading state must pass
 * the time they actually have, or the retry loop inside plaud-mcp sizes itself
 * against a 45s default and the caller aborts mid-attempt, so no retry ever
 * runs. That is exactly what made the import screen feel hit or miss.
 *
 * The deadline is captured once and re-derived before the retry, so a slow
 * first call plus a token refresh cannot together exceed what the caller
 * allowed.
 */
async function callPlaudTool(
  ownerId: string,
  name: 'list_files' | 'get_transcript' | 'get_current_user',
  args: Record<string, unknown>,
  budgetMs?: number,
): Promise<string> {
  const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const remaining = () => (deadline === undefined ? undefined : deadline - Date.now());

  const token = await getPlaudAccessToken(ownerId);
  try {
    return await callPlaudToolWithToken(token, name, args, fetch, remaining());
  } catch (error) {
    if (!(error instanceof PlaudMcpHttpError) || error.status !== 401) throw error;
  }

  try {
    const refreshed = await getPlaudAccessToken(ownerId, true);
    return await callPlaudToolWithToken(refreshed, name, args, fetch, remaining());
  } catch (error) {
    if (error instanceof PlaudMcpHttpError && error.status === 401) {
      await disconnectPlaud(ownerId);
    }
    throw error;
  }
}

export async function listPlaudRecordings(
  ownerId: string,
  budgetMs?: number,
): Promise<PlaudRecording[]> {
  const text = await callPlaudTool(
    ownerId,
    'list_files',
    { page: 1, page_size: PLAUD_RECORDING_PAGE_SIZE },
    budgetMs,
  );
  return projectPlaudRecordings(text);
}

export function getPlaudTranscript(
  ownerId: string,
  recording: PlaudRecording,
): Promise<PlaudTranscriptSource> {
  return fetchPlaudTranscriptSource(
    recording,
    (name, args) => callPlaudTool(ownerId, name, args),
  );
}
