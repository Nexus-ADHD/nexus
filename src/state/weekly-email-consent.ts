export type WeeklyEmailConsent = 'unset' | 'granted' | 'denied';

export interface WeeklyEmailConsentState {
  consent: WeeklyEmailConsent;
  updatedAt: number | null;
}
export function normalizeWeeklyEmailConsent(value: unknown): WeeklyEmailConsent {
  return value === 'granted' || value === 'denied' ? value : 'unset';
}

function normalizedState(value: unknown, updatedAt: unknown): WeeklyEmailConsentState {
  const consent = normalizeWeeklyEmailConsent(value);
  return {
    consent,
    updatedAt: consent !== 'unset' && typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      ? updatedAt
      : null,
  };
}

/** Account-scoped last-write-wins merge. An explicit denial wins an exact tie. */
export function mergeWeeklyEmailConsent(
  localValue: unknown,
  localUpdatedAt: unknown,
  cloudValue: unknown,
  cloudUpdatedAt: unknown,
): WeeklyEmailConsentState {
  const local = normalizedState(localValue, localUpdatedAt);
  const cloud = normalizedState(cloudValue, cloudUpdatedAt);
  if (local.updatedAt == null) return cloud.updatedAt == null ? local : cloud;
  if (cloud.updatedAt == null) return local;
  if (cloud.updatedAt > local.updatedAt) return cloud;
  if (local.updatedAt > cloud.updatedAt) return local;
  if (local.consent === 'denied' || cloud.consent === 'denied') {
    return { consent: 'denied', updatedAt: local.updatedAt };
  }
  return local;
}
