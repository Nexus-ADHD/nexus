// NEX-26 phase F.5 — pure toggle-inbox-task helper.
//
// Extracted from the Zustand action in app-state.ts so the
// "completedAt stamps on false→true only and is never overwritten"
// invariant can be tested directly. The activation tracker depends
// on this field, so any drift in the toggle semantics would silently
// break the NEX-17 activation predicate.

interface TaskLike {
  id: string;
  completed: boolean;
  completedAt?: number;
}

/**
 * Apply a single toggle to an inbox-like array. Returns a new array.
 *
 * Rules:
 *   - false → true: stamp `completedAt = now` if the field is missing.
 *     Do NOT overwrite an existing completedAt — the first completion
 *     timestamp is canonical.
 *   - true → false: flip `completed` to false. Do NOT clear
 *     completedAt — re-toggling back to true must preserve the
 *     original timestamp.
 *   - id not found: array returned unchanged.
 */
export function applyToggleInbox<T extends TaskLike>(
  inbox: T[],
  id: string,
  now: number,
): T[] {
  if (!Array.isArray(inbox) || inbox.length === 0) return inbox;
  return inbox.map((t) => {
    if (t.id !== id) return t;
    const nextCompleted = !t.completed;
    const completedAt =
      nextCompleted && t.completedAt == null ? now : t.completedAt;
    return { ...t, completed: nextCompleted, completedAt };
  });
}
