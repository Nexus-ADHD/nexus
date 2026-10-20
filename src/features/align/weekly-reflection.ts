export function isNewWeeklyReflection(
  reflectionDate: string | null | undefined,
  lastSeenDate: string | null | undefined,
): boolean {
  const current = String(reflectionDate ?? '').trim();
  if (!current) return false;
  return current !== String(lastSeenDate ?? '').trim();
}
