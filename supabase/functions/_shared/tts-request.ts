import { TTS_TOTAL_BUDGET_MS } from './tts-provider.ts';

/** Bound the entire speech request, including authentication and body reads.
 * The race also handles libraries that retry or swallow fetch aborts. Callers
 * must check the signal between gates so a late result cannot start synthesis.
 */
export async function runTtsRequest(
  receivedAt: number,
  work: (signal: AbortSignal) => Promise<Response>,
  expired: () => Response,
  budgetMs = TTS_TOTAL_BUDGET_MS,
): Promise<Response> {
  const remaining = budgetMs - (Date.now() - receivedAt);
  if (remaining <= 0) return expired();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Speech budget exhausted', 'TimeoutError'));
      resolve(expired());
    }, remaining);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } catch (error) {
    if (controller.signal.aborted) return expired();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Error bodies can time out after headers. Preserve the HTTP failure path
 * so its caller still closes metrics and returns the upstream error status.
 */
export async function readTtsErrorBody(response: Response): Promise<string> {
  return await response.text().then((text) => text.slice(0, 200)).catch(() => '');
}
