export type MandateNavigationRouter = {
  push: (href: string) => void;
};

let mandateDetailPushInFlightFor: string | null = null;
// Fallback release timer. Belt-and-suspenders: if the destination
// screen never mounts / never fires focus (crash during render, route
// stack swallowed it, etc.), this auto-releases the guard so the user
// isn't locked out of mandate navigation for the rest of the session.
let mandateDetailReleaseTimer: ReturnType<typeof setTimeout> | null = null;

const FALLBACK_RELEASE_MS = 1500;

function clearFallbackTimer(): void {
  if (mandateDetailReleaseTimer) {
    clearTimeout(mandateDetailReleaseTimer);
    mandateDetailReleaseTimer = null;
  }
}

export function pushToMandateDetail(
  router: MandateNavigationRouter,
  pillarId: string | number | null | undefined,
): boolean {
  const id = String(pillarId ?? '').trim();
  if (!id || mandateDetailPushInFlightFor) return false;

  mandateDetailPushInFlightFor = id;
  // Schedule the fallback release BEFORE pushing so a router that
  // throws synchronously still has a tidy clear path below.
  clearFallbackTimer();
  mandateDetailReleaseTimer = setTimeout(() => {
    mandateDetailPushInFlightFor = null;
    mandateDetailReleaseTimer = null;
  }, FALLBACK_RELEASE_MS);

  try {
    router.push(`/mandate/${encodeURIComponent(id)}`);
    return true;
  } catch (error) {
    mandateDetailPushInFlightFor = null;
    clearFallbackTimer();
    throw error;
  }
}

export function releaseMandateDetailNavigationGuard(
  pillarId?: string | number | null,
): void {
  if (pillarId == null || mandateDetailPushInFlightFor === String(pillarId)) {
    mandateDetailPushInFlightFor = null;
    clearFallbackTimer();
  }
}

export function resetMandateDetailNavigationGuardForTest(): void {
  mandateDetailPushInFlightFor = null;
  clearFallbackTimer();
}
