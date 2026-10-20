/** Fail-closed delivery gate shared by the weekly-email server scheduler. */
export function weeklyEmailConsentAllowsDelivery(stateData: any): boolean {
  return Boolean(
    stateData &&
    stateData.weeklyEmailEnabled === true &&
    stateData.weeklyEmailConsent === 'granted',
  );
}

/** Returns only a server-owned address after the persisted consent gate passes. */
export function resolveConsentedWeeklyEmailRecipient(opts: {
  stateData: any;
  profileEmail?: string | null;
  authEmail?: string | null;
}): string | null {
  if (!weeklyEmailConsentAllowsDelivery(opts.stateData)) return null;
  const email = opts.profileEmail?.trim() || opts.authEmail?.trim();
  return email || null;
}
